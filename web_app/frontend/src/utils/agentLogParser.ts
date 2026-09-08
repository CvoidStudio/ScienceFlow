// Parses the gateway_server agent log stream into structured segments.
//
// The log format (see docs/refer_gateway.log) is:
//   === Task: ml ===
//   === Query: ... ===
//   === Session: ... ===
//   === Task ID: ... ===
//   === Final Status: ... ===
//   === Exit Code: ... ===
//   === Error: ... ===
//
//   --- Agent Output ---
//
//   → tool_name
//   {"args": "...", "thought": "..."}
//   <tool stdout (free-form)>
//
//   <reasoning markdown between tools>
//
//   ---
//
//   ## Summary
//   <final markdown summary>

export type SegmentType = 'header' | 'tool_call' | 'tool_output' | 'reasoning' | 'summary_marker' | 'summary' | 'blank';

export interface HeaderField {
  key: string;
  value: string;
}

export interface ToolCall {
  index: number;
  tool: string;
  args: Record<string, unknown>;
  thought: string;
}

export interface ParsedSegment {
  type: SegmentType;
  text: string;
  toolCall?: ToolCall;
}

export interface ParsedAgentLog {
  headers: HeaderField[];
  segments: ParsedSegment[];
  toolCalls: ToolCall[];
  reasoningBlocks: string[];
  summary: string;
  raw: string;
}

const HEADER_RE = /^===\s+(.+?)\s*:\s*(.*?)\s*===$/;
const TOOL_ARROW_RE = /^→\s+(.+)/;
const SUMMARY_MARKER = /^---\s*$/;
const SUMMARY_HEADER_RE = /^##\s+Summary/;

function tryParseJSON(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractThought(args: Record<string, unknown>): string {
  return typeof args['thought'] === 'string' ? (args['thought'] as string) : '';
}

function summarizeArgs(args: Record<string, unknown>, tool: string): Record<string, unknown> {
  const clean = { ...args };
  delete clean['thought'];
  if (tool === 'bash' && typeof clean['command'] === 'string') {
    const cmd = clean['command'] as string;
    if (cmd.length > 200) clean['command'] = cmd.slice(0, 200) + '…';
  }
  return clean;
}

export function parseAgentLog(raw: string): ParsedAgentLog {
  const lines = raw.split('\n');
  const headers: HeaderField[] = [];
  const segments: ParsedSegment[] = [];
  const toolCalls: ToolCall[] = [];
  const reasoningBlocks: string[] = [];

  let i = 0;
  let toolIndex = 0;
  let inSummary = false;
  let reasoningBuf: string[] = [];
  let toolOutputBuf: string[] = [];
  let currentTool: ToolCall | null = null;
  let summaryParts: string[] = [];

  const flushReasoning = () => {
    if (reasoningBuf.length > 0) {
      const text = reasoningBuf.join('\n').trim();
      if (text) {
        segments.push({ type: 'reasoning', text });
        reasoningBlocks.push(text);
      }
      reasoningBuf = [];
    }
  };

  const flushToolOutput = () => {
    if (toolOutputBuf.length > 0) {
      const text = toolOutputBuf.join('\n');
      if (text.trim()) segments.push({ type: 'tool_output', text });
      toolOutputBuf = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Header lines
    const hm = line.match(HEADER_RE);
    if (hm) {
      flushReasoning();
      flushToolOutput();
      const key = hm[1].trim();
      const value = hm[2].trim();
      headers.push({ key, value });
      segments.push({ type: 'header', text: `${key}: ${value}` });
      i++;
      continue;
    }

    // Summary marker ---
    if (SUMMARY_MARKER.test(line) && !inSummary) {
      flushReasoning();
      flushToolOutput();
      segments.push({ type: 'summary_marker', text: line });
      i++;
      continue;
    }

    // ## Summary header
    if (SUMMARY_HEADER_RE.test(line.trim())) {
      flushReasoning();
      flushToolOutput();
      inSummary = true;
      summaryParts.push(line);
      segments.push({ type: 'summary', text: line });
      i++;
      continue;
    }

    if (inSummary) {
      summaryParts.push(line);
      segments.push({ type: 'summary', text: line });
      i++;
      continue;
    }

    // --- Agent Output ---
    if (line.trim() === '--- Agent Output ---') {
      i++;
      continue;
    }

    // Tool call: → tool_name
    const tm = line.match(TOOL_ARROW_RE);
    if (tm) {
      flushReasoning();
      flushToolOutput();
      const tool = tm[1].trim();
      const toolCall: ToolCall = {
        index: toolIndex++,
        tool,
        args: {},
        thought: '',
      };

      // Next line may be JSON args
      if (i + 1 < lines.length) {
        const parsed = tryParseJSON(lines[i + 1]);
        if (parsed) {
          toolCall.args = summarizeArgs(parsed, tool);
          toolCall.thought = extractThought(parsed);
          i++; // consume JSON line
        }
      }
      toolCalls.push(toolCall);
      currentTool = toolCall;
      segments.push({ type: 'tool_call', text: tool, toolCall });
      i++;
      continue;
    }

    // If we have a current tool and this isn't a tool arrow or header, it's tool output
    if (currentTool && !line.startsWith('→')) {
      toolOutputBuf.push(line);
      i++;
      continue;
    }

    // Otherwise it's reasoning
    currentTool = null;
    flushToolOutput();
    reasoningBuf.push(line);
    i++;
  }

  flushReasoning();
  flushToolOutput();

  return {
    headers,
    segments,
    toolCalls,
    reasoningBlocks,
    summary: summaryParts.join('\n').trim(),
    raw,
  };
}

export function getHeader(headers: HeaderField[], key: string): string {
  return headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value || '';
}

export function formatToolArgPreview(tool: string, args: Record<string, unknown>): string {
  if (tool === 'bash' && args['command']) {
    return `$ ${args['command']}`;
  }
  if ((tool === 'read' || tool === 'write' || tool === 'edit') && args['path']) {
    return String(args['path']);
  }
  if (tool === 'grep' && args['pattern']) {
    return `grep "${args['pattern']}"`;
  }
  if (tool === 'ls' && args['path']) {
    return String(args['path']);
  }
  const json = JSON.stringify(args, null, 2);
  return json.length > 300 ? json.slice(0, 300) + '…' : json;
}
