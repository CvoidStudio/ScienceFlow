import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Upload, Tooltip, Dropdown } from 'antd';
import type { UploadProps } from 'antd';
import { useAppStore } from '../store/useAppStore';
import { useGatewayStore } from '../store/useGatewayStore';
import { gatewayInvokeAgent, gatewayStopAgent, workspaceUploadFiles } from '../api/gateway';
import { useT } from '../i18n/useT';
import * as api from '../api/client';
import { debug } from '../utils/debug';
import { getHeader, formatToolArgPreview, type ParsedSegment } from '../utils/agentLogParser';
import clsx from 'clsx';
import { Upload as UploadIcon, FolderUp, Mic, ArrowUp, Square, Terminal, FileText, Pencil, FileEdit, Search, FolderOpen, List, Code, Wrench, ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ChatMessage, ChatToolStep } from '../types';

const TOOL_ICONS: Record<string, LucideIcon> = {
  bash: Terminal,
  read: FileText,
  write: Pencil,
  edit: FileEdit,
  grep: Search,
  glob: FolderOpen,
  ls: List,
  python: Code,
  python3: Code,
};

const TOOL_COLORS: Record<string, string> = {
  bash: '#62d884',
  read: '#5cc8ff',
  write: '#f2c86b',
  edit: '#ff9f6e',
  grep: '#e99cff',
  glob: '#5cc8ff',
  ls: '#aab7c6',
  python: '#62d884',
  python3: '#62d884',
};

export function ChatRail() {
  const {
    chatMessages, chatSessionId, sessionsPanelOpen,
    setSessionsPanelOpen, addChatMessage, setChatBusy,
    setChatRunState, chatBusy, chatRunState, chatRouteMode,
    setChatRouteMode, chatSendInFlight,
    currentState,
    toolEvents, streamingAssistantMessages,
    activeMessageId, clearTimeline,
  } = useAppStore();
  const { sessionList, fetchSessionList, switchSession, sessionId: gwSessionId } = useGatewayStore();
  const t = useT();

  const [input, setInput] = useState('');
  const [datasetStatus, setDatasetStatus] = useState('');
  const [datasetUploadProgress, setDatasetUploadProgress] = useState(false);
  const [datasetUploadLabel, setDatasetUploadLabel] = useState(t.chatRail.preparingUpload);
  const [datasetUploadSpeed, setDatasetUploadSpeed] = useState('--/s');
  const [datasetUploadPercent, setDatasetUploadPercent] = useState('0%');
  const [datasetUploadBarWidth, setDatasetUploadBarWidth] = useState(0);
  const [taskMode, setTaskMode] = useState<'lite' | 'heavy'>('lite');
  const [taskSetupOpen, setTaskSetupOpen] = useState(false);
  const [voiceState, setVoiceState] = useState<'idle' | 'starting' | 'listening' | 'error' | 'unsupported'>('idle');
  const [switchBusy, setSwitchBusy] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const taskId = currentState?.task?.task_id || '';
  const datasetName = currentState?.task?.dataset_name || '';

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, toolEvents, streamingAssistantMessages]);

  useEffect(() => {
    if (datasetName) setDatasetStatus(datasetName);
    else setDatasetStatus(t.chatRail.noDataset);
  }, [datasetName]);

  // Load gateway session list when the panel opens.
  useEffect(() => {
    if (sessionsPanelOpen) fetchSessionList();
  }, [sessionsPanelOpen, fetchSessionList]);

  const handleSend = async () => {
    const text = input.trim();
    debug.log("ChatRail", "handleSend text=", text.slice(0, 60), "chatSessionId=", chatSessionId, "chatBusy=", chatBusy, "chatSendInFlight=", chatSendInFlight);
    if (!text || chatBusy || chatSendInFlight) {
      debug.log("ChatRail", "handleSend blocked: !text=", !text, "chatBusy=", chatBusy, "chatSendInFlight=", chatSendInFlight);
      return;
    }
    // chatSessionId is the gateway session id (set after gateway connect).
    if (!chatSessionId) {
      debug.log("ChatRail", "no gateway session, cannot invoke agent");
      return;
    }
    setInput('');

    const idempotencyKey = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    useAppStore.getState().setActiveMessageId(idempotencyKey);

    const userMsg: ChatMessage = {
      message_id: idempotencyKey,
      role: 'user',
      content: text,
      created_at: new Date().toISOString(),
      route: chatRouteMode,
    };
    addChatMessage(userMsg);

    useAppStore.setState({ chatSendInFlight: true, chatBusy: true, chatRunState: 'running' });
    try {
      debug.log("ChatRail", "invoking agent on gateway session", chatSessionId, "mode=", taskMode);
      const { token } = useGatewayStore.getState();
      const task = await gatewayInvokeAgent(token, chatSessionId, text, taskMode);
      debug.log("ChatRail", "invoke response:", task);
      addChatMessage({
        message_id: `task-${task.id}`,
        role: 'platform',
        content: `Task started: ${task.id} (status: ${task.status})`,
        created_at: new Date().toISOString(),
      });
    } catch (e: unknown) {
      debug.error("ChatRail", "invoke failed:", e);
      addChatMessage({
        message_id: `err-${Date.now()}`,
        role: 'platform',
        content: `Failed: ${(e as Error).message || t.chatRail.unknownError}`,
        created_at: new Date().toISOString(),
      });
      setChatBusy(false);
      setChatRunState('idle');
    } finally {
      useAppStore.setState({ chatSendInFlight: false });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleCancel = async () => {
    const { token, sessionId: gatewaySessionId } = useGatewayStore.getState();
    const sessionId = gatewaySessionId || chatSessionId;
    debug.log('ChatRail', 'handleCancel clicked', { sessionId, hasToken: !!token, chatBusy, chatRunState });
    if (!token || !sessionId) {
      debug.warn('ChatRail', 'cannot stop agent: missing gateway token or session id');
      return;
    }

    setChatRunState('cancelling');
    try {
      const task = await gatewayStopAgent(token, sessionId);
      debug.log('ChatRail', 'stop response:', task);
      setChatBusy(false);
      setChatRunState(task.status === 'done' ? 'completed' : 'cancelled');
      await fetchSessionList();
    } catch (e: unknown) {
      debug.error('ChatRail', 'stop agent failed:', e);
      setChatBusy(true);
      setChatRunState('running');
    }
  };

  const handleRefreshSessions = async () => {
    if (switchBusy) return;
    setSwitchBusy(true);
    try {
      await fetchSessionList();
    } finally {
      setSwitchBusy(false);
    }
  };

  const handleSwitchSession = async (sessionId: string) => {
    if (switchBusy || sessionId === gwSessionId) return;
    setSwitchBusy(true);
    try {
      const session = await switchSession(sessionId);
      if (session) {
        useAppStore.getState().setChatSessionId(sessionId);
        useAppStore.getState().clearTimeline();
        setSessionsPanelOpen(false);
      }
    } finally {
      setSwitchBusy(false);
    }
  };

  const handleTaskModeSelect = (mode: 'lite' | 'heavy') => {
    setTaskMode(mode);
  };

  const handleUploadRequest: UploadProps['customRequest'] = async (options) => {
    const { file, onSuccess, onError } = options;
    const { token, sessionId } = useGatewayStore.getState();
    if (!token || !sessionId) {
      onError?.(new Error('No gateway session'));
      return;
    }
    setDatasetUploadProgress(true);
    setDatasetUploadLabel(t.chatRail.uploading);
    try {
      const result = await workspaceUploadFiles(token, sessionId, '', [file as File]);
      setDatasetStatus(`${result.uploaded?.length || 1} file(s) uploaded`);
      setDatasetUploadLabel(t.chatRail.complete);
      setDatasetUploadPercent('100%');
      setDatasetUploadBarWidth(100);
      onSuccess?.(result);
    } catch (e: unknown) {
      setDatasetUploadLabel(`Error: ${(e as Error).message}`);
      onError?.(e as Error);
    } finally {
      setTimeout(() => setDatasetUploadProgress(false), 2000);
    }
  };

  const handleFolderChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const { token, sessionId } = useGatewayStore.getState();
    if (!token || !sessionId) return;
    setDatasetUploadProgress(true);
    setDatasetUploadLabel(t.chatRail.uploadingFolder);
    try {
      const result = await workspaceUploadFiles(token, sessionId, '', files);
      setDatasetStatus(`${result.uploaded?.length || files.length} file(s) uploaded`);
      setDatasetUploadLabel(t.chatRail.complete);
      setDatasetUploadPercent('100%');
      setDatasetUploadBarWidth(100);
    } catch (e: unknown) {
      setDatasetUploadLabel(`Error: ${(e as Error).message}`);
    } finally {
      setTimeout(() => setDatasetUploadProgress(false), 2000);
    }
  };

  const handleVoiceToggle = () => {
    setVoiceState((s) => s === 'idle' ? 'starting' : 'idle');
    if (voiceState === 'idle') setTimeout(() => setVoiceState('listening'), 500);
  };

  const isCancelling = chatRunState === 'cancelling';
  const isAgentActive = chatBusy || chatRunState === 'running' || isCancelling;
  const actionState = isAgentActive ? 'stop' : 'send';

  return (
    <aside className="card chat-rail">
      <div className="card-head">
        <span className="card-title">{t.chatRail.cockpit}</span>
        <div className="chat-head-actions">
          <span className={clsx('chat-status-badge', chatBusy && 'busy')}>
            <span className={clsx('state-dot', chatBusy ? 'pulse' : 'idle')} />
            {chatRunState === 'running' ? t.chatRail.running : chatRunState === 'cancelling' ? '停止中' : chatRunState === 'cancelled' ? '已停止' : chatRunState === 'completed' ? t.chatRail.done : t.common.idle}
          </span>
          <button className="btn" id="frontToggleSessions" onClick={() => setSessionsPanelOpen(!sessionsPanelOpen)}>
            {t.chatRail.sessions}
          </button>
        </div>
      </div>
      <div className="card-body">
        <div className={clsx('session-history-panel', sessionsPanelOpen && 'active')} id="frontSessionPanel">
          <div className="session-history-head">
            <span>{t.chatRail.chatSessions}</span>
            <div className="session-actions">
              <button className="btn" onClick={handleRefreshSessions}>{t.chatRail.refresh}</button>
            </div>
          </div>
          <div className="session-list" id="frontSessionList">
            {sessionList.length === 0 && (
              <div className="dim" style={{ padding: '10px 8px', fontSize: 11 }}>No sessions</div>
            )}
            {sessionList.map((s) => {
              const active = s.session_id === gwSessionId;
              const agentStatus = s.agent?.status || 'idle';
              const isRunning = agentStatus === 'active';
              return (
                <button
                  key={s.session_id}
                  disabled={switchBusy}
                  className={clsx('session-card', active && 'active')}
                  onClick={() => handleSwitchSession(s.session_id)}
                >
                  <div className="session-card-head">
                    <span className="session-card-id" style={{ fontFamily: 'var(--mono)', fontSize: 11, color: active ? 'var(--accent)' : 'var(--muted)' }}>
                      {s.session_id.slice(0, 20)}...
                    </span>
                    <span className={clsx('session-agent-badge', isRunning && 'running')}>
                      {isRunning ? '● running' : 'idle'}
                    </span>
                  </div>
                  <div className="session-card-meta" style={{ fontSize: 11, color: 'var(--soft)', marginTop: 3 }}>
                    {s.sources?.length ?? 0} sources
                    {s.last_active && (
                      <span className="dim" style={{ marginLeft: 8 }}>
                        {formatLastActive(s.last_active)}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="agent-cockpit" data-agent-cockpit>
          <section className="agent-cockpit-panel agent-cockpit-transcript" data-agent-transcript>
            <div className="messages rail-messages" id="frontMessages">
              {/* User & platform messages */}
              {chatMessages.map((msg) => (
                <ChatMessageItem key={msg.message_id} message={msg} />
              ))}

              {/* Agent workflow blocks from parsed gateway log */}
              <AgentWorkflowBlocks />

              {chatBusy && chatMessages.length === 0 && (
                <div className="agent-thinking">
                  <div className="typing-dots"><i /><i /><i /></div>
                  <span style={{ color: 'var(--muted)', fontSize: 13, fontFamily: 'var(--mono)' }}>Agent is thinking...</span>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </section>

          <section className={clsx('agent-cockpit-send', 'is-expanded', taskMode === 'heavy' && 'mode-heavy', chatBusy && 'agent-running')} data-agent-cockpit-send>
            <button className="agent-cockpit-send-toggle" type="button">
              <strong>{t.chatRail.send}</strong>
              <span>{chatSessionId ? chatSessionId.slice(0, 12) + '...' : t.chatRail.collapsed}</span>
            </button>
            <div className={clsx('front-composer', taskMode === 'heavy' && 'mode-heavy')}>
              <div className="composer-input-wrap">
                <textarea id="frontChatInput" enterKeyHint="send" placeholder={t.chatRail.inputPlaceholder}
                  value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown} disabled={chatBusy} />
              </div>
              <div className="composer-tools">
                <div className={clsx('task-setup-popover', (taskSetupOpen || datasetUploadProgress) && 'active')} hidden={!(taskSetupOpen || datasetUploadProgress)}>
                  <div className="task-setup-head">
                    <strong>{t.chatRail.taskSetup}</strong>
                    <span>{taskId ? t.chatRail.ready : t.chatRail.noTask}</span>
                    <button className="task-setup-close" type="button" onClick={() => setTaskSetupOpen(false)}>&times;</button>
                  </div>
                  <div className="task-setup-empty" hidden={!!taskId}>{t.chatRail.createTaskFirst}</div>
                  <div className="task-setup-controls" hidden={!taskId}>
                    <div className="dataset-upload-progress" hidden={!datasetUploadProgress}>
                      <div className="dataset-upload-progress-head"><span>{datasetUploadLabel}</span><span className="dataset-upload-progress-stats"><span>{datasetUploadSpeed}</span><span>{datasetUploadPercent}</span></span></div>
                      <div className="dataset-upload-progress-track"><i style={{ width: `${datasetUploadBarWidth}%` }}></i></div>
                    </div>
                    <div className="dataset-status-row">
                      <div className="dataset-status">{datasetStatus}</div>
                    </div>
                  </div>
                </div>

                <Dropdown
                  trigger={['click']}
                  menu={{
                    items: [
                      {
                        key: 'file',
                        label: (
                          <Upload customRequest={handleUploadRequest} showUploadList={false} multiple>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <UploadIcon size={14} />
                              {t.chatRail.uploadFile}
                            </span>
                          </Upload>
                        ),
                      },
                      {
                        key: 'folder',
                        icon: (
                          <FolderUp size={14} />
                        ),
                        label: t.chatRail.uploadFolder,
                        onClick: () => folderInputRef.current?.click(),
                      },
                    ],
                  }}
                >
                  <button className="composer-add" type="button">+</button>
                </Dropdown>
                <input ref={folderInputRef} type="file" {...({ webkitdirectory: '' } as React.InputHTMLAttributes<HTMLInputElement>)} multiple hidden onChange={handleFolderChange} />

                <Tooltip title={taskMode === 'lite' ? 'Lite mode — click for Heavy' : 'Heavy mode — click for Lite'}>
                  <button
                    className={clsx('mode-toggle', taskMode === 'heavy' && 'heavy')}
                    type="button"
                    onClick={() => handleTaskModeSelect(taskMode === 'lite' ? 'heavy' : 'lite')}
                  >
                    <span className="mode-toggle-track">
                      <span className="mode-toggle-thumb" />
                    </span>
                    <span className="mode-toggle-label">{taskMode}</span>
                  </button>
                </Tooltip>

                <div className="composer-actions">
                  {false && (
                    <button className={clsx('btn chat-action-button chat-voice-button', voiceState !== 'idle' && `is-${voiceState}`)} onClick={handleVoiceToggle}>
                      <span className="chat-action-icon voice">
                        <Mic size={18} />
                      </span>
                    </button>
                  )}
                  <button
                    className={clsx('btn primary chat-action-button', actionState === 'stop' && 'danger')}
                    data-action-state={actionState === 'stop' ? 'stop' : 'send'}
                    onClick={actionState === 'stop' ? handleCancel : handleSend}
                    disabled={isCancelling || (actionState === 'send' && (!input.trim() || chatSendInFlight))}>
                    {actionState === 'send' ? (
                      <span className="chat-action-icon send"><ArrowUp size={18} strokeWidth={2.5} /></span>
                    ) : (
                      <span className="chat-action-icon stop"><Square size={16} fill="currentColor" /></span>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </aside>
  );
}

function formatLastActive(rfc3339: string): string {
  try {
    const d = new Date(rfc3339);
    const now = Date.now();
    const diff = now - d.getTime();
    const sec = Math.floor(diff / 1000);
    if (sec < 0) return 'just now';
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    return `${day}d ago`;
  } catch {
    return '';
  }
}

function AgentWorkflowBlocks() {
  const { parsedLog, status, user, lines } = useGatewayStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  const headers = parsedLog.headers;
  const task = getHeader(headers, 'Task');
  const query = getHeader(headers, 'Query');
  const finalStatus = getHeader(headers, 'Final Status');
  const taskId = getHeader(headers, 'Task ID');

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [parsedLog]);

  const hasContent = parsedLog.segments.length > 0 || lines.length > 0;

  if (!hasContent) {
    return (
      <div className="dim" style={{ display: 'grid', placeItems: 'center', textAlign: 'center', padding: '20px 0' }}>
        <div>
          <p style={{ margin: 0, fontSize: 13 }}>Agent Copilot</p>
          <p style={{ margin: '6px 0 0', fontSize: 11 }}>
            {status === 'idle' ? '连接日志网关后，智能体工作流将在此实时呈现。' : '等待智能体输出…'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-workflow-blocks" ref={scrollRef}>
      {/* Header summary strip */}
      {(task || query) && (
        <div className="agent-wf-header-strip">
          <div className="agent-wf-header-pills">
            {task && <span className="pill cyan" style={{ fontSize: 10 }}>{task}</span>}
            {finalStatus && (
              <span className={clsx('pill', finalStatus === 'completed' ? 'green' : finalStatus === 'killed' ? 'red' : 'yellow')} style={{ fontSize: 10 }}>
                {finalStatus}
              </span>
            )}
            {user && <span className="dim" style={{ fontSize: 10, fontFamily: 'var(--mono)' }}>@{user}</span>}
            {taskId && <span className="dim" style={{ fontSize: 9, fontFamily: 'var(--mono)' }}>id {taskId.slice(-12)}</span>}
          </div>
          {query && (
            <p className="agent-wf-query">{query}</p>
          )}
        </div>
      )}

      {parsedLog.segments.map((seg, i) => (
        <CollapsibleBlock key={i} segment={seg} />
      ))}

      {/* Final summary */}
      {parsedLog.summary && (
        <div className="agent-wf-summary">
          <div className="chat-markdown" style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.5 }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{parsedLog.summary}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

function CollapsibleBlock({ segment }: { segment: ParsedSegment }) {
  const [collapsed, setCollapsed] = useState(false);

  if (segment.type === 'header') return null;

  if (segment.type === 'tool_call' && segment.toolCall) {
    const tc = segment.toolCall;
    const IconComp = TOOL_ICONS[tc.tool] || Wrench;
    const color = TOOL_COLORS[tc.tool] || '#aab7c6';
    return (
      <div className={clsx('agent-block agent-block-tool', collapsed && 'collapsed')} style={{ borderLeftColor: color }}>
        <button className="agent-block-head" type="button" onClick={() => setCollapsed(!collapsed)}>
          <ChevronRight size={12} className={clsx('agent-block-chevron', !collapsed && 'expanded')} />
          <IconComp size={13} color={color} />
          <span className="agent-block-title" style={{ color }}>{tc.tool}</span>
          <span className="dim" style={{ fontSize: 9 }}>#{tc.index + 1}</span>
        </button>
        {!collapsed && (
          <div className="agent-block-body">
            <div className="agent-block-args">
              {formatToolArgPreview(tc.tool, tc.args)}
            </div>
            {tc.thought && (
              <div className="agent-block-thought">
                <span className="agent-block-thought-label">reasoning</span>
                <p>{tc.thought}</p>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  if (segment.type === 'tool_output' && segment.text.trim()) {
    return (
      <div className={clsx('agent-block agent-block-output', collapsed && 'collapsed')}>
        <button className="agent-block-head agent-block-head-output" type="button" onClick={() => setCollapsed(!collapsed)}>
          <ChevronRight size={12} className={clsx('agent-block-chevron', !collapsed && 'expanded')} />
          <span className="agent-block-title dim" style={{ fontSize: 10 }}>output</span>
        </button>
        {!collapsed && <ToolOutput text={segment.text} />}
      </div>
    );
  }

  if (segment.type === 'reasoning' && segment.text.trim()) {
    return (
      <div className={clsx('agent-block agent-block-reasoning', collapsed && 'collapsed')}>
        <button className="agent-block-head agent-block-head-reasoning" type="button" onClick={() => setCollapsed(!collapsed)}>
          <ChevronRight size={12} className={clsx('agent-block-chevron', !collapsed && 'expanded')} />
          <span className="agent-block-title dim" style={{ fontSize: 10 }}>reasoning</span>
        </button>
        {!collapsed && (
          <div className="agent-block-body">
            <div className="chat-markdown" style={{ fontSize: 12, color: 'var(--soft)', lineHeight: 1.5 }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{segment.text}</ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (segment.type === 'summary' || (segment.type === 'summary_marker' && segment.text.trim())) {
    return <div className="agent-block-divider" />;
  }

  return null;
}

function ToolOutput({ text }: { text: string }) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const isCode = /^[\s]*[$>]/m.test(trimmed) || /^(import |from |def |class |n_)/m.test(trimmed);

  if (isCode && trimmed.length < 5000) {
    return (
      <div className="agent-block-output-code">
        <SyntaxHighlighter
          language="bash"
          style={oneDark}
          customStyle={{
            margin: 0,
            padding: '6px 10px',
            fontSize: 11,
            background: '#0e1318',
            borderRadius: 4,
            border: '1px solid rgba(255,255,255,0.04)',
          }}
          codeTagProps={{ style: { fontFamily: 'var(--mono)' } }}
        >
          {trimmed}
        </SyntaxHighlighter>
      </div>
    );
  }

  return (
    <pre className="agent-block-output-text">
      {trimmed.length > 2000 ? trimmed.slice(0, 2000) + '\n… (truncated)' : trimmed}
    </pre>
  );
}

function ChatMessageItem({ message }: { message: ChatMessage }) {
  const t = useT();
  const [showTrace, setShowTrace] = useState(true);
  const { toolEvents, streamingAssistantMessages } = useAppStore();

  const relevantTools = toolEvents.filter((te) => {
    return toolEvents.length > 0;
  });

  const isStreaming = message.role === 'user' &&
    useAppStore.getState().chatBusy;

  const streamContent = streamingAssistantMessages.get(message.message_id);
  const displayContent = message.content || streamContent || '';

  return (
    <div className={clsx('message', message.role)}>
      <strong>{message.role === 'user' ? t.chatRail.you : message.role === 'platform' ? t.chatRail.system : t.chatRail.agent}</strong>
      <div className="message-body">
        {displayContent ? (
          <div className="chat-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayContent}</ReactMarkdown>
            {useAppStore.getState().chatBusy && message.role === 'user' && !message.content && (
              <span className="stream-cursor" />
            )}
          </div>
        ) : message.role === 'assistant' && useAppStore.getState().chatBusy ? (
          <div className="chat-markdown" style={{ opacity: 0.5 }}>
            <em>▊</em>
          </div>
        ) : null}

        {message.role === 'user' && useAppStore.getState().chatBusy && relevantTools.length > 0 && (
          <div className="tool-trace" style={{ marginTop: 8 }}>
            <details open={showTrace}>
              <summary onClick={() => setShowTrace(!showTrace)}>
                <span className="tool-trace-title">{t.chatRail.toolTrace} ({relevantTools.length})</span>
                <span className="tool-trace-meta">{relevantTools.filter((e) => e.status === 'running').length > 0 ? t.chatRail.running : t.chatRail.done}</span>
              </summary>
              <div className="tool-step-list">
                {relevantTools.map((event, i) => (
                  <div key={event.event_id || i} className={clsx('tool-step', event.status === 'ok' && 'ok')}>
                    <div className="tool-step-dot" />
                    <div className="tool-step-main">
                      <div className="tool-step-head">
                        <strong>{event.name || event.type || 'tool'}</strong>
                        <span>{event.status === 'running' ? t.chatRail.running : event.status === 'ok' ? 'OK' : event.status}</span>
                      </div>
                      {event.message && <div className="tool-step-meta">{event.message}</div>}
                      {event.steps && event.steps.length > 0 && (
                        <div className="tool-step-detail">
                          {event.steps.map((step: ChatToolStep) => (
                            <div key={step.step_id} className={clsx('tool-step-sub', step.status)}>
                              <span className="tool-step-sub-action">{step.action}</span>
                              <span className="tool-step-sub-content">{step.content}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          </div>
        )}

        {message.decision && (
          <DecisionCardView decision={message.decision} />
        )}
      </div>
    </div>
  );
}

function DecisionCardView({ decision }: { decision: NonNullable<ChatMessage['decision']> }) {
  const t = useT();
  const handleResolve = async (choice: string) => {
    try { await api.resolveDecision(decision.decision_id, choice); } catch {}
  };
  return (
    <div className={clsx('message decision', decision.resolved && 'resolved', decision.expired && 'expired')} style={{ marginTop: 6 }}>
      <div className="decision-body">
        <strong>{decision.title}</strong>
        <p>{decision.body}</p>
        <div className="decision-meta">{decision.resolved ? t.chatRail.resolved : decision.expired ? t.chatRail.expired : t.chatRail.pendingDecision}</div>
        {!decision.resolved && !decision.expired && (
          <div className="decision-options">
            {decision.options.map((opt) => <button key={opt.key} className="btn" onClick={() => handleResolve(opt.key)}>{opt.label}</button>)}
          </div>
        )}
      </div>
    </div>
  );
}
