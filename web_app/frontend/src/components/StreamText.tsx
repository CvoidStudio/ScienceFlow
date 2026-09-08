import { useEffect, useRef } from 'react';
import clsx from 'clsx';

interface StreamTextProps {
  chunks: { id: string; text: string }[];
  isStreaming: boolean;
}

export function StreamText({ chunks, isStreaming }: StreamTextProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const combined = chunks.map((c) => c.text).join('');

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [combined]);

  return (
    <div className="stream-text-wrap">
      <pre className={clsx('stream-text-body', isStreaming && 'is-streaming')}>
        <code>{combined}</code>
        {isStreaming && <span className="stream-cursor" />}
      </pre>
      <div ref={endRef} />
    </div>
  );
}
