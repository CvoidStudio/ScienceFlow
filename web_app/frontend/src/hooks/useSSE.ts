import { useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import * as api from '../api/client';
import { EventsOn } from '../../wailsjs/runtime/runtime';
import { debug } from '../utils/debug';
import type {
  ToolSSEEvent,
  AssistantDeltaSSEEvent,
  StateUpdateSSEEvent,
} from '../types';

// The chat SSE stream is bridged through the Go backend. The Go layer owns the
// EventSource connection to the backend and re-emits each named SSE event as a
// Wails "chat-event" with shape { name, data }.
interface ChatEventPayload {
  name: string;
  data: string;
}

function handleEvent(name: string, data: string) {
  const store = useAppStore.getState();
  switch (name) {
    case 'run_started':
      debug.log('SSE', 'run_started received');
      store.setChatBusy(true);
      store.setChatRunState('running');
      useAppStore.setState({ toolEvents: [] });
      store.clearTimeline();
      store.fetchWorkspaceFiles();
      break;

    case 'run_finished':
      debug.log('SSE', 'run_finished received');
      store.setChatBusy(false);
      store.setChatRunState('completed');
      store.refreshState({ force: true });
      store.fetchWorkspaceFiles();
      store.fetchReports();
      break;

    case 'tool_started':
      try {
        const d = JSON.parse(data) as ToolSSEEvent;
        const { toolEvents } = store;
        useAppStore.setState({
          toolEvents: [
            ...toolEvents,
            {
              event_id: d.event_id,
              type: d.type,
              status: d.status,
              name: d.name,
              message: d.message,
              summary: d.summary || '',
              error: d.error || '',
              path: d.path || '',
              title: d.title,
              created_at: new Date().toISOString(),
              steps: d.steps || [],
            },
          ],
        });
        store.randomizeAgentPosition();
      } catch {
        /* ignore */
      }
      break;

    case 'tool_finished':
      try {
        const d = JSON.parse(data) as ToolSSEEvent;
        const { toolEvents } = store;
        useAppStore.setState({
          toolEvents: toolEvents.map((t) =>
            t.event_id === d.event_id
              ? {
                  ...t,
                  status: d.status,
                  message: d.message,
                  summary: d.summary || '',
                  error: d.error || '',
                  steps: d.steps || t.steps,
                }
              : t
          ),
        });
      } catch {
        /* ignore */
      }
      break;

    case 'assistant_delta':
      try {
        const d = JSON.parse(data) as AssistantDeltaSSEEvent;
        const msgId = d.message_id;
        if (!store.activeMessageId) store.setActiveMessageId(msgId);

        const existing = store.streamingAssistantMessages.get(msgId) || '';
        const newContent = existing + d.content;
        store.setStreamingAssistantContent(msgId, newContent);

        const hasMsg = store.chatMessages.some((m) => m.message_id === msgId);
        if (!hasMsg) {
          store.addChatMessage({
            message_id: msgId,
            role: 'assistant',
            content: newContent,
            created_at: new Date().toISOString(),
          });
        } else {
          store.updateAssistantMessage(msgId, newContent);
        }
      } catch (e) {
        debug.warn('SSE', 'assistant_delta handler error:', e);
      }
      break;

    case 'state_update':
      try {
        const d = JSON.parse(data) as StateUpdateSSEEvent;
        store.applyStateUpdatePatch(d.data);
      } catch {
        /* ignore */
      }
      break;

    case 'file_create':
      store.fetchWorkspaceFiles();
      break;

    case 'report_save':
      store.fetchReports();
      store.refreshState({ force: true });
      break;

    case 'session_busy':
      store.setChatBusy(true);
      break;

    case 'log_entry':
      try {
        const d = JSON.parse(data);
        if (d.line) store.appendLogEntry(d.line);
      } catch {
        /* ignore */
      }
      break;

    case 'assistant_message':
    case 'run_state':
    case 'session_created':
    default:
      break;
  }
}

export function useSSE() {
  const chatSessionId = useAppStore((s) => s.chatSessionId);

  // Subscribe to forwarded SSE events once, for the component lifetime.
  useEffect(() => {
    const off = EventsOn('chat-event', (e: ChatEventPayload) => {
      handleEvent(e.name, e.data);
    });
    return () => {
      off();
    };
  }, []);

  // Start/stop the Go-side SSE stream per chat session.
  useEffect(() => {
    if (!chatSessionId) return;
    api.startChatStream(chatSessionId);
    useAppStore.getState().clearLogEntries();
    return () => {
      api.stopChatStream();
    };
  }, [chatSessionId]);
}