import { Fragment, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../../components/Modal";
import { useMobileTerminalAppearance } from "../../terminal/terminalAppearance";
import { getMobileTerminalPalette, getMobileTerminalWorkspaceVariables, MOBILE_TERMINAL_THEME_IDS, MOBILE_TERMINAL_THEME_MODES } from "../../terminal/terminalThemes";

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [terminalAppearance, setTerminalAppearance] = useMobileTerminalAppearance();

  return (
    <Modal title={t("settings.title", { defaultValue: "Settings" })} onClose={onClose} className="mobile-settings">
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
