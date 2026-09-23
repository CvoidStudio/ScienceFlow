import { useEffect, useState, useCallback, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useGatewayStore } from '../store/useGatewayStore';
import { useT } from '../i18n/useT';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { CsvViewer } from './CsvViewer';
import { AgentLineageView } from './AgentLineageView';
import { ReportViewer } from './ReportViewer';
import clsx from 'clsx';
import { Copy, Check, Download, Printer, Upload, FolderUp } from 'lucide-react';
import { metricText, shortenId, valueOrDash } from '../utils/helpers';
import * as api from '../api/client';
import {
  workspaceDownloadFile,
  workspaceDownloadDir,
  workspaceUploadFiles,
  gatewayFetchFiles,
  gatewayFetchMonitor,
  getSystemStats,
  type GatewayMonitorMetrics,
  type SystemStats,
} from '../api/gateway';
import type { NodeInfo, PerformanceSample, FileTreeNode } from '../types';

export function L1Workspace() {
  const {
    currentState, l1Scope, l1Tab, setL1Tab,
    setView, setFrontTab, setL1Scope, setBatchPanelCollapsed,
    monitorCollapsed, setMonitorCollapsed,
    selectedNodeIndex, selectNode,
    reportList, selectedReportPath, reportContent, fetchReports, fetchReportContent,
  } = useAppStore();
  const t = useT();

  useEffect(() => {
    if (l1Tab === 'key-report') fetchReports();
  }, [l1Tab, fetchReports]);

  const state = currentState;
  const nodes = state?.nodes || [];
  const task = state?.task;
  const summary = state?.summary;
  const scopeLabel = l1Scope === 'node'
    ? `${t.l1Workspace.node} ${shortenId(nodes[selectedNodeIndex]?.node_id || '', 12)}`
    : t.l1Workspace.taskScope;

  const tabGroup = 'l1';
  const selectedReport = reportList.find((report) => report.report_key === selectedReportPath || report.path === selectedReportPath);

  const downloadSelectedReport = () => {
    if (!selectedReport || !reportContent) return;
    const blob = new Blob([reportContent], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = selectedReport.filename || 'key-report.md';
    a.click();
    URL.revokeObjectURL(url);
  };

  const goBackToAgentMap = () => {
    setView('l0');
    setFrontTab('agent-map');
    setBatchPanelCollapsed(true);
  };

  return (
    <div className={clsx('l1-grid', monitorCollapsed && 'monitor-collapsed')}>
      <section className="stack run-workspace">
        <div className="card workspace-card">
          <div className="card-head l1-card-head">
            <div className="l1-head-left">
              <div className="seg" data-tab-group={tabGroup} role="tablist">
                <button type="button" title={t.l1Workspace.backToAgentMap} onClick={goBackToAgentMap}>{t.l1Workspace.agentMapTab}</button>
                <button className={clsx(l1Tab === 'workspace' && 'active')} data-tab-target="workspace" role="tab" aria-selected={l1Tab === 'workspace'} onClick={() => setL1Tab('workspace')}>{t.l1Workspace.workspace}</button>
                <button className={clsx(l1Tab === 'key-report' && 'active')} data-tab-target="key-report" role="tab" aria-selected={l1Tab === 'key-report'} onClick={() => setL1Tab('key-report')}>{t.reportViewer.keyReport}</button>
                <button className={clsx(l1Tab === 'optimization' && 'active')} data-tab-target="optimization" role="tab" aria-selected={l1Tab === 'optimization'} onClick={() => setL1Tab('optimization')}>{t.l1Workspace.lineage}</button>
                <button className={clsx(l1Tab === 'logs' && 'active')} data-tab-target="logs" role="tab" aria-selected={l1Tab === 'logs'} onClick={() => setL1Tab('logs')}>{t.l1Workspace.logs}</button>
              </div>
            </div>
            <span className="card-subtitle" data-l1-scope-label>{scopeLabel}</span>
          </div>
          <div className="card-body">
            <div className={clsx('tab-panel workspace-panel', l1Tab === 'workspace' && 'active')} data-tab-panel="l1:workspace">
              <WorkspaceBrowserView />
            </div>
            <div className={clsx('tab-panel l1-key-report-panel', l1Tab === 'key-report' && 'active')} data-tab-panel="l1:key-report">
              <div className="doc-frame">
                <div className="doc-toolbar">
                  <div className="report-picker">
                    {/* <span className="doc-toolbar-title">{reportList.length} reports</span> */}
                    <select
                      className="report-select"
                      aria-label="Select Key Report"
                      value={selectedReportPath}
                      onChange={(e) => fetchReportContent(e.target.value)}
                      disabled={reportList.length === 0}
                    >
                      {reportList.length > 0 ? reportList.map((r) => (
                        <option key={r.report_key} value={r.report_key}>
                          {r.filename || r.relative_path || r.title}
                        </option>
                      )) : (
                        <option value="">No reports</option>
                      )}
                    </select>
                  </div>
                  <div className="doc-toolbar-actions">
                    <button
                      className="doc-action"
                      type="button"
                      onClick={downloadSelectedReport}
                      disabled={!selectedReport || !reportContent}
                      aria-label={t.reportViewer.download}
                      title={t.reportViewer.download}
                    >
                      <Download size={14} />
                    </button>
                    <button
                      className="doc-action"
                      type="button"
                      onClick={() => window.print()}
                      aria-label={t.reportViewer.pdf}
                      title={t.reportViewer.pdf}
                    >
                      <Printer size={14} />
                    </button>
                  </div>
                </div>
                <div className="doc-scroll">
                  <article className="doc-page">
                    {/* 不加 key：selectedReportPath 变化时若重挂载，挂载 effect 里的
                        clearReportState 会清掉刚加载的报告并触发无限循环。 */}
                    <ReportViewer />
                  </article>
                </div>
              </div>
            </div>
            <div className={clsx('tab-panel optimization-panel', l1Tab === 'optimization' && 'active')} data-tab-panel="l1:optimization">
              <AgentLineageView />
            </div>
            <div className={clsx('tab-panel logs-panel', l1Tab === 'logs' && 'active')} data-tab-panel="l1:logs">
              <L1LogsView />
            </div>
          </div>
        </div>
      </section>

      <aside className={clsx('card l1-monitor', monitorCollapsed && 'is-collapsed')}>
        <button
          className="l1-monitor-toggle"
          type="button"
          aria-expanded={!monitorCollapsed}
          onClick={() => setMonitorCollapsed(!monitorCollapsed)}
        >
          <strong>{t.l1Workspace.monitor}</strong>
          <span>{t.l1Workspace.monitorSubtitle}</span>
          <i>^</i>
        </button>
        {!monitorCollapsed && (
          <div className="card-body">
            <L1MonitorView />
          </div>
        )}
      </aside>
    </div>
  );
}

function L1BoardView() {
  const { currentState, l1Scope, selectedNodeIndex } = useAppStore();
  const t = useT();
  const state = currentState;
  const node = l1Scope === 'node' ? state?.nodes?.[selectedNodeIndex] : null;
  const summary = state?.summary;

  if (l1Scope === 'node' && node) {
    return (
      <div className="l1-board-shell" data-l1-board>
        <div className="l1-board-main">
          <div className="l1-board-screen">
            <div className="l1-board-title">
              <span>{t.l1Workspace.node} {shortenId(node.node_id, 12)}</span>
              <span>{node.status}</span>
            </div>
            <div className="l1-board-lines">
              {node.readme && <div className="l1-board-line">{node.readme}</div>}
              {!node.readme && <div className="l1-board-line">{t.l1Workspace.noReadme}</div>}
            </div>
            <div className="l1-board-stats">
              <div className="l1-board-stat">
                <span>{t.l1Workspace.status}</span>
                <strong>{node.status}</strong>
              </div>
              <div className="l1-board-stat">
                <span>{t.l1Workspace.bestMetric}</span>
                <strong>{metricText(node.best_metric)}</strong>
              </div>
              <div className="l1-board-stat">
                <span>{t.l1Workspace.stages}</span>
                <strong>{node.stage_count || 0}</strong>
              </div>
              <div className="l1-board-stat">
                <span>{t.l1Workspace.elapsed}</span>
                <strong>{node.elapsed || t.common.dash}</strong>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="l1-board-shell" data-l1-board>
      <div className="l1-board-main">
        <div className="l1-board-screen">
          <div className="l1-board-title">
            <span>{t.l1Workspace.taskBoard}</span>
            <span>{summary?.status || t.common.attached}</span>
          </div>
          <div className="l1-board-stats">
            <div className="l1-board-stat">
              <span>{t.l1Workspace.nodes}</span>
              <strong>{summary?.nodes || 0}</strong>
            </div>
            <div className="l1-board-stat">
              <span>{t.l1Workspace.runs}</span>
              <strong>{summary?.runs || 0}</strong>
            </div>
            <div className="l1-board-stat">
              <span>{t.l1Workspace.bestMetric}</span>
              <strong>{metricText(summary?.best_metric)}</strong>
            </div>
            <div className="l1-board-stat">
              <span>{t.l1Workspace.elapsed}</span>
              <strong>{summary?.elapsed || t.common.dash}</strong>
            </div>
          </div>
          <div className="l1-board-lines">
            <div className="l1-board-line">{t.l1Workspace.taskStatus} {summary?.status || t.common.attached}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function blobToText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsText(blob);
  });
}

function parseTimeTrace(sessionId: string, path: string, text: string): GatewayMonitorMetrics | null {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const headers = lines[0].split(',').map((value) => value.trim());
  const indexes = new Map(headers.map((header, index) => [header, index]));
  const sum = (name: string) => lines.slice(1).reduce((total, line) => {
    const fields = line.split(',');
    return total + Number(fields[indexes.get(name) ?? -1] || 0);
  }, 0);
  const input = sum('tokens_input');
  const output = sum('tokens_output');
  const cached = sum('tokens_cached');
  return {
    session_id: sessionId,
    workspace: '',
    updated_at: '',
    sources: [path],
    resources: {
      cpu_percent: 0,
      memory_percent: 0,
      memory_used_gb: 0,
      storage_bytes: 0,
      storage_files: 0,
      storage_display: '',
    },
    tokens: { reserved: true, input, output, cached, total: input + output },
    runtime: { status: 'idle', elapsed: '--', elapsed_ms: 0 },
  } as GatewayMonitorMetrics;
}

function formatMonitorBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function fallbackMonitorFromFiles(sessionId: string, tree: FileTreeNode[]): GatewayMonitorMetrics {
  const files = tree.filter((node) => node.type === 'file');
  const storageBytes = files.reduce((sum, node) => sum + (node.size || 0), 0);
  const newest = files.reduce((max, node) => Math.max(max, node.mtime || 0), 0);
  return {
    session_id: sessionId,
    workspace: '',
    updated_at: newest ? new Date(newest * 1000).toISOString() : '',
    sources: ['workspace file tree'],
    resources: {
      cpu_percent: 0,
      memory_percent: 0,
      memory_used_gb: 0,
      storage_bytes: storageBytes,
      storage_files: files.length,
      storage_display: formatMonitorBytes(storageBytes),
    },
    tokens: {
      reserved: true,
      input: 0,
      output: 0,
      cached: 0,
      total: 0,
    },
    runtime: {
      status: 'idle',
      elapsed: '--',
      elapsed_ms: 0,
    },
  } as GatewayMonitorMetrics;
}

function parseMonitorState(sessionId: string, path: string, text: string): GatewayMonitorMetrics | null {
  try {
    const state = JSON.parse(text);
    const resources = state.resources || state;
    const tokens = state.tokens || state;
    const runtime = state.runtime || state;
    const input = Number(tokens.input ?? tokens.total_tokens_in ?? tokens.tokens_in ?? tokens.input_tokens ?? 0);
    const output = Number(tokens.output ?? tokens.total_tokens_out ?? tokens.tokens_out ?? tokens.output_tokens ?? 0);
    const cached = Number(tokens.cached ?? tokens.total_tokens_cached ?? tokens.tokens_cached ?? tokens.cached_tokens ?? 0);
    return {
      session_id: sessionId,
      workspace: '',
      updated_at: state.updated_at || state.timestamp || '',
      sources: [path],
      resources: {
        cpu_percent: Number(resources.cpu_percent ?? resources.cpu ?? resources.cpu_usage ?? resources.cpu_usage_percent ?? 0),
        memory_percent: Number(resources.memory_percent ?? resources.memory ?? resources.memory_usage_percent ?? 0),
        memory_used_gb: Number(resources.memory_used_gb ?? resources.memory_gb ?? 0),
        storage_bytes: 0,
        storage_files: 0,
        storage_display: '',
      },
      tokens: {
        reserved: true,
        input,
        output,
        cached,
        total: input + output,
      },
      runtime: {
        status: runtime.status || runtime.run_status || 'idle',
        elapsed: runtime.elapsed || '--',
        elapsed_ms: Number(runtime.elapsed_ms ?? 0),
      },
    } as GatewayMonitorMetrics;
  } catch {
    return null;
  }
}

function mergeMonitorFallback(primary: GatewayMonitorMetrics, fallback: GatewayMonitorMetrics): GatewayMonitorMetrics {
  const resources = primary.resources || ({} as any);
  const fallbackResources = fallback.resources || ({} as any);
  const primaryTokens = primary.tokens || ({} as any);
  const fallbackTokens = fallback.tokens || ({} as any);
  const input = primaryTokens.input || fallbackTokens.input || 0;
  const output = primaryTokens.output || fallbackTokens.output || 0;
  const cached = primaryTokens.cached || fallbackTokens.cached || 0;
  return {
    ...primary,
    updated_at: primary.updated_at || fallback.updated_at,
    sources: Array.from(new Set([...(primary.sources || []), ...(fallback.sources || [])])),
    resources: {
      ...resources,
      storage_bytes: resources.storage_bytes || fallbackResources.storage_bytes || 0,
      storage_files: resources.storage_files || fallbackResources.storage_files || 0,
      storage_display: resources.storage_display || fallbackResources.storage_display || '',
    },
    tokens: {
      ...primaryTokens,
      reserved: true,
      input,
      output,
      cached,
      total: primaryTokens.total || fallbackTokens.total || input + output,
    },
  } as GatewayMonitorMetrics;
}

async function gatewayFetchMonitorFallback(token: string, sessionId: string): Promise<GatewayMonitorMetrics> {
  const treeResponse = await gatewayFetchFiles(token, sessionId);
  const tree = treeResponse.tree || [];
  let fallback = fallbackMonitorFromFiles(sessionId, tree);
  const traceFiles = tree.filter((node) => node.type === 'file' && node.path.replace(/\\/g, '/').endsWith('scienceflow_time_trace.csv'));
  for (const traceFile of traceFiles) {
    const parsed = parseTimeTrace(sessionId, traceFile.path, await blobToText(await workspaceDownloadFile(token, sessionId, traceFile.path)));
    if (parsed) fallback = mergeMonitorFallback(parsed, fallback);
  }
  const monitorState = tree.find((node) => node.type === 'file' && node.path.replace(/\\/g, '/').endsWith('logs/monitor_state.json'));
  if (!monitorState) return fallback;
  const blob = await workspaceDownloadFile(token, sessionId, monitorState.path);
  const parsed = parseMonitorState(sessionId, monitorState.path, await blobToText(blob));
  return parsed ? mergeMonitorFallback(parsed, fallback) : fallback;
}

function L1MonitorView() {
  const { currentState } = useAppStore();
  const { token, sessionId } = useGatewayStore();
  const t = useT();
  const monitor = currentState?.monitor;
  const [gatewayMonitor, setGatewayMonitor] = useState<GatewayMonitorMetrics | null>(null);
  const [sysStats, setSysStats] = useState<SystemStats | null>(null);
  const [monitorLoading, setMonitorLoading] = useState(false);
  const prevRef = useRef<Record<string, unknown>>({});
  const [changedKeys, setChangedKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const fetchStats = async () => {
      const stats = await getSystemStats();
      if (!cancelled && stats) setSysStats(stats);
    };
    fetchStats();
    const timer = window.setInterval(fetchStats, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!token || !sessionId) {
      setGatewayMonitor(null);
      return;
    }
    let cancelled = false;
    const fetchMonitor = async () => {
      setMonitorLoading(true);
      try {
        const data = await gatewayFetchMonitor(token, sessionId);
        if (!cancelled) setGatewayMonitor(data);
      } catch {
        try {
          const fallback = await gatewayFetchMonitorFallback(token, sessionId);
          if (!cancelled) setGatewayMonitor(fallback);
        } catch {
          if (!cancelled) setGatewayMonitor(null);
        }
      } finally {
        if (!cancelled) setMonitorLoading(false);
      }
    };
    fetchMonitor();
    const timer = window.setInterval(fetchMonitor, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [token, sessionId]);

  const effectiveMonitor = gatewayMonitor || monitor;

  useEffect(() => {
    if (!effectiveMonitor) return;
    const resources = (effectiveMonitor as any).resources;
    const scheduler = (effectiveMonitor as any).scheduler;
    const cost = (effectiveMonitor as any).cost;
    const performance = (effectiveMonitor as any).performance;
    const workers = (effectiveMonitor as any).workers || [];
    const flat: Record<string, unknown> = {
      cpu: resources?.cpu_percent ?? resources?.cpu ?? 0,
      memory: resources?.memory_percent ?? resources?.memory ?? 0,
      disk: resources?.storage_bytes ?? resources?.disk ?? 0,
      cost: cost?.total || 0,
      tokens: (effectiveMonitor as any).tokens?.total ?? 0,
      queue: scheduler?.queue_depth || 0,
      completed: scheduler?.completed || 0,
      latency: performance?.latency || 0,
      throughput: performance?.throughput || 0,
      controlActive: workers.filter((w: any) => w.worker_id?.includes('control') && (w.status === 'running' || w.status === 'active')).length,
      codeActive: workers.filter((w: any) => w.worker_id?.includes('code_agent') && (w.status === 'running' || w.status === 'active')).length,
    };
    const prev = prevRef.current;
    const changed = new Set<string>();
    for (const key of Object.keys(flat)) {
      if (prev[key] !== undefined && prev[key] !== flat[key]) {
        changed.add(key);
      }
      prev[key] = flat[key];
    }
    if (changed.size > 0) {
      setChangedKeys(changed);
      const timer = setTimeout(() => setChangedKeys(new Set()), 1200);
      return () => clearTimeout(timer);
    }
  }, [effectiveMonitor]);

  if (!effectiveMonitor) {
    return <div className="dim monitor-empty">{monitorLoading ? t.l1Workspace.loadingMonitor : t.l1Workspace.noMonitorData}</div>;
  }

  const { runtime, cost, scheduler, resources, workers, alerts, performance } = effectiveMonitor as any;

  const controlWorkers = workers?.filter((w: any) => w.worker_id?.includes('control')) || [];
  const codeAgents = workers?.filter((w: any) => w.worker_id?.includes('code_agent')) || [];
  const deepAgents = workers?.filter((w: any) => w.worker_id?.includes('deep_agent')) || [];
  const ensembleWorkers = workers?.filter((w: any) => w.worker_id?.includes('ensemble')) || [];

  const controlMax = controlWorkers.length || 1;
  const codeMax = 2;
  const deepMax = 1;
  const ensembleMax = 1;

  const controlActive = controlWorkers.filter((w: any) => w.status === 'running' || w.status === 'active').length;
  const codeActive = codeAgents.filter((w: any) => w.status === 'running' || w.status === 'active').length;
  const deepActive = deepAgents.filter((w: any) => w.status === 'running' || w.status === 'active').length;
  const ensembleActive = ensembleWorkers.filter((w: any) => w.status === 'running' || w.status === 'active').length;

  const cpuPct = Math.round(resources?.cpu_percent ?? resources?.cpu ?? 0);
  const memoryPct = Math.round(resources?.memory_percent ?? resources?.memory ?? 0);
  const sysCpu = sysStats ? Math.round(sysStats.cpu_percent) : null;
  const sysMemory = sysStats ? formatMonitorBytes(sysStats.memory_used_bytes) : null;
  const sysStorage = sysStats ? formatMonitorBytes(sysStats.disk_total_bytes) : null;
  const cpuValue = sysCpu !== null ? `${sysCpu}%` : `${cpuPct}%`;
  const taskMemory = resources?.memory_used_gb ? `${resources.memory_used_gb.toFixed(1)} GB` : (memoryPct ? `${memoryPct}%` : t.common.dash);
  const memoryValue = sysMemory ?? taskMemory;
  const taskStorage = resources?.storage_display || (resources?.disk ? `${resources.disk} GB` : t.common.dash);
  const storageValue = sysStorage ?? taskStorage;
  const donutPct = sysCpu ?? cpuPct;
  const effectiveMonitorData = effectiveMonitor as any;
  const tokensTotal = effectiveMonitorData?.tokens?.total ?? 0;
  const tokensValue = tokensTotal > 0 ? tokensTotal.toLocaleString() : t.l1Workspace.reserved;
  const sourceLabel = effectiveMonitorData?.sources?.length ? effectiveMonitorData.sources.join(' · ') : t.common.dash;
  const runtimeStatus = runtime?.status || t.common.idle;

  const costTotal = cost?.total || 0;

  const latencySamples = performance?.samples || [];
  const hasSamples = latencySamples.length > 0;

  const firstResponseAvg = performance?.latency ? `${performance.latency}ms` : t.common.dash;
  const fullReplyAvg = performance?.throughput ? `${performance.throughput} ctx/s` : t.common.dash;

  const alertsCount = alerts?.length || 0;

  return (
    <div>
      <div className="monitor-grid">
        <div className="viz-card">
          <div className="runtime-status-grid">
            <div className="monitor-subpanel">
              <div className="section-title">{t.l1Workspace.runtimeStatus}</div>
              <div className="lane-grid">
                <div className="lane">
                  <span>{t.l1Workspace.control}</span>
                  <div className="bar" style={{ '--w': `${(controlActive / controlMax) * 100}%` } as React.CSSProperties}><i></i></div>
                  <span>{controlActive}/{controlMax}</span>
                </div>
                <div className="lane">
                  <span>{t.l1Workspace.codeAgent}</span>
                  <div className="bar" style={{ '--w': `${(codeActive / codeMax) * 100}%` } as React.CSSProperties}><i></i></div>
                  <span>{codeActive}/{codeMax}</span>
                </div>
                <div className="lane">
                  <span>{t.l1Workspace.deepAgent}</span>
                  <div className="bar" style={{ '--w': `${(deepActive / deepMax) * 100}%` } as React.CSSProperties}><i></i></div>
                  <span>{deepActive}/{deepMax}</span>
                </div>
                <div className="lane">
                  <span>{t.l1Workspace.ensemble}</span>
                  <div className="bar" style={{ '--w': `${(ensembleActive / ensembleMax) * 100}%` } as React.CSSProperties}><i></i></div>
                  <span>{ensembleActive}/{ensembleMax}</span>
                </div>
              </div>
            </div>
            <div className="monitor-subpanel">
              <div className="section-title">{t.l1Workspace.scheduler}</div>
              <div className="kv">
                <div className="kv-row"><span>{t.l1Workspace.phase}</span><span title={t.l1Workspace.exploitExplore}>{t.l1Workspace.exploitExplore}</span></div>
                <div className="kv-row"><span>{t.l1Workspace.status}</span><span title={runtimeStatus}>{runtimeStatus}</span></div>
                <div className="kv-row"><span>{t.l1Workspace.jobs}</span><span title={`${scheduler?.completed || 0} ${t.l1Workspace.active} / ${scheduler?.failed || 0} ${t.l1Workspace.failed}`}>{scheduler?.completed || 0} {t.l1Workspace.active} / {scheduler?.failed || 0} {t.l1Workspace.failed}</span></div>
                <div className="kv-row"><span>{t.l1Workspace.monitorFile}</span><span title={sourceLabel}>{sourceLabel}</span></div>
              </div>
            </div>
            <div className="monitor-subpanel monitor-wide">
              <div className="runtime-wide-grid">
                <div>
                  <div className="section-title">{t.l1Workspace.budget}</div>
                  <div className="bar-row">
                    <span>{t.l1Workspace.wall}</span>
                    <div className="bar" style={{ '--w': '60%' } as React.CSSProperties}><i></i></div>
                    <span>{runtime?.elapsed || t.common.dash}</span>
                  </div>
                  <div className="bar-row">
                    <span>{t.l1Workspace.left}</span>
                    <div className="bar" style={{ '--w': '40%' } as React.CSSProperties}><i></i></div>
                    <span>{t.l1Workspace.budgetRemaining}</span>
                  </div>
                </div>
                <div>
                  <div className="section-title">{t.l1Workspace.riskHints}</div>
                  <div className="kv">
                    <div className="kv-row"><span>{t.l1Workspace.status}</span><span title={alertsCount > 0 ? `${alertsCount} ${t.l1Workspace.activeAlerts}` : t.l1Workspace.noActiveAlerts}>{alertsCount > 0 ? `${alertsCount} ${t.l1Workspace.activeAlerts}` : t.l1Workspace.noActiveAlerts}</span></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="viz-card">
          <div className="section-title">{t.l1Workspace.costAndLatency}</div>
          <div className="donut-row">
            <div className="donut" style={{'--dp': `${donutPct}%`} as React.CSSProperties}>{donutPct}%</div>
            <div className="kv">
              <div className={clsx('kv-row', changedKeys.has('cpu') && 'value-changed')}><span>{t.l1Workspace.cpu}</span><span>{cpuValue}</span></div>
              <div className={clsx('kv-row', changedKeys.has('memory') && 'value-changed')}><span>{t.l1Workspace.memory}</span><span>{memoryValue}</span></div>
              <div className={clsx('kv-row', changedKeys.has('disk') && 'value-changed')}><span>{t.l1Workspace.storage}</span><span>{storageValue}</span></div>
              <div className={clsx('kv-row', changedKeys.has('cost') && 'value-changed')}><span>{t.l1Workspace.cost}</span><span title={`$${costTotal.toFixed(2)}`}>${costTotal.toFixed(2)}</span></div>
              <div className={clsx('kv-row', changedKeys.has('tokens') && 'value-changed')}><span>{t.l1Workspace.tokensReserved}</span><span title={tokensValue}>{tokensValue}</span></div>
            </div>
          </div>
          <div className="section-title">{t.l1Workspace.latencyHealth}</div>
          <div className="latency-metrics">
            <div className={clsx('latency-metric', changedKeys.has('latency') && 'value-changed')}><span>{t.l1Workspace.firstResponse}</span><strong>{firstResponseAvg}</strong><small>{t.l1Workspace.latencyLabel}</small></div>
            <div className={clsx('latency-metric', changedKeys.has('throughput') && 'value-changed')}><span>{t.l1Workspace.fullReply}</span><strong>{fullReplyAvg}</strong><small>{t.l1Workspace.throughputLabel}</small></div>
            <div className={clsx('latency-metric', changedKeys.has('queue') && 'value-changed')}><span>{t.l1Workspace.queue}</span><strong>{scheduler?.queue_depth ?? 0}</strong><small>{t.l1Workspace.queued}</small></div>
            <div className={clsx('latency-metric', changedKeys.has('completed') && 'value-changed')}><span>{t.l1Workspace.done}</span><strong>{scheduler?.completed ?? 0}</strong><small>{t.l1Workspace.total}</small></div>
          </div>
        </div>
      </div>

      <div className="section-title">{t.l1Workspace.recentLatencySamples}</div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t.l1Workspace.wall}</th>
              <th>{t.l1Workspace.tokens}</th>
              <th>{t.l1Workspace.cache}</th>
              <th>{t.l1Workspace.workspace}</th>
              <th>{t.l1Workspace.nextMonitorAction}</th>
            </tr>
          </thead>
          <tbody>
            {hasSamples ? (
              latencySamples.slice(-12).map((s: PerformanceSample, i: number) => (
                <tr key={i}>
                  <td className="dim">{s.timestamp}</td>
                  <td>{s.value}</td>
                  <td>{s.label}</td>
                  <td className="dim">{t.common.dash}</td>
                  <td className="dim">{t.common.dash}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="dim" colSpan={5}>{t.l1Workspace.noLatencySamples}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OptimizationView() {
  const { currentState, l1Scope, selectedNodeIndex, setL1Scope, selectNode } = useAppStore();
  const t = useT();
  const state = currentState;
  const nodes = state?.nodes || [];
  const timelineEvents = state?.timeline || [];
  const visibleNodes = l1Scope === 'node'
    ? [nodes[selectedNodeIndex]].filter(Boolean)
    : nodes;

  return (
    <div className="optimization-layout" style={{ display: 'block' }}>
      <section className="timeline-card optimization-tree-card" style={{ visibility: 'hidden', maxHeight: 0 }}>
        <div className="timeline-card-head">
          <span>{t.l1Workspace.researchStages}</span><span>{t.l1Workspace.searchGraph}</span>
        </div>
        <div className="mcts-map" style={{ padding: 10, overflow: 'auto', minHeight: 0, maxHeight: 200 }}>
          {visibleNodes.length === 0 ? (
            <div className="dim">{t.l1Workspace.noNodes}</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t.l1Workspace.nodeId}</th>
                    <th>{t.l1Workspace.status}</th>
                    <th>{t.l1Workspace.bestMetric}</th>
                    <th>{t.l1Workspace.stages}</th>
                    <th>{t.l1Workspace.elapsed}</th>
                    <th>{t.l1Workspace.created}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleNodes.map((node, idx) => (
                    <tr
                      key={node.node_id}
                      className={clsx(l1Scope === 'node' && idx === selectedNodeIndex && 'active')}
                      style={{ cursor: 'pointer' }}
                      onClick={() => {
                        if (l1Scope === 'task') {
                          const nodeIdx = nodes.findIndex((n) => n.node_id === node.node_id);
                          if (nodeIdx >= 0) {
                            selectNode(nodeIdx);
                            setL1Scope('node');
                          }
                        }
                      }}
                    >
                      <td className="node-id">{shortenId(node.node_id, 14)}</td>
                      <td>{node.status}</td>
                      <td className="score">{metricText(node.best_metric)}</td>
                      <td>{node.stage_count || 0}</td>
                      <td>{node.elapsed || t.common.dash}</td>
                      <td className="dim">{node.created_at?.slice(0, 16) || t.common.dash}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="timeline-card" style={{ marginTop: 0 }}>
        <div className="timeline-card-head">
          <span>Timeline</span>
          <span className="dim">{timelineEvents.length} events</span>
        </div>
        <div className="timeline-list-panel" style={{ maxHeight: 320, overflow: 'auto' }}>
          <div className="timeline">
            {timelineEvents.length === 0 ? (
              <div className="dim" style={{ padding: '12px 16px' }}>
                Waiting for workflow events...
              </div>
            ) : (
              timelineEvents.map((ev, i) => (
                <div key={i} className="timeline-event">
                  <div className="timeline-event-dot" />
                  <div className="timeline-event-body">
                    <div className="timeline-event-head">
                      <strong>{ev.type}</strong>
                      <span className="dim">{ev.time?.slice(11, 19) || ''}</span>
                    </div>
                    <div className="timeline-event-message">{ev.message}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function WorkspaceBrowserView() {
  const {
    selectedWorkspacePath, setSelectedWorkspacePath,
    workspaceFileTextCache, activeTaskRoot,
    workspaceTreeCollapsed, setWorkspaceTreeCollapsed,
    l1Tab, chatSessionId,
  } = useAppStore();
  const { fileNestedTree, fileTreeRoot, fileTreeVersion, refetchFileTree, status, token, sessionId } = useGatewayStore();
  const t = useT();

  const [content, setContent] = useState('');
  const [contentType, setContentType] = useState('text/plain');
  const [encoding, setEncoding] = useState('utf8');
  const [copyOk, setCopyOk] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');
  const seenFilesRef = useRef<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; node: FileTreeNode } | null>(null);

  // Clear seen files when tree version changes (new full tree)
  useEffect(() => {
    seenFilesRef.current = new Set();
  }, [fileTreeVersion]);

  // Close context menu on any click outside
  useEffect(() => {
    if (!ctxMenu) return;
    const handler = () => setCtxMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [ctxMenu]);

  useEffect(() => {
    if (!selectedWorkspacePath) { setContent(''); setContentType('text/plain'); setEncoding('utf8'); return; }
    const cached = workspaceFileTextCache.get(selectedWorkspacePath);
    if (cached) {
      setContent(cached.content);
      setContentType(cached.contentType);
      setEncoding(cached.encoding);
      return;
    }
    api.fetchWorkspaceFileContent(selectedWorkspacePath, activeTaskRoot() || undefined, chatSessionId || undefined).then((data: any) => {
      setContent(data.content || '');
      setContentType(data.content_type || 'text/plain');
      setEncoding(data.encoding || 'utf8');
      workspaceFileTextCache.set(selectedWorkspacePath, {
        content: data.content || '',
        contentType: data.content_type || 'text/plain',
        encoding: data.encoding || 'utf8',
      });
    }).catch(() => setContent(t.l1Workspace.unableToLoadFile));
  }, [selectedWorkspacePath]);

  const fileCount = fileNestedTree?.length || 0;

  const handleDownload = async () => {
    if (!selectedWorkspacePath) return;
    const base = selectedWorkspacePath.split('/').pop() || t.l1Workspace.file;
    try {
      let blob: Blob;
      let name = base;
      try {
        blob = await workspaceDownloadFile(token, sessionId, selectedWorkspacePath);
      } catch {
        // Path is a directory (or file download rejected) — fall back to zip.
        blob = await workspaceDownloadDir(token, sessionId, selectedWorkspacePath);
        name = base + '.zip';
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
    }
  };

  const handleCopyContent = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopyOk(true);
      setTimeout(() => setCopyOk(false), 2000);
    }).catch(() => {});
  };

  // Download a file/dir via gateway endpoint
  const handleNodeDownload = useCallback(async (node: FileTreeNode) => {
    if (!token || !sessionId) return;
    const isDir = node.type === 'dir' || node.type === 'symlink';
    try {
      const blob = isDir
        ? await workspaceDownloadDir(token, sessionId, node.path)
        : await workspaceDownloadFile(token, sessionId, node.path);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = isDir ? (node.name + '.zip') : node.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* silent */ }
  }, [token, sessionId]);

  // Download entire workspace as zip
  const handleDownloadWorkspace = useCallback(async () => {
    if (!token || !sessionId) return;
    try {
      const blob = await workspaceDownloadDir(token, sessionId, '');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'workspace.zip';
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* silent */ }
  }, [token, sessionId]);

  // Upload files to a target directory
  const handleUploadTo = useCallback(async (targetDir: string, files: File[]) => {
    if (!token || !sessionId || files.length === 0) return;
    setUploading(true);
    setUploadMsg(`Uploading ${files.length} file(s)…`);
    try {
      const result = await workspaceUploadFiles(token, sessionId, targetDir, files);
      setUploadMsg(`Uploaded ${result.uploaded?.length || files.length} file(s)`);
      setTimeout(() => setUploadMsg(''), 3000);
    } catch (e: any) {
      setUploadMsg(`Upload failed: ${e?.message || e}`);
      setTimeout(() => setUploadMsg(''), 5000);
    } finally {
      setUploading(false);
    }
  }, [token, sessionId]);

  // Trigger file picker for upload to root
  const handleUploadRootClick = () => {
    fileInputRef.current?.click();
  };

  // Trigger folder picker for upload to root
  const handleUploadFolderClick = () => {
    folderInputRef.current?.click();
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) handleUploadTo('', files);
    e.target.value = '';
  };

  // Trigger file picker for upload to a specific dir (from context menu)
  const ctxFileInputRef = useRef<HTMLInputElement>(null);
  const [ctxUploadDir, setCtxUploadDir] = useState('');

  const handleCtxUploadClick = (dir: string) => {
    setCtxUploadDir(dir);
    setCtxMenu(null);
    setTimeout(() => ctxFileInputRef.current?.click(), 50);
  };

  const handleCtxFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) handleUploadTo(ctxUploadDir, files);
    e.target.value = '';
  };

  // Context menu handler
  const handleContextMenu = (e: React.MouseEvent, node: FileTreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, node });
  };

  const selectedFileName = selectedWorkspacePath ? selectedWorkspacePath.split('/').pop() || selectedWorkspacePath : t.l1Workspace.selectTextFile;
  const fileExtension = selectedWorkspacePath ? (selectedFileName.includes('.') ? `.${selectedFileName.split('.').pop()}` : '') : t.l1Workspace.fileExtensions;
  const fullExt = (selectedWorkspacePath || '').split('.').pop()?.toLowerCase() || '';
  const isTextPreview = encoding === 'utf8' && !BINARY_EXTS.has('.' + fullExt) && !contentType.startsWith('image/') && !!content && !content.startsWith('[File too large') && !content.startsWith('[Image too large');

  // Reset copy feedback on file switch
  useEffect(() => { setCopyOk(false); }, [selectedWorkspacePath]);

  return (
    <div className={clsx('workspace-browser', workspaceTreeCollapsed && 'is-tree-collapsed')} data-workspace-browser>
      <div className="workspace-tree-pane">
        <div className="workspace-tree-head">
          <button className="workspace-tree-toggle" type="button" data-workspace-tree-toggle onClick={() => setWorkspaceTreeCollapsed(!workspaceTreeCollapsed)}>
            <span>{t.l1Workspace.files}</span>
            <em data-workspace-tree-count>{fileCount}</em>
          </button>
          <div className="workspace-tree-actions">
            <button className="workspace-tree-action-btn" type="button" onClick={handleUploadRootClick} title="Upload files to workspace root" disabled={uploading || !sessionId}>
              <Upload size={13} />
            </button>
            <button className="workspace-tree-action-btn" type="button" onClick={handleUploadFolderClick} title="Upload folder to workspace root" disabled={uploading || !sessionId}>
              <FolderUp size={13} />
            </button>
            <button className="workspace-tree-action-btn" type="button" onClick={handleDownloadWorkspace} title="Download entire workspace" disabled={!sessionId}>
              <Download size={13} />
            </button>
          </div>
        </div>
        {uploading && <div className="workspace-upload-status">{uploadMsg || 'Uploading…'}</div>}
        {!uploading && uploadMsg && <div className="workspace-upload-status done">{uploadMsg}</div>}
        <div className="workspace-file-list" data-workspace-file-list>
          {fileNestedTree.length > 0 ? (
            <GatewayFileTreeView
              nodes={fileNestedTree}
              selectedPath={selectedWorkspacePath}
              onSelect={setSelectedWorkspacePath}
              depth={0}
              seenFilesRef={seenFilesRef}
              onContextMenu={handleContextMenu}
            />
          ) : (
            <div className="dim" style={{ padding: '12px 8px', fontSize: 11 }}>
              {status !== 'connected' ? 'Gateway not connected' : 'No files — waiting for sync…'}
            </div>
          )}
        </div>
        <input ref={fileInputRef} type="file" multiple hidden onChange={handleFileInputChange} />
        <input ref={folderInputRef} type="file" {...({ webkitdirectory: '' } as React.InputHTMLAttributes<HTMLInputElement>)} multiple hidden onChange={handleFileInputChange} />
        <input ref={ctxFileInputRef} type="file" multiple hidden onChange={handleCtxFileInputChange} />
      </div>
      <div className="workspace-file-viewer">
        <div className="workspace-file-head">
          <span className="workspace-file-info">
            <span data-workspace-file-title>{selectedFileName}</span>
            <span data-workspace-file-meta>{fileExtension}</span>
          </span>
          <span className="workspace-file-actions">
            {isTextPreview && (
              <button className={clsx('workspace-copy-btn', copyOk && 'ok')} type="button" onClick={handleCopyContent} title={t.l1Workspace.copyContent}>
                {copyOk ? (
                  <Check size={14} strokeWidth={2.5} />
                ) : (
                  <Copy size={14} />
                )}
              </button>
            )}
            <a className="workspace-download-btn" data-workspace-file-download onClick={handleDownload} style={{ cursor: 'pointer' }} title={t.l1Workspace.download}>
              <Download size={14} />
            </a>
          </span>
        </div>
        <div className="workspace-content workspace-code code" data-workspace-file-content>
          {!selectedWorkspacePath || !content ? (
            <div className="dim" style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
              {t.l1Workspace.selectTextFile}
            </div>
          ) : (
            <FilePreview fileName={selectedFileName} content={content} contentType={contentType} encoding={encoding} />
          )}
        </div>
      </div>

      {/* Right-click context menu */}
      {ctxMenu && (
        <div
          className="ws-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="ws-ctx-item"
            type="button"
            onClick={() => { handleNodeDownload(ctxMenu.node); setCtxMenu(null); }}
          >
            <Download size={13} />
            <span>Download</span>
          </button>
          {(ctxMenu.node.type === 'dir' || ctxMenu.node.type === 'symlink') && (
            <button
              className="ws-ctx-item"
              type="button"
              onClick={() => handleCtxUploadClick(ctxMenu.node.path)}
            >
              <Upload size={13} />
              <span>Upload to here</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── FilePreview ────────────────────────────────────────────────────────────

const BINARY_EXTS = new Set([
  '.pkl', '.pickle', '.h5', '.hdf5', '.pt', '.pth', '.onnx', '.bin',
  '.dat', '.npy', '.npz', '.zip', '.tar', '.gz', '.bz2', '.7z',
  '.so', '.dll', '.exe', '.wasm', '.o', '.a', '.lib',
  '.ttf', '.otf', '.woff', '.woff2',
]);

interface FilePreviewProps {
  fileName: string;
  content: string;
  contentType: string;
  encoding: string;
}

function FilePreview({ fileName, content, contentType, encoding }: FilePreviewProps) {
  const ext = (fileName || '').split('.').pop()?.toLowerCase() || '';
  const fullExt = '.' + ext;

  if (encoding === 'base64' && contentType.startsWith('image/')) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%', overflow: 'auto', background: '#05080c', padding: 16 }}>
        <img
          src={`data:${contentType};base64,${content}`}
          alt={fileName}
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 6 }}
        />
      </div>
    );
  }

  if (BINARY_EXTS.has(fullExt) || contentType === 'application/octet-stream') {
    return (
      <div className="dim" style={{ display: 'grid', placeItems: 'center', height: '100%', fontFamily: 'var(--mono)', fontSize: 13, textAlign: 'center', gap: 6 }}>
        <span style={{ fontSize: 16 }}>{ext.toUpperCase()} Binary</span>
        <span>{fileName}</span>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>Use download button to save</span>
      </div>
    );
  }

  if (content.startsWith('[File too large:') || content.startsWith('[Image too large:')) {
    return (
      <div className="dim" style={{ display: 'grid', placeItems: 'center', height: '100%', fontFamily: 'var(--mono)', fontSize: 13, textAlign: 'center' }}>
        <span>{content}</span>
        <span style={{ fontSize: 11, marginTop: 6, color: 'var(--muted)' }}>Use download button to save</span>
      </div>
    );
  }

  if (fullExt === '.csv') {
    return <CsvViewer content={content} maxRows={500} />;
  }

  if (fullExt === '.md' || fullExt === '.markdown') {
    return (
      <div className="chat-markdown" style={{ padding: '12px 16px', overflow: 'auto', height: '100%' }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {content.slice(0, 100000)}
        </ReactMarkdown>
      </div>
    );
  }

  if (fullExt === '.html' || fullExt === '.htm') {
    return (
      <iframe
        style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
        srcDoc={content}
        title={fileName}
        sandbox="allow-scripts"
      />
    );
  }

  if (fullExt === '.json') {
    let formatted: string;
    try { formatted = JSON.stringify(JSON.parse(content), null, 2); }
    catch { formatted = content; }
    return <CodeBlock content={formatted} lang="json" limit={100000} />;
  }

  if (fullExt === '.yaml' || fullExt === '.yml') {
    return <CodeBlock content={content} lang="yaml" limit={100000} />;
  }

  if (fullExt === '.xml') {
    return <CodeBlock content={content} lang="xml" limit={100000} />;
  }

  if (fullExt === '.sql') {
    return <CodeBlock content={content} lang="sql" limit={100000} />;
  }

  if (['.py', '.ts', '.tsx', '.js', '.jsx', '.css', '.sh', '.bat',
       '.c', '.cpp', '.h', '.hpp', '.rs', '.go', '.java', '.kt', '.swift',
       '.r', '.toml', '.ini', '.cfg'].includes(fullExt)) {
    return <CodeBlock content={content} lang={ext} limit={50000} />;
  }

  if (contentType.startsWith('text/') || contentType === 'application/json' || contentType === 'application/xml') {
    return <CodeBlock content={content} lang="" limit={50000} />;
  }

  return <CodeBlock content={content} lang="" limit={50000} />;
}

// ── Lang mapping ──────────────────────────────────────────────────────────

function mapLang(ext: string): string {
  const m: Record<string, string> = {
    py: 'python', ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    sh: 'bash', bat: 'batch', yml: 'yaml',
    h: 'c', hpp: 'cpp',
    kt: 'kotlin', rs: 'rust', swift: 'swift',
    toml: 'toml', ini: 'ini', cfg: 'ini',
    md: 'markdown',
  };
  return m[ext] || ext;
}

// ── Syntax-highlighted code block ──────────────────────────────────────────

function CodeBlock({ content, lang, limit }: { content: string; lang: string; limit: number }) {
  const display = content.length > limit ? content.slice(0, limit) + '\n\n... [truncated]' : content;
  const hlLang = lang ? mapLang(lang) : 'text';
  const lightTheme = document.documentElement.getAttribute('data-theme') === 'paper-light';
  const scheme = lightTheme ? oneLight : oneDark;

  return (
    <SyntaxHighlighter
      language={hlLang}
      style={scheme}
      showLineNumbers
      wrapLines
      lineNumberStyle={{ minWidth: '2.5em', paddingRight: '1em', color: lightTheme ? 'rgba(92, 70, 40, .45)' : '#495162', userSelect: 'none' }}
      customStyle={{
        margin: 0, padding: '8px 0', height: '100%', minHeight: '100%',
        fontSize: 13, background: 'transparent', borderRadius: 6,
      }}
      codeTagProps={{ style: { fontFamily: 'var(--mono), monospace', background: 'transparent' } }}
    >
      {display}
    </SyntaxHighlighter>
  );
}

// ── FileTree ───────────────────────────────────────────────────────────────

function GatewayFileTreeView({
  nodes, selectedPath, onSelect, depth, seenFilesRef, onContextMenu,
}: {
  nodes: FileTreeNode[];
  selectedPath: string;
  onSelect: (path: string) => void;
  depth: number;
  seenFilesRef: React.MutableRefObject<Set<string>>;
  onContextMenu?: (e: React.MouseEvent, node: FileTreeNode) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggleDir = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  const markSeen = useCallback((path: string) => {
    seenFilesRef.current.add(path);
  }, [seenFilesRef]);

  return (
    <>
      {nodes.map((node) => {
        const isCollapsed = collapsed.has(node.path);
        const isDir = node.type === 'dir' || node.type === 'symlink';
        const hasChildren = isDir && node.children && node.children.length > 0;
        const isNew = !isDir && !seenFilesRef.current.has(node.path);
        return (
          <div key={node.path}>
            <button
              className={clsx('workspace-file-item', node.path === selectedPath && 'active', isNew && 'is-new')}
              onClick={() => {
                if (isDir) {
                  toggleDir(node.path);
                } else {
                  onSelect(node.path);
                  markSeen(node.path);
                }
              }}
              onContextMenu={onContextMenu ? (e) => onContextMenu(e, node) : undefined}
              style={{ paddingLeft: `${8 + depth * 14}px` }}
              title={isDir ? (isCollapsed ? '展开目录' : '折叠目录') : node.path}
            >
              <span className="workspace-file-arrow" style={{ display: 'inline-block', width: 12, fontSize: 10, color: hasChildren ? 'var(--accent)' : 'transparent' }}>
                {isDir ? (hasChildren ? (isCollapsed ? '▸' : '▾') : '▸') : ''}
              </span>
              <span className="workspace-file-name" style={{ fontFamily: 'var(--mono)', fontSize: 11, marginLeft: isDir ? 2 : 0 }}>
                {node.name}
                {node.type === 'symlink' && <span className="dim" style={{ fontSize: 9, marginLeft: 3 }}>→</span>}
              </span>
              {!isDir && (
                <span className="workspace-file-size dim" title={node.size > 0 ? `${node.size} bytes` : ''}>
                  {node.size > 0 ? (node.size < 1024 ? `${node.size}B` : `${(node.size / 1024).toFixed(1)}KB`) : ''}
                </span>
              )}
            </button>
            {isDir && node.children && !isCollapsed && (
              <GatewayFileTreeView
                nodes={node.children}
                selectedPath={selectedPath}
                onSelect={onSelect}
                depth={depth + 1}
                seenFilesRef={seenFilesRef}
                onContextMenu={onContextMenu}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function L1LogsView() {
  const { lines, status, sessionId, backfilling } = useGatewayStore();
  const { chatBusy } = useAppStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    if (scrollRef.current && stickRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  const logText = lines.join('\n');

  return (
    <div className="workspace-file-viewer log-file-viewer" style={{ height: '100%' }}>
      {backfilling && (
        <div className="log-backfill-banner">
          <span className="state-dot pulse" />
          Replaying cached session logs…
        </div>
      )}
      <div className="workspace-content log-live-content" ref={scrollRef} onScroll={(e) => {
        const el = e.currentTarget;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}>
        {logText ? (
          <pre className="terminal-log">{logText}</pre>
        ) : (
          <div className="dim" style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
            {!sessionId
              ? 'No session'
              : status !== 'connected'
                ? 'Gateway not connected'
                : backfilling
                  ? 'Loading session history…'
                  : chatBusy
                    ? 'Agent running — waiting for output…'
                    : 'No logs yet — send a message to start'
            }
          </div>
        )}
      </div>
    </div>
  );
}
