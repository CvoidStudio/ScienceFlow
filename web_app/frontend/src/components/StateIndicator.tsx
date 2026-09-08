import clsx from 'clsx';
import type { ChatRunState } from '../types';

interface StateIndicatorProps {
  state: ChatRunState;
}

const STATE_CONFIG: Record<string, { label: string; cls: string }> = {
  idle: { label: 'Idle', cls: 'state-idle' },
  running: { label: 'Running', cls: 'state-running' },
  finalizing: { label: 'Finalizing', cls: 'state-running' },
  cancelling: { label: 'Cancelling', cls: 'state-running' },
  completed: { label: 'Done', cls: 'state-completed' },
  failed: { label: 'Failed', cls: 'state-failed' },
  cancelled: { label: 'Cancelled', cls: 'state-failed' },
};

export function StateIndicator({ state }: StateIndicatorProps) {
  const cfg = STATE_CONFIG[state] || STATE_CONFIG.idle;

  return (
    <span className={clsx('state-indicator', cfg.cls)}>
      <span className={clsx('state-indicator-dot', state === 'running' && 'pulse')} />
      {cfg.label}
    </span>
  );
}
