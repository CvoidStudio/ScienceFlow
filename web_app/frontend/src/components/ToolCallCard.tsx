import { useState } from 'react';
import clsx from 'clsx';
import type { ToolCallItem } from '../types';

interface ToolCallCardProps {
  tool: ToolCallItem;
}

const TOOL_ICONS: Record<string, string> = {
  bash: '>_',
  read: '\u{1F4C4}',
  write: '\u270F\uFE0F',
  edit: '\u{1F4DD}',
  grep: '\u{1F50D}',
  glob: '\u{1F4C2}',
  ls: '\u{1F4CB}',
};

export function ToolCallCard({ tool }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const icon = TOOL_ICONS[tool.name] || '\u{1F527}';

  return (
    <div className={clsx('tool-call-card', `tool-status-${tool.status}`)}>
      <div
        className="tool-call-card-head"
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
      >
        <span className={clsx('tool-call-dot', tool.status === 'running' && 'pulse')} />
        <span className="tool-call-icon">{icon}</span>
        <span className="tool-call-name">{tool.name}</span>
        {tool.status === 'running' && (
          <span className="tool-call-status running">executing...</span>
        )}
        {tool.status === 'completed' && (
          <span className="tool-call-status completed">done</span>
        )}
        {tool.status === 'failed' && (
          <span className="tool-call-status failed">failed</span>
        )}
        <span className="tool-call-chevron">{expanded ? '\u25B2' : '\u25BC'}</span>
      </div>

      {expanded && (
        <div className="tool-call-card-body">
          {tool.input && (
            <div className="tool-call-section">
              <div className="tool-call-section-label">Input</div>
              <pre className="tool-call-pre">
                {formatInput(tool.name, tool.input)}
              </pre>
            </div>
          )}
          {tool.output && (
            <div className="tool-call-section">
              <div className="tool-call-section-label">Output</div>
              <pre className="tool-call-pre">{tool.output}</pre>
            </div>
          )}
          {tool.error && (
            <div className="tool-call-section">
              <div className="tool-call-section-label error">Error</div>
              <pre className="tool-call-pre tool-call-pre-error">{tool.error}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatInput(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'bash' && input.command) {
    return `$ ${input.command}`;
  }
  if ((toolName === 'read' || toolName === 'write' || toolName === 'edit') && input.file_path) {
    return String(input.file_path);
  }
  if (toolName === 'write' && input.content) {
    const content = String(input.content);
    return content.length > 500 ? content.slice(0, 500) + '\n...' : content;
  }
  if (toolName === 'grep' && input.pattern) {
    return `grep "${input.pattern}"`;
  }
  if ((toolName === 'glob' || toolName === 'ls') && input.path) {
    return String(input.path);
  }
  return JSON.stringify(input, null, 2);
}
