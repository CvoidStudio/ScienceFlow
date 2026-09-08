import { create } from 'zustand';
import {
  gatewayLogin,
  gatewayListSources,
  gatewayCreateSession,
  gatewayUpdateSessionSources,
  gatewayDeleteSession,
  gatewayListSessions,
  gatewayActivateSession,
  gatewayStartStream,
  gatewayStopStream,
  gatewayFetchFiles,
  type GatewaySourceInfo,
  type GatewaySession,
} from '../api/gateway';
import { parseAgentLog, type ParsedAgentLog } from '../utils/agentLogParser';
import type { FileNode, FileTreeNode } from '../types';

export type GatewayStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'unauthorized' | 'error';

const MAX_LINES = 2000;
const MAX_RAW = 256 * 1024;

interface GatewayState {
  status: GatewayStatus;
  lastError: string;
  user: string;
  userName: string;
  password: string;
  token: string;
  sessionId: string;
  sources: GatewaySourceInfo[];
  subscribedSources: string[];
  sessionList: GatewaySession[];
  lines: string[];
  rawBuffer: string;
  parsedLog: ParsedAgentLog;

  // Backfill (session-switch historical log replay)
  backfilling: boolean;
  backfillCount: number;

  // File tree sync
  fileTreeRoot: string;
  fileTree: FileNode[];
  fileNestedTree: FileTreeNode[];
  fileTreeVersion: number;

  connect: (userName: string, password: string) => Promise<void>;
  disconnect: () => Promise<void>;
  setSubscribedSources: (sources: string[]) => Promise<void>;
  fetchSessionList: () => Promise<void>;
  switchSession: (sessionId: string) => Promise<GatewaySession | null>;
  appendLine: (displayLine: string, rawLine?: string) => void;
  appendBackfill: (src: string, path: string, content: string, truncated: boolean) => void;
  finishBackfill: (count: number) => void;
  clearLines: () => void;
  setStatus: (status: GatewayStatus, error?: string) => void;
  getParsedLog: () => ParsedAgentLog;
  applyFileTree: (root: string, tree: FileNode[]) => void;
  applyFileChanges: (added: FileNode[], removed: FileNode[], modified: FileNode[]) => void;
  refetchFileTree: () => Promise<void>;
  clearFileTree: () => void;
}

export const useGatewayStore = create<GatewayState>((set, get) => ({
  status: 'idle',
  lastError: '',
  user: '',
  userName: '',
  password: '',
  token: '',
  sessionId: '',
  sources: [],
  subscribedSources: [],
  sessionList: [],
  lines: [],
  rawBuffer: '',
  parsedLog: { headers: [], segments: [], toolCalls: [], reasoningBlocks: [], summary: '', raw: '' },
  backfilling: false,
  backfillCount: 0,
  fileTreeRoot: '',
  fileTree: [],
  fileNestedTree: [],
  fileTreeVersion: 0,

  connect: async (userName, password) => {
    set({ status: 'connecting', lastError: '', userName, password, lines: [], rawBuffer: '', parsedLog: { headers: [], segments: [], toolCalls: [], reasoningBlocks: [], summary: '', raw: '' } });
    try {
      localStorage.setItem('scienceflow.gwUser', userName);
      localStorage.setItem('scienceflow.gwPass', password);
      const login = await gatewayLogin(userName, password);
      const sources = await gatewayListSources(login.token);
      const allNames = sources.map((s) => s.name);
      const session = await gatewayCreateSession(login.token, allNames);
      gatewayStartStream(session.session_id);
      set({
        status: 'connecting',
        user: login.user,
        token: login.token,
        sources,
        subscribedSources: session.sources || allNames,
        sessionId: session.session_id,
        lastError: '',
      });
    } catch (e) {
      set({ status: 'error', lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  disconnect: async () => {
    const { token, sessionId } = get();
    gatewayStopStream();
    if (token && sessionId) {
      try {
        await gatewayDeleteSession(token, sessionId);
      } catch {
        /* ignore */
      }
    }
    set({
      status: 'idle',
      lastError: '',
      user: '',
      token: '',
      sessionId: '',
      sources: [],
      subscribedSources: [],
    });
  },

  setSubscribedSources: async (sources) => {
    const { token, sessionId } = get();
    if (!token || !sessionId) return;
    try {
      const session = await gatewayUpdateSessionSources(token, sessionId, sources);
      set({ subscribedSources: session.sources || sources });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  fetchSessionList: async () => {
    const { token } = get();
    if (!token) return;
    try {
      const res = await gatewayListSessions(token);
      set({ sessionList: res.sessions || [] });
    } catch { /* silent */ }
  },

  switchSession: async (id) => {
    const { token, sessionId: current } = get();
    if (!token || !id) return null;
    if (id === current) return null;
    try {
      const session = await gatewayActivateSession(token, id);
      // Stop current stream, rebuild SSE for the new session.
      gatewayStopStream();
      gatewayStartStream(id);
      set({
        sessionId: id,
        subscribedSources: session.sources || [],
        lines: [],
        rawBuffer: '',
        parsedLog: { headers: [], segments: [], toolCalls: [], reasoningBlocks: [], summary: '', raw: '' },
        fileTreeRoot: '',
        fileTree: [],
        fileNestedTree: [],
        fileTreeVersion: 0,
        backfilling: true,
        backfillCount: 0,
      });
      return session;
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  appendLine: (displayLine: string, rawLine?: string) => {
    set((s) => {
      const next = [...s.lines, displayLine];
      const trimmed = next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      const raw = rawLine !== undefined ? s.rawBuffer + rawLine + '\n' : s.rawBuffer;
      const trimmedRaw = raw.length > MAX_RAW ? raw.slice(-MAX_RAW) : raw;
      return {
        lines: trimmed,
        rawBuffer: trimmedRaw,
        parsedLog: parseAgentLog(trimmedRaw),
      };
    });
  },

  appendBackfill: (src: string, path: string, content: string, truncated: boolean) => {
    set((s) => {
      // Split the snapshotted content into display lines and raw feed.
      const header = `── ${src} · ${path}${truncated ? ' (truncated)' : ''} ──`;
      const contentLines = content ? content.split('\n') : [];
      const display = [header, ...contentLines];
      const next = [...s.lines, ...display];
      const trimmed = next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      const raw = s.rawBuffer.length === 0 ? content : s.rawBuffer + '\n' + content;
      const trimmedRaw = raw.length > MAX_RAW ? raw.slice(-MAX_RAW) : raw;
      return {
        lines: trimmed,
        rawBuffer: trimmedRaw,
        parsedLog: parseAgentLog(trimmedRaw),
      };
    });
  },

  finishBackfill: (count: number) => {
    set({ backfilling: false, backfillCount: count });
  },

  clearLines: () => set({ lines: [], rawBuffer: '', parsedLog: { headers: [], segments: [], toolCalls: [], reasoningBlocks: [], summary: '', raw: '' }, backfilling: false, backfillCount: 0 }),

  setStatus: (status, error) => {
    set({ status, ...(error !== undefined ? { lastError: error } : {}) });
  },

  getParsedLog: () => get().parsedLog,

  applyFileTree: (root, tree) => {
    set((s) => ({
      fileTreeRoot: root,
      fileTree: tree,
      fileNestedTree: buildNestedTree(tree),
      fileTreeVersion: s.fileTreeVersion + 1,
    }));
  },

  applyFileChanges: (added, removed, modified) => {
    set((s) => {
      const map = new Map<string, FileNode>();
      for (const n of s.fileTree) map.set(n.path, n);

      for (const n of added) map.set(n.path, n);
      for (const n of modified) map.set(n.path, n);
      for (const n of removed) {
        // Remove the node and any descendants (paths under it)
        const prefix = n.path + '/';
        for (const key of map.keys()) {
          if (key === n.path || key.startsWith(prefix)) {
            map.delete(key);
          }
        }
      }

      const tree = Array.from(map.values()).sort((a, b) => a.path.localeCompare(b.path));
      return {
        fileTree: tree,
        fileNestedTree: buildNestedTree(tree),
        fileTreeVersion: s.fileTreeVersion + 1,
      };
    });
  },

  refetchFileTree: async () => {
    const { token, sessionId } = get();
    if (!token || !sessionId) return;
    try {
      const res = await gatewayFetchFiles(token, sessionId);
      get().applyFileTree(res.root || '', res.tree || []);
    } catch { /* silent */ }
  },

  clearFileTree: () => set({ fileTreeRoot: '', fileTree: [], fileNestedTree: [], fileTreeVersion: 0 }),
}));

// Build a nested tree from a flat list of FileNode (relative slash-delimited paths).
// Dir nodes are inferred from path prefixes even if not explicitly in the list.
function buildNestedTree(flat: FileNode[]): FileTreeNode[] {
  const nodeMap = new Map<string, FileTreeNode>();

  // First pass: create nodes for all explicit entries.
  for (const n of flat) {
    nodeMap.set(n.path, {
      name: n.name,
      path: n.path,
      type: n.type,
      size: n.size,
      mtime: n.mtime,
      children: n.type === 'dir' ? [] : undefined,
    });
  }

  // Second pass: ensure parent dir nodes exist for all paths.
  for (const n of flat) {
    const parts = n.path.split('/');
    let current = '';
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? current + '/' + parts[i] : parts[i];
      if (!nodeMap.has(current)) {
        nodeMap.set(current, {
          name: parts[i],
          path: current,
          type: 'dir',
          size: 0,
          mtime: 0,
          children: [],
        });
      }
    }
  }

  // Third pass: link children to parents.
  const roots: FileTreeNode[] = [];
  for (const node of nodeMap.values()) {
    const parts = node.path.split('/');
    if (parts.length === 1) {
      roots.push(node);
    } else {
      const parentPath = parts.slice(0, -1).join('/');
      const parent = nodeMap.get(parentPath);
      if (parent) {
        if (!parent.children) parent.children = [];
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
  }

  // Sort: dirs first, then files, alphabetically.
  const sortNodes = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type === 'dir' && b.type !== 'dir') return -1;
      if (a.type !== 'dir' && b.type === 'dir') return 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (n.children) sortNodes(n.children);
    }
  };
  sortNodes(roots);

  return roots;
}