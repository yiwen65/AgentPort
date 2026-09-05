import { Fragment, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { APP_APPEARANCES, useAppAppearance } from "../../app/appAppearance";
import { Modal } from "../../components/Modal";
import { useMobileTerminalAppearance } from "../../terminal/terminalAppearance";
import { getMobileTerminalPalette, getMobileTerminalWorkspaceVariables, MOBILE_TERMINAL_THEME_IDS, MOBILE_TERMINAL_THEME_MODES } from "../../terminal/terminalThemes";

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const appAppearance = useAppAppearance();
  const [terminalAppearance, setTerminalAppearance] = useMobileTerminalAppearance();

  return (
    <Modal title={t("settings.title", { defaultValue: "Settings" })} onClose={onClose} className="mobile-settings">
      <fieldset className="app-appearance-settings" aria-describedby="app-appearance-hint">
        <legend>{t("settings.appearance.title")}</legend>
        <p id="app-appearance-hint">{t("settings.appearance.hint")}</p>
        <div className="app-appearance-options" role="radiogroup" aria-label={t("settings.appearance.title")}>
          {APP_APPEARANCES.map((mode) => <label key={mode}>
            <input className="visually-hidden" type="radio" name="app-appearance" value={mode}
              aria-label={t("settings.appearance.option", { mode: t(`settings.appearance.modes.${mode}`) })}
              checked={appAppearance.preference === mode} onChange={() => appAppearance.update(mode)} />
            <span><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              {mode === "light" ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></> : mode === "dark" ? <path d="M20.5 14.5A9 9 0 0 1 9.5 3.5a9 9 0 1 0 11 11Z" /> : <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4M12 4v13" /></>}
            </svg>{t(`settings.appearance.modes.${mode}`)}</span>
          </label>)}
        </div>
      </fieldset>
      <fieldset className="terminal-appearance-settings" aria-describedby="terminal-appearance-hint">
        <legend>{t("session.appearance.title")}</legend>
        <p id="terminal-appearance-hint">{t("session.appearance.hint")}</p>

        <span className="terminal-appearance-label" id="terminal-mode-label">{t("session.appearance.mode")}</span>
        <div className="terminal-mode-options" role="radiogroup" aria-labelledby="terminal-mode-label">
          {MOBILE_TERMINAL_THEME_MODES.map((mode) => (
            <label key={mode}>
              <input
                className="visually-hidden"
                type="radio"
                name="mobile-terminal-mode"
                value={mode}
                checked={terminalAppearance.mode === mode}
                onChange={() => setTerminalAppearance({ mode })}
              />
              <span>{t(`session.appearance.modes.${mode}`)}</span>
            </label>
          ))}
        </div>

        <span className="terminal-appearance-label" id="terminal-colors-label">{t("session.appearance.colors")}</span>
        <div className="mobile-terminal-theme-grid" role="radiogroup" aria-labelledby="terminal-colors-label">
          {MOBILE_TERMINAL_THEME_IDS.map((theme) => {
            const preview = getMobileTerminalPalette(theme, terminalAppearance.mode).xterm;
            const descriptionId = `mobile-terminal-theme-${theme}-description`;
            return <Fragment key={theme}>
              <label className="mobile-terminal-theme-choice">
                <input
                  className="visually-hidden"
                  type="radio"
                  name="mobile-terminal-theme"
                  value={theme}
                  checked={terminalAppearance.theme === theme}
                  aria-describedby={descriptionId}
                  onChange={() => setTerminalAppearance({ theme })}
                />
                <span className="mobile-terminal-theme-choice-body">
                  <span className="mobile-terminal-theme-preview" style={{ ...getMobileTerminalWorkspaceVariables(theme, terminalAppearance.mode), background: preview.background, colorScheme: terminalAppearance.mode } as CSSProperties} aria-hidden="true">
                    {[preview.red, preview.yellow, preview.green, preview.cyan, preview.blue, preview.magenta].map((color, index) => (
                      <span key={`${theme}-${index}`} style={{ background: color }} />
                    ))}
                  </span>
                  <span className="mobile-terminal-theme-copy">
                    <strong>{t(`session.appearance.themes.${theme}.name`)}</strong>
                    <span aria-hidden="true">{terminalAppearance.theme === theme ? "✓" : ""}</span>
                  </span>
                </span>
              </label>
              <span className="visually-hidden" id={descriptionId}>{t(`session.appearance.themes.${theme}.description`)}</span>
            </Fragment>;
          })}
        </div>
      </fieldset>
    </Modal>
  );
}
