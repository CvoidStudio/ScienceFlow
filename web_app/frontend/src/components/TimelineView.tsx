import { useEffect, useRef } from 'react';
import type { TimelineItem } from '../types';
import { StreamText } from './StreamText';
import { ToolCallCard } from './ToolCallCard';

interface TimelineViewProps {
  items: TimelineItem[];
  isStreaming: boolean;
}

export function TimelineView({ items, isStreaming }: TimelineViewProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items]);

  const grouped = groupItems(items);

  return (
    <div className="timeline-view">
      {grouped.length === 0 && (
        <div className="timeline-empty">
          Send a message to start the agent...
        </div>
      )}
      {grouped.map((group) => {
        if (group.type === 'stream') {
          return (
            <StreamText
              key={group.key}
              chunks={group.chunks}
              isStreaming={isStreaming}
            />
          );
        }
        if (group.type === 'tool' && group.tool) {
          return <ToolCallCard key={group.key} tool={group.tool} />;
        }
        if (group.type === 'state') {
          return (
            <div key={group.key} className="timeline-state-sep">
              <span>-- Agent {group.state} --</span>
            </div>
          );
        }
        return null;
      })}
      <div ref={endRef} />
    </div>
  );
}

interface StreamGroup {
  key: string;
  type: 'stream';
  chunks: { id: string; text: string }[];
}

interface ToolGroup {
  key: string;
  type: 'tool';
  tool: NonNullable<TimelineItem['tool']>;
}

interface StateGroup {
  key: string;
  type: 'state';
  state: string;
}

type Group = StreamGroup | ToolGroup | StateGroup;

function groupItems(items: TimelineItem[]): Group[] {
  const groups: Group[] = [];
  let currentStream: { id: string; text: string }[] | null = null;

  for (const item of items) {
    if (item.type === 'assistant_chunk') {
      if (currentStream === null) currentStream = [];
      currentStream.push({ id: item.id, text: item.chunk || '' });
    } else {
      if (currentStream && currentStream.length > 0) {
        groups.push({ key: currentStream[0].id, type: 'stream', chunks: [...currentStream] });
        currentStream = null;
      }
      if (item.type === 'tool_call' && item.tool) {
        groups.push({ key: item.id, type: 'tool', tool: item.tool });
      } else if (item.type === 'run_state') {
        groups.push({ key: item.id, type: 'state', state: item.state || 'unknown' });
      }
    }
  }

  if (currentStream && currentStream.length > 0) {
    groups.push({ key: currentStream[0].id, type: 'stream', chunks: [...currentStream] });
  }

  return groups;
}
