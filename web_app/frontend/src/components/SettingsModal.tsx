import { useState, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useT } from '../i18n/useT';
import * as api from '../api/client';

export function SettingsModal() {
  const {
    theme, fontSize, panelLayout,
    setTheme, setFontSize, setPanelLayout,
    runtimeSettings, settingsPanelOpen, setSettingsPanelOpen,
    fetchHealth, fetchSettings,
  } = useAppStore();
  const t = useT();

  const [llmModel, setLlmModel] = useState(
    runtimeSettings?.model_name || t.settingsModal.deepseekV4Flash
  );
  const [status, setStatus] = useState(t.settingsModal.ready);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (runtimeSettings?.model_name) {
      setLlmModel(runtimeSettings.model_name);
    }
  }, [runtimeSettings]);

  const handleTest = async () => {
    setStatus(t.settingsModal.testing);
    try {
      const health = await api.fetchHealth();
      setStatus(health?.ok ? t.settingsModal.connectionOk : t.settingsModal.connectionFailed);
    } catch (e: unknown) {
      setStatus(`Failed: ${(e as Error)?.message || t.settingsModal.unknownError}`);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setStatus(t.settingsModal.saving);
    try {
      await api.saveSettings({
        llm_base_url: runtimeSettings?.llm_base_url || '',
        api_key: runtimeSettings?.api_key || '',
        model_name: llmModel,
      });

      fetchSettings();
      setStatus(t.settingsModal.saved);
    } catch (e: unknown) {
      setStatus(`Failed: ${(e as Error)?.message || t.settingsModal.unknownError}`);
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => setSettingsPanelOpen(false);

  return (
    <div className="settings-modal" data-settings-modal>
      <div className="settings-scrim" data-settings-close onClick={handleClose}></div>
      <section className="settings-card" role="dialog" aria-modal="true">
        <div className="card-head">
          <span className="card-title">{t.settingsModal.settings}</span>
          <button className="btn" type="button" data-settings-close onClick={handleClose}>
            {t.settingsModal.done}
          </button>
        </div>
        <div className="settings-body">
          <div className="settings-section">
            <div className="settings-section-title">{t.settingsModal.display}</div>
            <div className="field">
              <label>{t.settingsModal.theme}</label>
              <select
                data-settings-theme
                value={theme}
                onChange={(e) => setTheme(e.target.value as typeof theme)}
              >
                <option value="scienceflow-dark">{t.settingsModal.dark}</option>
                <option value="paper-light">{t.settingsModal.paperLight}</option>
              </select>
            </div>
            <div className="field">
              <label>{t.settingsModal.textSize}</label>
              <select
                data-settings-font-size
                value={fontSize}
                onChange={(e) => setFontSize(e.target.value as typeof fontSize)}
              >
                <option value="small">{t.settingsModal.small}</option>
                <option value="default">{t.settingsModal.default}</option>
                <option value="large">{t.settingsModal.large}</option>
              </select>
            </div>
            <div className="field settings-panel-layout-field">
              <label>{t.settingsModal.panelLayout}</label>
              <select
                data-settings-panel-layout
                value={panelLayout}
                onChange={(e) => setPanelLayout(e.target.value as typeof panelLayout)}
              >
                <option value="intelligence-left">{t.settingsModal.agentMap}</option>
                <option value="chat-left">{t.settingsModal.platformChat}</option>
              </select>
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">{t.settingsModal.model}</div>
            <div className="settings-grid">
              <div className="field">
                <label>{t.settingsModal.model}</label>
                <select
                  data-settings-llm-model
                  value={llmModel}
                  onChange={(e) => setLlmModel(e.target.value)}
                >
                  <option value="deepseek-v4-flash">{t.settingsModal.deepseekV4Flash}</option>
                </select>
              </div>
            </div>
          </div>

          <div className="settings-status" data-settings-status>{status}</div>
        </div>

        <div className="settings-actions">
          <button
            className="btn"
            type="button"
            data-settings-test
            onClick={handleTest}
          >
            {t.settingsModal.test}
          </button>
          <button
            className="btn primary"
            type="button"
            data-settings-save
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? t.settingsModal.saving : t.settingsModal.save}
          </button>
        </div>
      </section>
    </div>
  );
}
