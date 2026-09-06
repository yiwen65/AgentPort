export const SHORTCUT_STORAGE_KEY = "agentport.mobile.terminalShortcuts.v1";
export const BUILTIN_SHORTCUTS = ["slash", "control", "tab", "at", "escape", "up", "down", "left", "right", "paste", "shift", "command"] as const;
export type BuiltinShortcut = typeof BUILTIN_SHORTCUTS[number];
export const SPECIAL_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab", "Enter", "Escape", "Backspace", "Home", "End", "Delete"] as const;
export interface KeyModifiers { ctrl?: boolean; shift?: boolean; alt?: boolean }
export type ShortcutAction = { type: "text"; text: string } | ({ type: "key"; key: string } & KeyModifiers);
export type ShortcutItem = { id: BuiltinShortcut; visible: boolean } | { id: `custom_${string}`; visible: boolean; label: string; action: ShortcutAction };
export interface ShortcutLayout { version: 1; items: ShortcutItem[] }
export const MAX_CUSTOM_SHORTCUTS = 24;
export function defaultShortcuts(): ShortcutLayout {
  return { version: 1, items: BUILTIN_SHORTCUTS.map(id => ({ id, visible: true })) };
}
export function isCustomShortcut(item: ShortcutItem): item is Extract<ShortcutItem, { action: ShortcutAction }> {
  return "action" in item;
}
export function validShortcutKey(key: string): boolean {
  return /^[\x20-\x7e]$/.test(key) || (SPECIAL_KEYS as readonly string[]).includes(key);
}

/** Storage is untrusted configuration, never executable JS or an automatic macro. */
export function parseShortcutLayout(value: unknown): ShortcutLayout | undefined {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1
    || !("items" in value) || !Array.isArray(value.items)
    || value.items.length > BUILTIN_SHORTCUTS.length + MAX_CUSTOM_SHORTCUTS) return;
  const ids = new Set<string>();
  const items: ShortcutItem[] = [];
  for (const raw of value.items) {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || ids.has(raw.id) || typeof raw.visible !== "boolean") return;
    ids.add(raw.id);
    if ((BUILTIN_SHORTCUTS as readonly string[]).includes(raw.id)) {
      items.push({ id: raw.id as BuiltinShortcut, visible: raw.visible });
      continue;
    }
    if (!/^custom_[a-zA-Z0-9_-]{1,64}$/.test(raw.id) || typeof raw.label !== "string"
      || !raw.label.trim() || raw.label.trim().length > 16 || !raw.action || typeof raw.action !== "object") return;
    const action = raw.action;
    if (action.type === "text") {
      if (typeof action.text !== "string" || !action.text.length || action.text.length > 4096
        || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(action.text)) return;
      items.push({ id: raw.id, visible: raw.visible, label: raw.label.trim(), action: { type: "text", text: action.text } });
    } else if (action.type === "key") {
      if (typeof action.key !== "string" || !validShortcutKey(action.key)
        || [action.ctrl, action.alt, action.shift].some(flag => flag !== undefined && typeof flag !== "boolean")) return;
      items.push({ id: raw.id, visible: raw.visible, label: raw.label.trim(), action: { type: "key", key: action.key, ctrl: !!action.ctrl, alt: !!action.alt, shift: !!action.shift } });
    } else return;
  }
  if (BUILTIN_SHORTCUTS.some(id => !ids.has(id))) return;
  return { version: 1, items };
}
export function loadShortcuts(): ShortcutLayout {
  try { return parseShortcutLayout(JSON.parse(localStorage.getItem(SHORTCUT_STORAGE_KEY) ?? "null")) ?? defaultShortcuts(); }
  catch { return defaultShortcuts(); }
}
export function saveShortcuts(layout: ShortcutLayout): void {
  const valid = parseShortcutLayout(layout);
  if (!valid) throw new Error("Invalid shortcut configuration");
  localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(valid));
}

const cursorKeys: Record<string, string> = { ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D", Home: "H", End: "F" };
/** Conventional xterm sequences, with DEC application-cursor mode for bare arrows. */
export function encodeShortcutKey(key: string, modifiers: KeyModifiers = {}, applicationCursor = false): string {
  const { ctrl, shift, alt } = modifiers;
  const modifier = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  const cursor = cursorKeys[key];
  if (cursor) return modifier > 1 ? `\x1b[1;${modifier}${cursor}` : `\x1b${applicationCursor ? "O" : "["}${cursor}`;
  if (key === "Delete") return modifier > 1 ? `\x1b[3;${modifier}~` : "\x1b[3~";
  if (key === "Tab") return shift ? "\x1b[Z" : "\t";
  const prefix = alt ? "\x1b" : "";
  if (key === "Enter") return prefix + "\r";
  if (key === "Escape") return prefix + "\x1b";
  if (key === "Backspace") return prefix + (ctrl ? "\b" : "\x7f");
  if (key.length !== 1) return key;
  const unshifted = "`1234567890-=[]\\;',./";
  const shifted = '~!@#$%^&*()_+{}|:"<>?';
  const shiftIndex = unshifted.indexOf(key);
  let value = shift ? (shiftIndex >= 0 ? shifted[shiftIndex] : key.toUpperCase()) : key;
  if (ctrl) {
    const upper = value.toUpperCase();
    if (/^[@-_]$/.test(upper)) value = String.fromCharCode(upper.charCodeAt(0) & 31);
    else value = ({ " ": "\x00", "2": "\x00", "3": "\x1b", "4": "\x1c", "5": "\x1d", "6": "\x1e", "7": "\x1f", "8": "\x7f", "?": "\x7f", "/": "\x1f" } as Record<string, string>)[value] ?? value;
  }
  return prefix + value;
}

/** Apply one-shot screen modifiers without rewriting multi-character IME commits. */
export function applyShortcutModifiers(data: string, modifiers: KeyModifiers): string {
  if (!modifiers.ctrl && !modifiers.shift && !modifiers.alt) return data;
  const cursor = /^\x1b(?:\[|O)([ABCDHF])$/.exec(data);
  if (cursor) return encodeShortcutKey(Object.keys(cursorKeys).find(key => cursorKeys[key] === cursor[1])!, modifiers);
  const key = ({ "\t": "Tab", "\r": "Enter", "\x1b": "Escape", "\x7f": "Backspace" } as Record<string, string>)[data] ?? data;
  return encodeShortcutKey(key, modifiers);
}
