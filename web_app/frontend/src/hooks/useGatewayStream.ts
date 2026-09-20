import { useEffect } from 'react';
import { EventsOn } from '../../wailsjs/runtime/runtime';
import { useGatewayStore } from '../store/useGatewayStore';
import { useAppStore } from '../store/useAppStore';
import {
  formatGatewayLogEvent,
  gatewayAgentStatus,
  type GatewayLogEvent,
  type GatewayStatusEvent,
  type GatewayBackfillEvent,
  type GatewayBackfillDoneEvent,
} from '../api/gateway';

// Bridges the gateway_server SSE stream (forwarded by the Go layer as Wails
// events) into the gateway store. Mount once near the app root.
//
// Each gateway "log" event carries a `message` field with one line of the raw
// agent log. We feed the raw line into the store's rawBuffer (for the agent
// log parser → copilot/lineage views) and also push a formatted display line
// into `lines` (for the plain logs panel).
//
// On session switch the gateway replays cached history via "backfill" /
// "backfill-done" events before resuming live tailing.
export function useGatewayStream() {
  useEffect(() => {
    const offLog = EventsOn('gateway-log', (e: GatewayLogEvent) => {
      const store = useGatewayStore.getState();
      const rawLine = e.message || '';
      store.appendLine(formatGatewayLogEvent(e), rawLine);
    });

    const offBackfill = EventsOn('gateway-backfill', (e: GatewayBackfillEvent) => {
      useGatewayStore.getState().appendBackfill(e.source, e.path, e.content || '', e.truncated);
    });

    const offBackfillDone = EventsOn('gateway-backfill-done', (e: GatewayBackfillDoneEvent) => {
      useGatewayStore.getState().finishBackfill(e.count || 0);
    });

    const offStatus = EventsOn('gateway-status', (e: GatewayStatusEvent) => {
      useGatewayStore.getState().setStatus(e.status, e.error);
    });

    const statusTimer = window.setInterval(async () => {
      const { token, sessionId } = useGatewayStore.getState();
      if (!token || !sessionId) return;
      try {
        const status = await gatewayAgentStatus(token, sessionId);
        const app = useAppStore.getState();
        const taskStatus = status.task?.status || status.status;
        if (taskStatus === 'running' || taskStatus === 'queued') {
          app.setChatBusy(true);
          app.setChatRunState('running');
        } else if (taskStatus === 'killed' || taskStatus === 'cancelled') {
          app.setChatBusy(false);
          app.setChatRunState('cancelled');
        } else if (taskStatus === 'done' || taskStatus === 'completed') {
          app.setChatBusy(false);
          app.setChatRunState('completed');
        } else if (taskStatus === 'failed' || taskStatus === 'error' || taskStatus === 'idle') {
          app.setChatBusy(false);
          app.setChatRunState(taskStatus === 'idle' ? 'idle' : 'failed');
        }
      } catch {
        // The SSE stream remains the primary live status channel.
      }
    }, 1500);

    return () => {
      offLog();
      offBackfill();
      offBackfillDone();
      offStatus();
      window.clearInterval(statusTimer);
    };
  }, []);
}