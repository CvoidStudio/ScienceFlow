const DEFAULT_REPORT = `# ScienceFlow Workspace Report

ScienceFlow is a WebUI for agent-driven scientific and machine-learning workflows. It connects task submission, dataset context, runtime monitoring, agent chat, artifacts, and final reports into one workspace.

## What ScienceFlow Does

Use Chat Sessions to create a task workspace, then use the chat setup menu to switch Lite/Heavy mode or attach a dataset. The agent can inspect files, run analysis, create figures, update reports, and keep the workspace state synchronized with the backend.

> When a task produces a final report, this page is replaced automatically with the workspace report. Figures, tables, and generated artifacts are rendered inline when they are available.

## Typical Workflow

1. Create a task from Chat Sessions.
2. Use the chat setup menu to select Lite/Heavy mode and optionally upload a local dataset.
3. Use Chat Agent for planning, analysis, code execution, iteration, and reporting.
4. Watch timeline, state, node details, logs, and generated artifacts update live.

## Runtime Surfaces

| surface | purpose |
| --- | --- |
| L0 | Task creation, high-level status, report reading, and Chat Agent interaction. |
| L1 | Node-level artifacts, logs, code, metrics, and workspace inspection. |
| State | Transport health, patch synchronization, scheduler state, and workspace metadata. |
`;

export function getDefaultReport(): string {
  return DEFAULT_REPORT;
}

export function sanitizeReportMarkdown(md: string): string {
  return (md || '')
    .replace(/\[LLM memory view:[^\]]*\]\s*/g, '')
    .replace(/<\|tool_calls\|>[\s\S]*?(?:<\|[\/]tool_calls\|>|$)/g, '')
    .replace(/<｜｜DSML｜｜tool_calls>[\s\S]*?<[\/]｜｜DSML｜｜tool_calls>/g, '')
    .replace(/Platform Chat Update[\s\S]*?(?=\n#|\n---|\n\*\*|$)/g, '')
    .replace(/\b[a-zA-Z]:[\\/][^\s<>"|?*\n]+/g, (match) => match.replace(/[\\/]/g, '/'));
}

export function escapeHtml(text: string): string {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function metricText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  const num = Number(value);
  if (Number.isFinite(num)) {
    if (num < 0.001 && num > -0.001) return num.toExponential(3);
    if (num < 1 && num > -1) return num.toFixed(4);
    return num.toFixed(num > 1000 ? 1 : 3);
  }
  return String(value);
}

export function valueOrDash(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

export function hasDisplayValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}

export function shortenId(id: string, maxLen = 12): string {
  const s = String(id || '');
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 4)}..${s.slice(-4)}`;
}
