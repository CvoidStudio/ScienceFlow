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
import { parseHistoricalChatMessages } from '../utils/agentLogParser';

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
    const isCurrentSessionEvent = (eventSessionId?: string) => {
      const currentSessionId = useGatewayStore.getState().sessionId;
      return !eventSessionId || !currentSessionId || eventSessionId === currentSessionId;
    };

    // Rebuild the chat message list from the gateway log (user queries +
    // assistant answers, in log order) merged with optimistic local messages
    // (just-typed input, task/error notices) that are not in the log yet.
    let lastChatSyncAt = 0;
    const syncChatMessages = (force = false) => {
      const now = Date.now();
      if (!force && now - lastChatSyncAt < 400) return;
      lastChatSyncAt = now;
      const gw = useGatewayStore.getState();
      // runStarts anchors each parsed user message to its run's first workflow
      // segment, so reasoning blocks follow their answers even after a
      // refresh/backfill rebuilds the whole list.
      const parsed = parseHistoricalChatMessages(gw.rawBuffer, gw.parsedLog.runStarts || []);
      // 停止任务/重订阅会触发多 source 重放，同一日志头可能经不同批次进入
      // buffer 多次：相同角色+内容+头部时间戳的解析消息是重放残影，只留一条。
      const seenRounds = new Set<string>();
      const deduped = parsed.filter((p) => {
        const key = `${p.role}|${p.content}|${p.created_at}`;
        if (seenRounds.has(key)) return false;
        seenRounds.add(key);
        return true;
      });
      parsed.length = 0;
      parsed.push(...deduped);
      // The backend embeds the route mode into the logged query
      // ("[mode=lite] ..."); strip it so history matches what the user typed.
      const stripMode = (s: string) => s.replace(/^\[mode=\S+\]\s*/, '');
      for (const m of parsed) {
        if (m.role === 'user') m.content = stripMode(m.content);
      }
      const ts = (v?: string) => {
        if (!v) return 0;
        const t = Date.parse(v);
        return Number.isNaN(t) ? 0 : t;
      };
      // 乐观消息与日志解析消息的配对窗口：同一轮的日志头时间与本地发送时间
      // 相差通常 <1s；历史旧轮的头部时间则远早于本次发送。内容相同但时间
      // 不在窗口内的消息（连发两条“你好”）绝不互相吞并。
      const PAIR_WINDOW_MS = 5000;
      const storeChat = useAppStore.getState().chatMessages;
      // Carry the workflow anchor (segment count at send time) and the true
      // local send timestamp from optimistic user messages onto their
      // parsed-history counterparts, but ONLY for the round whose log-header
      // time is close to the local send time — otherwise a repeat send of the
      // same text would hand its anchor to an identical earlier question.
      const pendingMeta = new Map<string, { wfStart?: number; createdAt?: string }[]>();
      for (const m of storeChat) {
        if (m.role === 'user' && !m.message_id.startsWith('history-')) {
          const list = pendingMeta.get(m.content) || [];
          list.push({ wfStart: m.userWfStart, createdAt: m.created_at });
          pendingMeta.set(m.content, list);
        }
      }
      for (const m of parsed) {
        if (m.role !== 'user') continue;
        const list = pendingMeta.get(m.content);
        if (!list || list.length === 0) continue;
        const headTs = ts(m.created_at);
        let bestIdx = -1;
        let bestDiff = Infinity;
        for (let i = 0; i < list.length; i++) {
          const diff = Math.abs((list[i].createdAt ? ts(list[i].createdAt) : 0) - headTs);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestIdx = i;
          }
        }
        if (bestIdx >= 0 && bestDiff <= PAIR_WINDOW_MS) {
          const meta = list.splice(bestIdx, 1)[0];
          if (meta.wfStart != null) (m as { userWfStart?: number }).userWfStart = meta.wfStart;
          if (meta.createdAt) m.created_at = meta.createdAt;
        }
      }
      // Dedupe optimistic user bubbles against parsed ones BY LOG POSITION:
      // an optimistic send carries userWfStart (segment count at send time);
      // a parsed round carries its task-header segment index. The parsed round
      // is the echo of THIS send iff it was produced at/after that position —
      // regardless of elapsed time (a queued task's log header can arrive
      // minutes later). Timestamp window is only a fallback when either anchor
      // is missing. Repeat sends of identical text pair up in order.
      const consumed = new Set<unknown>();
      const optimistic = storeChat.filter((m) => {
        if (m.message_id.startsWith('history-')) return false;
        if (m.role === 'platform' && m.message_id.startsWith('task-')) {
          // 乐观 "Task started: task-X" 与日志重建的解析版本按 task id 配对，
          // id 转移保持 React key 稳定（不闪烁）；此后由解析版本持续存在。
          const tid = m.message_id.slice(5);
          const match = parsed.find(
            (p) => p.role === 'platform' && p.message_id.startsWith(`history-task-${tid}-`),
          );
          if (match) {
            match.message_id = m.message_id;
            return false;
          }
        }
        if (m.role === 'user') {
          const sendPos = (m as { userWfStart?: number }).userWfStart;
          const match = parsed.find((p) => {
            if (p.role !== 'user' || p.content !== m.content || consumed.has(p)) return false;
            const headPos = (p as { userWfStart?: number }).userWfStart;
            if (sendPos != null && headPos != null) return headPos >= sendPos;
            return Math.abs(ts(p.created_at) - ts(m.created_at)) <= PAIR_WINDOW_MS;
          });
          if (match) {
            consumed.add(match);
            // 让解析版本继承乐观气泡的 message_id：React key 不变则 DOM 复用，
            // 提问气泡不会在日志头到达时重挂闪烁。下一轮 sync 全量重建的解析
            // 副本会与本条（id 已是乐观 id）再次配对、再次继承同一 id，映射
            // 在每个同步周期自我延续，key 始终稳定。
            match.message_id = m.message_id;
            return false;
          }
        }
        return true;
      });
      // Sort by parsed epoch time, not string compare: created_at mixes UTC
      // RFC3339Nano (log headers), local ISO (optimistic sends) and marker
      // timestamps, and lexicographic order across those formats is unstable
      // (a transiently mis-sorted "Task started" used to jump above the
      // previous round's stop marker). NaN → 0 keeps unparsable entries first;
      // Array.sort is stable so equal timestamps keep parse order.
      const merged = [...parsed, ...optimistic].sort((a, b) => ts(a.created_at) - ts(b.created_at));
      useAppStore.getState().setChatMessages(merged);
    };

    const offLog = EventsOn('gateway-log', (e: GatewayLogEvent) => {
      if (!isCurrentSessionEvent(e.session_id)) return;
      const store = useGatewayStore.getState();
      const rawLine = e.message || '';
      store.appendLine(formatGatewayLogEvent(e), rawLine);
      syncChatMessages();
    });

    const offBackfill = EventsOn('gateway-backfill', (e: GatewayBackfillEvent) => {
      if (!isCurrentSessionEvent(e.session_id)) return;
      useGatewayStore.getState().appendBackfill(e.source, e.path, e.content || '', e.truncated);
    });

    const offBackfillDone = EventsOn('gateway-backfill-done', (e: GatewayBackfillDoneEvent) => {
      if (!isCurrentSessionEvent(e.session_id)) return;
      const gatewayStore = useGatewayStore.getState();
      gatewayStore.finishBackfill(e.count || 0);
      syncChatMessages(true);
    });

    const offStatus = EventsOn('gateway-status', (e: GatewayStatusEvent) => {
      useGatewayStore.getState().setStatus(e.status, e.error);
    });

    const statusTimer = window.setInterval(async () => {
      const { token, sessionId } = useGatewayStore.getState();
      if (!token || !sessionId) return;
      // While a stop request is in flight, don't let the poll overwrite the
      // "cancelling" state (the backend may still report "running" briefly).
      if (useAppStore.getState().chatRunState === 'cancelling') return;
      try {
        const status = await gatewayAgentStatus(token, sessionId);
        const app = useAppStore.getState();
        const taskStatus = status.task?.status || status.status;
        if (taskStatus === 'running' || taskStatus === 'queued') {
          app.setChatBusy(true);
          app.setChatRunState('running');
        } else if (taskStatus === 'done' || taskStatus === 'completed') {
          app.setChatBusy(false);
          app.setChatRunState('completed');
          syncChatMessages(true);
        } else if (taskStatus === 'failed' || taskStatus === 'error' || taskStatus === 'idle') {
          app.setChatBusy(false);
          app.setChatRunState(taskStatus === 'idle' ? 'idle' : 'failed');
          syncChatMessages(true);
        } else if (taskStatus === 'killed' || taskStatus === 'cancelled') {
          app.setChatBusy(false);
          app.setChatRunState('cancelled');
          syncChatMessages(true);
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