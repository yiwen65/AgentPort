import { useLayoutEffect } from "react";
import { useMobileTerminalAppearance } from "../terminal/terminalAppearance";
import { getMobileTerminalPalette, getMobileTerminalWorkspaceVariables } from "../terminal/terminalThemes";

function primaryForeground(background: string): string {
  const channels = [1, 3, 5].map(i => parseInt(background.slice(i, i + 2), 16) / 255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  const luminance = channels.reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
  return 1.05 / (luminance + .05) >= 4.5 ? "#ffffff" : "#000000";
}

/** All surfaces derive from the terminal catalog, not a second app palette. */
export function getAppThemeVariables(theme: unknown, mode: "light" | "dark"): Record<string, string> {
  const { xterm, workspace } = getMobileTerminalPalette(theme, mode);
  return {
    ...getMobileTerminalWorkspaceVariables(theme, mode),
    "--bg": xterm.background,
    "--primary-fg": primaryForeground(xterm.blue),
    "--content-highlight": `${xterm.foreground}12`,
    "--ambient": `${xterm.blue}0a`,
    "--status-waiting-bg": workspace.codeBackground,
    "--status-error-bg": workspace.codeBackground,
    "--modal-scrim": mode === "dark" ? "rgba(0, 0, 0, .58)" : "rgba(20, 24, 32, .28)",
    "--mark-cyan": xterm.blue,
    "--mark-blue": xterm.blue,
    "--mark-violet": xterm.magenta,
    "--mark-dot": xterm.cursor,
  };
}

export function useApplyAppAppearance() {
  const [appearance, , resolvedMode] = useMobileTerminalAppearance();
  useLayoutEffect(() => {
    const root = document.documentElement;
    const variables = getAppThemeVariables(appearance.theme, resolvedMode);
    const previous = Object.keys(variables).map(key => [key, root.style.getPropertyValue(key)] as const);
    root.dataset.appTheme = resolvedMode;
    root.dataset.themeFamily = appearance.theme;
    Object.entries(variables).forEach(([key, value]) => root.style.setProperty(key, value));
    return () => {
      previous.forEach(([key, value]) => value ? root.style.setProperty(key, value) : root.style.removeProperty(key));
      delete root.dataset.appTheme;
      delete root.dataset.themeFamily;
    };
  }, [appearance.theme, resolvedMode]);
}
