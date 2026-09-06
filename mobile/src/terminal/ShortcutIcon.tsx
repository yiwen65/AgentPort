import { isCustomShortcut, type ShortcutItem } from "./shortcuts";

export const SHORTCUT_NAMES: Record<string, string> = {
  slash: "Slash", control: "Control", tab: "Tab", at: "At sign", escape: "Escape", up: "Up arrow", down: "Down arrow", left: "Left arrow", right: "Right arrow", paste: "Paste", shift: "Shift", command: "Command",
};
export const KEY_GLYPHS: Record<string, string> = {
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Tab: "⇥", Enter: "↵", Escape: "⎋", Backspace: "⌫", Home: "↖", End: "↘", Delete: "⌦", " ": "␣",
};
const glyphs: Record<string, string> = { slash: "/", control: "⌃", tab: "⇥", at: "@", escape: "⎋", up: "↑", down: "↓", left: "←", right: "→", shift: "⇧", command: "⌘" };

export function ShortcutSettingsIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3z" /></svg>;
}
export function ShortcutIcon({ item }: { item: ShortcutItem }) {
  if (item.id === "paste") return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="7" y="5" width="12" height="16" rx="2" /><path d="M9 5V3h6v4H9zM5 17H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1" /></svg>;
  if (isCustomShortcut(item)) {
    const { action } = item;
    return <span aria-hidden="true" className="shortcut-custom-label">{action.type === "text" ? item.label
      : `${action.ctrl ? "⌃" : ""}${action.alt ? "⌥" : ""}${action.shift ? "⇧" : ""}${KEY_GLYPHS[action.key] ?? action.key.toUpperCase()}`}</span>;
  }
  return <span aria-hidden="true">{glyphs[item.id]}</span>;
}
