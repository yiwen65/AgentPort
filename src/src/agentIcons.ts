// Brand marks for agent adapters. claude.svg and kimi.svg carry brand colors;
// codex.svg is a currentColor silhouette (renders black as <img>, lifted to
// light-on-dark via CSS). kimi ships a dedicated light-theme variant.

import claudeIcon from "./assets/agent-icons/claude.svg";
import codexIcon from "./assets/agent-icons/codex.svg";
import kimiIcon from "./assets/agent-icons/kimi.svg";
import kimiLightIcon from "./assets/agent-icons/kimi-light.svg";
import type { EffectiveTheme } from "./store";

export function agentIconSrc(agent: string, theme: EffectiveTheme): string | null {
  if (agent === "codex") return codexIcon;
  if (agent === "claude") return claudeIcon;
  if (agent === "kimi") return theme === "light" ? kimiLightIcon : kimiIcon;
  return null;
}
