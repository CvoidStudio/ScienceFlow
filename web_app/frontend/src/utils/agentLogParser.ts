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
  // Segment index of each run's raw task header (=== [ts] task=... ===),
  // i.e. where every run's reasoning begins. Used to anchor chat messages
  // to their run's workflow blocks even after a refresh/backfill.
  runStarts: number[];
}

export interface ParsedChatLogMessage {
  message_id: string;
  role: 'user' | 'assistant' | 'platform';
  content: string;
  created_at: string;
  // Segment index where this run's reasoning starts (present on user messages
  // when runStarts data was available during parsing).
  userWfStart?: number;
}

const HEADER_RE = /^===\s+(.+?)\s*:\s*(.*?)\s*===$/;
const RAW_TASK_HEADER_RE = /^===\s+\[(.+?)\]\s+task=([^\s]+).*?\bquery=("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S.*?)\s*===$/;
const CMD_HEADER_RE = /^===\s+cmd:\s*/;
const TOOL_ARROW_RE = /^→\s+(.+)/;
const SUMMARY_MARKER = /^---\s*$/;
const SUMMARY_HEADER_RE = /^##\s+Summary/;
const MANUAL_STOP_MARKER_RE = /^> 手动终止/; // rendered as a small footer line, not part of the answer

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
  const runStarts: number[] = [];

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
      // A raw task header marks the start of a new agent run.
      if (RAW_TASK_HEADER_RE.test(line)) runStarts.push(segments.length - 1);
      i++;
      continue;
    }

    // Manual-stop marker: rendered by the chat view (parseHistoricalChatMessages),
    // not by the workflow view.
    if (MANUAL_STOP_MARKER_RE.test(line)) {
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
    runStarts,
  };
}

export function parseHistoricalChatMessages(raw: string, runStarts: number[] = []): ParsedChatLogMessage[] {
  const lines = raw.split('\n');
  const messages: ParsedChatLogMessage[] = [];
  let current: { timestamp: string; query: string; output: string[]; stopMarker?: string; userWfStart?: number; taskId?: string } | null = null;
  let queryIndex = 0;

  const flush = () => {
    if (!current) return;
    const query = current.query.trim();
    const answer = current.output.join('\n').trim();
    const createdAt = current.timestamp ? new Date(current.timestamp).toISOString() : new Date().toISOString();
    const suffix = messages.length;
    if (query) {
      // 任务头即 "Task started" 平台消息的真身：乐观版本只存在于发送当次，
      // 页面重载后消失；从日志头重建它，历史轮的系统消息不再丢失。
      // 历史日志没有实时状态，不虚构 status 后缀。
      if (current.taskId) {
        messages.push({
          message_id: `history-task-${current.taskId}-${suffix}`,
          role: 'platform',
          content: `Task started: ${current.taskId}`,
          created_at: createdAt,
        });
      }
      messages.push({
        message_id: `history-user-${suffix}`,
        role: 'user',
        content: query,
        created_at: createdAt,
        userWfStart: current.userWfStart,
      });
    }
    if (answer) {
      messages.push({ message_id: `history-assistant-${suffix}`, role: 'assistant', content: answer, created_at: createdAt });
    }
    // Manual-stop marker becomes a standalone small footer line after the
    // run's answer, never part of the answer content itself. Its timestamp is
    // the marker's own wall-clock text (gateway local time), NOT the round's
    // header time — otherwise a late-arriving marker can sort above the next
    // round's question and transiently break the interleaved order.
    if (current.stopMarker) {
      const timeText = current.stopMarker.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)?.[1];
      const stopAt = timeText ? new Date(timeText) : null;
      const stopIso =
        stopAt && !isNaN(stopAt.getTime()) ? stopAt.toISOString() : createdAt;
      messages.push({
        message_id: `history-stop-${suffix}`,
        role: 'platform',
        content: current.stopMarker,
        created_at: stopIso,
      });
    }
    current = null;
  };

  for (const line of lines) {
    const taskMatch = line.match(RAW_TASK_HEADER_RE);
    if (taskMatch) {
      flush();
      let query = taskMatch[3].trim();
      if ((query.startsWith('"') && query.endsWith('"')) || (query.startsWith("'") && query.endsWith("'"))) {
        query = query.slice(1, -1).replace(/\\([\\"'])/g, '$1');
      }
      current = {
        timestamp: taskMatch[1],
        query,
        output: [],
        userWfStart: runStarts[queryIndex],
        taskId: taskMatch[2],
      };
      queryIndex++;
      continue;
    }
    if (!current || CMD_HEADER_RE.test(line) || line.startsWith('=== ')) continue;
    if (MANUAL_STOP_MARKER_RE.test(line)) {
      current.stopMarker = line.replace(/^>\s*/, '').trim();
      continue;
    }
    if (!line.trim() || line.startsWith('ScienceFlow REPL') || line.startsWith('[repl-')) continue;
    current.output.push(line);
  }
  flush();
  return messages;
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
