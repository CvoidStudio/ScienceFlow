import type {
  ScienceFlowState,
  StatePatch,
  ChatSession,
  ChatMessage,
  RuntimeSettings,
  BackendHealth,
  WorkspaceFileList,
  AuthUser,
  Command,
  Job,
  PromoteInfo,
  DecisionCard,
} from '../types';

import {
  Proxy,
  DownloadZip,
  UploadDataset,
  UploadDatasetFolder,
  StartChatStream,
  StopChatStream,
  SetBackendURL,
  GetBackendURL,
} from '../../wailsjs/go/main/App';

import { debug } from '../utils/debug';

// ── Base URL (delegated to the Go backend proxy) ──

export function setApiBase(base: string) {
  void SetBackendURL(base || '');
}

export async function getApiBase(): Promise<string> {
  try {
    return await GetBackendURL();
  } catch {
    return '';
  }
}

// ── Client id ──

function getClientId(): string {
  let id = localStorage.getItem('scienceflow.clientId');
  if (!id) {
    id = `web-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    localStorage.setItem('scienceflow.clientId', id);
  }
  return id;
}

// ── Auth token ──

const AUTH_KEY = 'scienceflow.auth';
const AUTH_EXPIRE_DAYS = 7;

interface StoredAuth {
  token: string;
  user: AuthUser;
  expires_at: number;
}

function _getAuthToken(): string | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const stored: StoredAuth = JSON.parse(raw);
    if (Date.now() > stored.expires_at) {
      localStorage.removeItem(AUTH_KEY);
      return null;
    }
    return stored.token;
  } catch {
    return null;
  }
}

export function saveAuth(token: string, user: AuthUser): void {
  const stored: StoredAuth = {
    token,
    user,
    expires_at: Date.now() + AUTH_EXPIRE_DAYS * 86400 * 1000,
  };
  localStorage.setItem(AUTH_KEY, JSON.stringify(stored));
}

export function loadAuth(): { token: string; user: AuthUser } | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const stored: StoredAuth = JSON.parse(raw);
    if (Date.now() > stored.expires_at) {
      localStorage.removeItem(AUTH_KEY);
      return null;
    }
    return { token: stored.token, user: stored.user };
  } catch {
    return null;
  }
}

export function clearAuth(): void {
  localStorage.removeItem(AUTH_KEY);
}

// ── Low-level transport metrics ──

let lastTransportMetrics: Record<string, unknown> | null = null;

export function getLastTransportMetrics() {
  return lastTransportMetrics;
}

// ── Generic JSON/text proxy request ──

interface ProxyResult {
  notModified?: boolean;
  etag?: string;
  [key: string]: unknown;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T & ProxyResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Scienceflow-Client-Id': getClientId(),
    ...((options.headers as Record<string, string>) || {}),
  };

  const token = _getAuthToken();
  if (token && (path.startsWith('/api/') || path.startsWith('/api'))) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const method = (options.method || 'GET').toUpperCase();
  const body =
    options.body === undefined || options.body === null
      ? ''
      : typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body);

  const res = await Proxy({ method, path, body, headers });

  if (res.notModified || res.status === 304) {
    return { notModified: true, etag: res.etag || '' } as unknown as T & ProxyResult;
  }

  if (res.status < 200 || res.status >= 300) {
    const bodyText = res.body || '';
    const message = bodyText
      ? (() => {
          try {
            return JSON.parse(bodyText).error || bodyText;
          } catch {
            return bodyText;
          }
        })()
      : '';
    throw new Error(message || `HTTP ${res.status}`);
  }

  const data = res.body ? JSON.parse(res.body) : {};
  data.etag = res.etag || '';
  if (res.transport) {
    data._transport_client = res.transport;
    lastTransportMetrics = res.transport as unknown as Record<string, unknown>;
  }
  return data as T & ProxyResult;
}

function jsonParams(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

// ── State ──
export async function fetchState(options: {
  compact?: boolean;
  force?: boolean;
  detailNodeId?: string;
  budget?: Record<string, number>;
  etags?: Record<string, string>;
  stateSig?: string;
  taskRoot?: string;
} = {}): Promise<{ state: ScienceFlowState; state_signature?: string; module_etags?: Record<string, string> }> {
  const params: Record<string, string | number> = {};
  if (options.compact !== false) params.compact = '1';
  if (options.detailNodeId) params.detail_node_id = options.detailNodeId;
  if (options.budget) {
    for (const [key, value] of Object.entries(options.budget)) {
      params[key] = value;
    }
  }
  if (options.taskRoot) params.task_root = options.taskRoot;
  const qs = jsonParams(params);
  return request<{
    state: ScienceFlowState;
    state_signature?: string;
    module_etags?: Record<string, string>;
  }>(`/api/state${qs}`);
}

export async function fetchStatePatch(options: {
  compact?: boolean;
  detailNodeId?: string;
  budget?: Record<string, number>;
  etags?: Record<string, string>;
  stateSig?: string;
  taskRoot?: string;
} = {}): Promise<{ state_patch?: StatePatch }> {
  const params: Record<string, string | number> = {};
  params.compact = '1';
  if (options.detailNodeId) params.detail_node_id = options.detailNodeId;
  if (options.budget) {
    for (const [key, value] of Object.entries(options.budget)) {
      params[key] = value;
    }
  }
  if (options.taskRoot) params.task_root = options.taskRoot;
  if (options.stateSig) params.state_sig = options.stateSig;
  const qs = jsonParams(params);
  return request<{ state_patch?: StatePatch }>(`/api/state/patch${qs}`);
}

// ── Health ──
export async function fetchHealth(): Promise<BackendHealth> {
  return request('/api/health');
}

// ── Settings ──
export async function fetchSettings(): Promise<RuntimeSettings> {
  return request('/api/settings');
}

export async function saveSettings(settings: RuntimeSettings): Promise<{ ok: boolean }> {
  return request('/api/settings', {
    method: 'POST',
    body: JSON.stringify(settings),
  });
}

// ── Workspace ──
export async function attachWorkspace(taskRoot: string): Promise<{ ok: boolean }> {
  return request('/api/workspaces/attach', {
    method: 'POST',
    body: JSON.stringify({ task_root: taskRoot }),
  });
}

export async function fetchWorkspaceFiles(taskRoot?: string, sessionId?: string): Promise<WorkspaceFileList> {
  const params = new URLSearchParams();
  if (taskRoot) params.set('task_root', taskRoot);
  if (sessionId) params.set('session_id', sessionId);
  const qs = params.toString();
  return request(`/api/workspace/files${qs ? '?' + qs : ''}`);
}

export async function fetchWorkspaceFileContent(path: string, taskRoot?: string, sessionId?: string): Promise<{ content: string; content_type: string; encoding?: string }> {
  const params = new URLSearchParams({ path });
  if (taskRoot) params.set('task_root', taskRoot);
  if (sessionId) params.set('session_id', sessionId);
  return request(`/api/workspace/file/content?${params.toString()}`);
}

export async function downloadWorkspaceZip(paths: string[], taskRoot?: string): Promise<Blob> {
  const token = _getAuthToken() || '';
  const payload = await DownloadZip(paths, taskRoot || '', token);
  const bytes = base64ToUint8Array(payload.data || '');
  const type = payload.contentType || 'application/zip';
  return new Blob([bytes], { type });
}

function base64ToUint8Array(base64: string): Uint8Array {
  const bin = atob(base64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ── Logs ──
export async function fetchLogs(taskRoot?: string): Promise<{ files: { name: string; path: string; size: number }[] }> {
  const params = taskRoot ? `?task_root=${encodeURIComponent(taskRoot)}` : '';
  return request(`/api/logs${params}`);
}

export async function fetchLogContent(logPath: string, taskRoot?: string): Promise<{ content: string }> {
  const params = new URLSearchParams({ path: logPath });
  if (taskRoot) params.set('task_root', taskRoot);
  return request(`/api/logs/content?${params.toString()}`);
}

// ── Tasks ──
export async function createTask(description?: string): Promise<{ task_id: string; task_root: string }> {
  return request('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ description }),
  });
}

export async function promoteTask(taskId: string): Promise<PromoteInfo> {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/promote`, { method: 'POST' });
}

export async function bindDataset(taskId: string, datasetPath: string): Promise<{ ok: boolean }> {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/dataset`, {
    method: 'POST',
    body: JSON.stringify({ dataset_path: datasetPath }),
  });
}

export async function setTaskMode(taskId: string, mode: 'lite' | 'heavy'): Promise<{ ok: boolean }> {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/mode`, {
    method: 'POST',
    body: JSON.stringify({ mode }),
  });
}

// ── Datasets (multipart upload via Go) ──
export async function uploadDataset(file: File, sessionId?: string): Promise<{ path: string; name: string }> {
  const token = _getAuthToken() || '';
  const data = await fileToBase64(file);
  return UploadDataset({ filename: file.name, data }, sessionId || '', token);
}

export async function uploadDatasetFolder(files: File[], sessionId?: string): Promise<{ path: string; name: string }> {
  const token = _getAuthToken() || '';
  const uploaded = [];
  for (const f of files) {
    uploaded.push({ filename: f.name, data: await fileToBase64(f) });
  }
  return UploadDatasetFolder(uploaded, sessionId || '', token);
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ── Chat ──
export async function fetchChatSessions(taskRoot?: string): Promise<{ sessions: ChatSession[] }> {
  const params = taskRoot ? `?task_root=${encodeURIComponent(taskRoot)}` : '';
  return request(`/api/chat/sessions${params}`);
}

export async function fetchChatMessages(sessionId: string): Promise<ChatMessage[]> {
  return request(`/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`);
}

export async function postChatMessage(
  sessionId: string,
  content: string,
  options: { route?: string; idempotencyKey?: string } = {}
): Promise<{ message_id: string; run_id: string; accepted: boolean }> {
  const url = `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`;
  debug.log('api', 'postChatMessage:', url, 'content=', content.slice(0, 40));
  return request(url, {
    method: 'POST',
    body: JSON.stringify({
      text: content,
      chat_route: options.route || 'agent',
      idempotency_key: options.idempotencyKey,
    }),
  });
}

export async function createChatSession(taskRoot: string, mode = 'agent'): Promise<{ session_id: string; created_at: string; task_root: string }> {
  return request('/api/chat/sessions', {
    method: 'POST',
    body: JSON.stringify({ task_root: taskRoot, mode }),
  });
}

export async function cancelChatRun(sessionId: string): Promise<{ ok: boolean }> {
  return request(`/api/chat/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: 'POST' });
}

// Chat SSE is now bridged through the Go backend. The Go layer maintains the
// EventSource connection and re-emits events via the "chat-event" Wails event.
export function startChatStream(sessionId: string): void {
  const token = _getAuthToken() || '';
  debug.log('api', 'startChatStream:', sessionId, 'hasToken=', !!token);
  StartChatStream(sessionId, token);
}

export function stopChatStream(): void {
  StopChatStream();
}

// ── Commands ──
export async function fetchCommands(taskRoot?: string): Promise<{ commands: Command[] }> {
  const params = taskRoot ? `?task_root=${encodeURIComponent(taskRoot)}` : '';
  return request(`/api/commands${params}`);
}

export async function appendCommand(command: { text: string; command_id?: string }): Promise<Command> {
  return request('/api/commands', {
    method: 'POST',
    body: JSON.stringify(command),
  });
}

// ── Jobs ──
export async function fetchJobs(taskRoot?: string): Promise<{ jobs: Job[] }> {
  const params = taskRoot ? `?task_root=${encodeURIComponent(taskRoot)}` : '';
  return request(`/api/jobs${params}`);
}

export async function launchJob(jobId: string): Promise<{ ok: boolean }> {
  return request(`/api/jobs/${encodeURIComponent(jobId)}/launch`, { method: 'POST' });
}

export async function fetchJobLogs(jobId: string): Promise<{ stdout: string; stderr: string }> {
  return request(`/api/jobs/${encodeURIComponent(jobId)}/logs`);
}

// ── Artifacts ──
export async function fetchArtifactContent(artifactId: string): Promise<{ content: string; content_type: string }> {
  return request(`/api/artifacts/${encodeURIComponent(artifactId)}/content`);
}

// ── Decisions ──
export async function fetchDecisions(): Promise<{ decisions: DecisionCard[] }> {
  return request('/api/decisions');
}

export async function resolveDecision(decisionId: string, choice: string): Promise<{ ok: boolean }> {
  return request(`/api/decisions/${encodeURIComponent(decisionId)}`, {
    method: 'POST',
    body: JSON.stringify({ choice }),
  });
}

// ── Reports ──
export async function fetchReports(taskRoot?: string, sessionId?: string): Promise<{ reports: { path: string; filename: string; relative_path: string; title: string; created_at: string }[] }> {
  const params = new URLSearchParams();
  if (taskRoot) params.set('task_root', taskRoot);
  if (sessionId) params.set('session_id', sessionId);
  const qs = params.toString();
  return request(`/api/reports${qs ? '?' + qs : ''}`);
}

export async function fetchReportContent(reportPath: string, taskRoot?: string, sessionId?: string): Promise<{ content: string; content_type?: string }> {
  const params = new URLSearchParams({ path: reportPath });
  if (taskRoot) params.set('task_root', taskRoot);
  if (sessionId) params.set('session_id', sessionId);
  return request(`/api/reports/content?${params.toString()}`);
}

// ── Auth (gateway_server /login) ──

export async function validateAuth(): Promise<boolean> {
  const token = _getAuthToken();
  if (!token) return false;
  try {
    const res = await Proxy({
      method: 'GET',
      path: '/sources',
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

export async function login(username: string, password: string): Promise<{ token: string; user: AuthUser }> {
  const res = await Proxy({
    method: 'POST',
    path: '/login',
    body: JSON.stringify({ user_name: username, password }),
    headers: { 'Content-Type': 'application/json' },
  });
  if (res.status < 200 || res.status >= 300) {
    const bodyText = res.body || '';
    const message = bodyText
      ? (() => {
          try {
            return JSON.parse(bodyText).detail || bodyText;
          } catch {
            return bodyText;
          }
        })()
      : 'Login failed';
    throw new Error(message);
  }
  const data = JSON.parse(res.body || '{}');
  const user: AuthUser = {
    username: data.user || username,
    display_name: data.user || username,
    created_at: data.expires_at || '',
  };
  saveAuth(data.token, user);
  return { token: data.token, user };
}

export async function register(username: string, password: string, _displayName?: string): Promise<{ token: string; user: AuthUser }> {
  throw new Error('register is not supported; accounts are managed in AUTH.yaml');
}