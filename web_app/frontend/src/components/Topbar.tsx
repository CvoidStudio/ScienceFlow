import { useAppStore } from '../store/useAppStore';
import { useT } from '../i18n/useT';
import type { Lang } from '../i18n/translations';
import type { AuthUser } from '../types';
import { LogOut, Settings, User, Languages } from 'lucide-react';

interface TopbarProps {
  authUser?: AuthUser | null;
  onLogout?: () => void;
}

export function Topbar({ authUser, onLogout }: TopbarProps) {
  const {
    currentState, currentView, batchPanelCollapsed,
    setSettingsPanelOpen,
    language, setLanguage,
    setView, setFrontTab, setBatchPanelCollapsed,
  } = useAppStore();
  const t = useT();

  const runCount = currentState?.runs?.length || 0;
  const showBatchToggle = currentView !== 'l0' && currentView !== 'l1';

  const toggleLang = () => {
    const next: Lang = language === 'en-US' ? 'zh-CN' : 'en-US';
    setLanguage(next);
  };

  const goToAgentMap = () => {
    setView('l0');
    setFrontTab('agent-map');
    if (!batchPanelCollapsed) setBatchPanelCollapsed(true);
  };

  return (
    <header className="topbar">
      <div className="brand">
        <button className="brand-logo" type="button" onClick={goToAgentMap} title={t.topbar.backToAgentMap} aria-label={t.topbar.backToAgentMap}>
          <img src="/favicon.ico" alt={t.topbar.title} className="brand-logo-image" />
        </button>
        <div className="brand-copy">
          <h1>{t.topbar.title}</h1>
          <p>{t.topbar.workspaceReady}</p>
        </div>
      </div>
      <div className="status-strip"></div>
      <div className="top-actions">
        {authUser && (
          <span className="topbar-user">
            <User size={14} className="topbar-user-icon" />
            <span className="topbar-user-name">{authUser.display_name || authUser.username}</span>
          </span>
        )}
        <button className="btn lang-toggle" type="button"
          title={language === 'en-US' ? t.topbar.switchToEnglish : t.topbar.switchToChinese}
          aria-label={language === 'en-US' ? t.topbar.switchToEnglish : t.topbar.switchToChinese}
          onClick={toggleLang}>
          <Languages size={14} />
          {language === 'en-US' ? '\u4E2D\u6587' : 'EN'}
        </button>
        <div className="top-context-strip">
          <span className="top-context-item status">{t.topbar.status}</span>
        </div>
        {showBatchToggle && (
          <button className="btn top-batch-toggle" type="button" onClick={() => setBatchPanelCollapsed(!batchPanelCollapsed)}>
            <span>{t.topbar.batch}</span>
            <span className="batch-rail-count">{runCount}</span>
          </button>
        )}
        {onLogout && (
          <button className="btn topbar-logout" type="button" onClick={onLogout} title={t.topbar.logout} aria-label={t.topbar.logout}>
            <LogOut size={16} />
          </button>
        )}
        <button className="btn icon-btn" id="frontOpenSettings" type="button" aria-label={t.topbar.settings}
          onClick={() => setSettingsPanelOpen(true)}>
          <Settings size={17} />
        </button>
      </div>
    </header>
  );
}
