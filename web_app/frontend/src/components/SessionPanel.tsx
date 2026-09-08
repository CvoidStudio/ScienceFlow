import { useEffect, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useGatewayStore } from '../store/useGatewayStore';
import { useT } from '../i18n/useT';

export function SessionPanel() {
  const { setSessionsPanelOpen } = useAppStore();
  const { sessionList, fetchSessionList, switchSession, sessionId: gwSessionId } = useGatewayStore();
  const t = useT();

  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetchSessionList().finally(() => setLoading(false));
  }, [fetchSessionList]);

  const handleSelect = async (sessionId: string) => {
    if (switching || sessionId === gwSessionId) return;
    setSwitching(true);
    try {
      const session = await switchSession(sessionId);
      if (session) {
        useAppStore.getState().setChatSessionId(sessionId);
        useAppStore.getState().clearTimeline();
        setSessionsPanelOpen(false);
      }
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="settings-modal">
      <div className="settings-scrim" onClick={() => setSessionsPanelOpen(false)} />
      <div className="settings-card">
        <div className="card-head">
          <span className="card-title">{t.sessionPanel.chatSessions}</span>
          <button className="btn" onClick={() => setSessionsPanelOpen(false)}>{t.sessionPanel.close}</button>
        </div>
        <div className="settings-body">
          <button className="btn" onClick={() => fetchSessionList()} disabled={loading}>
            {t.sessionPanel.refresh || 'Refresh'}
          </button>
          {loading ? (
            <div className="dim" style={{ padding: 20, textAlign: 'center' }}>{t.sessionPanel.loading}</div>
          ) : sessionList.length === 0 ? (
            <div className="dim" style={{ padding: 20, textAlign: 'center' }}>{t.sessionPanel.noSessions}</div>
          ) : (
            sessionList.map((s) => {
              const isActive = s.session_id === gwSessionId;
              const agentStatus = s.agent?.status || 'idle';
              const isRunning = agentStatus === 'active';
              return (
                <button
                  key={s.session_id}
                  className="session-card"
                  disabled={switching}
                  style={{ background: isActive ? 'rgba(92,200,255,0.12)' : undefined }}
                  onClick={() => handleSelect(s.session_id)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: isActive ? 'var(--accent)' : 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.session_id}
                    </span>
                    <span className={isRunning ? 'session-agent-badge running' : 'session-agent-badge'} style={{ flexShrink: 0 }}>
                      {isRunning ? '● running' : 'idle'}
                    </span>
                  </div>
                  <div style={{ fontSize: 13 }}>
                    {s.sources?.length ?? 0} sources
                  </div>
                  {s.last_active && (
                    <div className="dim" style={{ fontSize: 11 }}>
                      {formatLastActive(s.last_active)}
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function formatLastActive(rfc3339: string): string {
  try {
    const d = new Date(rfc3339);
    const now = Date.now();
    const diff = now - d.getTime();
    const sec = Math.floor(diff / 1000);
    if (sec < 0) return 'just now';
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    return `${day}d ago`;
  } catch {
    return '';
  }
}