import { useEffect, useRef, useState } from 'react';
import { useGatewayStore } from '../store/useGatewayStore';
import clsx from 'clsx';

const STATUS_LABEL: Record<string, string> = {
  idle: '未连接',
  connecting: '连接中…',
  connected: '已连接',
  disconnected: '已断开',
  unauthorized: '会话失效，请重连',
  error: '连接失败',
};

export function GatewayLogPanel() {
  const {
    status, lastError, user, sessionId, sources, subscribedSources, lines,
    connect, disconnect, setSubscribedSources, clearLines,
    userName, password,
  } = useGatewayStore();

  const [username, setUsername] = useState(userName || 'admin');
  const [pwd, setPwd] = useState(password || '');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  const connected = status === 'connected' || status === 'connecting';
  const sourceNames = sources.map((s) => s.name);

  const toggleSource = (name: string) => {
    const has = subscribedSources.includes(name);
    const next = has ? subscribedSources.filter((s) => s !== name) : [...subscribedSources, name];
    setSubscribedSources(next);
  };

  const handleConnect = () => {
    if (username.trim() && pwd) connect(username.trim(), pwd);
  };

  return (
    <div className="gateway-log-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 0' }}>
        {!connected ? (
          <>
            <input
              style={{ width: 140 }}
              placeholder="用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <input
              style={{ width: 160 }}
              type="password"
              placeholder="密码"
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleConnect(); }}
            />
            <button className="btn primary" onClick={handleConnect}>连接日志网关</button>
          </>
        ) : (
          <>
            <span className={clsx('state-indicator', status === 'connected' ? 'state-completed' : 'state-running')}>
              <span className="state-indicator-dot" />
              {STATUS_LABEL[status] || status}
            </span>
            {user && <span className="dim" style={{ fontFamily: 'var(--mono)' }}>{user}</span>}
            {sessionId && <span className="dim" style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>session {sessionId.slice(0, 12)}…</span>}
            <button className="btn" onClick={() => { disconnect(); }}>断开</button>
            <button className="btn" onClick={() => clearLines()}>清空</button>
          </>
        )}
        {lastError && <span className="bad" style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{lastError}</span>}
      </div>

      {/* Sources */}
      {connected && sourceNames.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '4px 0', borderBottom: '1px solid var(--line)' }}>
          <span className="dim" style={{ fontSize: 11 }}>订阅源：</span>
          {sourceNames.map((name) => {
            const active = subscribedSources.includes(name);
            return (
              <button
                key={name}
                className={clsx('pill', active && 'active')}
                style={{ cursor: 'pointer' }}
                onClick={() => toggleSource(name)}
                title={sources.find((s) => s.name === name)?.files.join('\n') || name}
              >
                {name}
              </button>
            );
          })}
        </div>
      )}

      {/* Log output */}
      <div
        ref={scrollRef}
        style={{
          flex: 1, minHeight: 0, overflow: 'auto', marginTop: 8,
          background: '#090d12', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 6,
          padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.5,
          color: '#b7c5d2',
        }}
      >
        {lines.length === 0 ? (
          <div className="dim" style={{ padding: 12 }}>
            {connected ? '等待日志…' : '连接 log_gateway_server 后可实时查看日志流。'}
          </div>
        ) : (
          lines.map((line, i) => (
            <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{line}</div>
          ))
        )}
      </div>
    </div>
  );
}