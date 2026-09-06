import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../components/Modal";
import { KEY_GLYPHS, SHORTCUT_NAMES, ShortcutIcon } from "./ShortcutIcon";
import { defaultShortcuts, isCustomShortcut, MAX_CUSTOM_SHORTCUTS, parseShortcutLayout, SPECIAL_KEYS, type ShortcutAction, type ShortcutItem, type ShortcutLayout } from "./shortcuts";
import "./shortcut-settings.css";

export function ShortcutSettings({ layout, onSave, onClose }: { layout: ShortcutLayout; onSave: (next: ShortcutLayout) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(layout);
  const [editing, setEditing] = useState<string>();
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<"text" | "key">("text");
  const [text, setText] = useState("");
  const [key, setKey] = useState("c");
  const [keyKind, setKeyKind] = useState("character");
  const [ctrl, setCtrl] = useState(true);
  const [alt, setAlt] = useState(false);
  const [shift, setShift] = useState(false);
  const [error, setError] = useState("");
  const name = (item: ShortcutItem) => isCustomShortcut(item) ? item.label : t(`shortcuts.names.${item.id}`, { defaultValue: SHORTCUT_NAMES[item.id] });
  const startEdit = (item?: ShortcutItem) => {
    if (!item && draft.items.filter(isCustomShortcut).length >= MAX_CUSTOM_SHORTCUTS) { setError(t("shortcuts.limit")); return; }
    const custom = item && isCustomShortcut(item) ? item : undefined;
    setEditing(custom?.id ?? "new"); setLabel(custom?.label ?? "");
    const action = custom?.action;
    setKind(action?.type ?? "text"); setText(action?.type === "text" ? action.text : "");
    setKey(action?.type === "key" ? action.key : "c");
    setKeyKind(action?.type === "key" && (SPECIAL_KEYS as readonly string[]).includes(action.key) ? action.key : "character");
    setCtrl(action?.type === "key" ? !!action.ctrl : true); setAlt(action?.type === "key" ? !!action.alt : false); setShift(action?.type === "key" ? !!action.shift : false);
    setError("");
  };
  const move = (index: number, delta: number) => {
    const items = [...draft.items];
    [items[index], items[index + delta]] = [items[index + delta], items[index]];
    setDraft({ version: 1, items });
  };
  const applyEdit = () => {
    const id = editing === "new" ? `custom_${crypto.randomUUID()}` as const : editing as `custom_${string}`;
    const action: ShortcutAction = kind === "text" ? { type: "text", text } : { type: "key", key: keyKind === "character" ? key : keyKind, ctrl, alt, shift };
    const item: ShortcutItem = { id, label: label.trim(), visible: draft.items.find(item => item.id === id)?.visible ?? true, action };
    const next: ShortcutLayout = { version: 1, items: editing === "new" ? [...draft.items, item] : draft.items.map(old => old.id === id ? item : old) };
    const valid = parseShortcutLayout(next);
    if (!valid) { setError(t("shortcuts.invalid")); return; }
    setDraft(valid); setEditing(undefined); setError("");
  };
  return <Modal title={t("shortcuts.title")} onClose={onClose} className="shortcut-settings" blurBackdrop={false}>
    <div className="shortcut-settings-content">
      <p className="shortcut-settings-hint">{t("shortcuts.hint")}</p>
      {!editing && <ol className="shortcut-settings-list" aria-label={t("shortcuts.title")}>
        {draft.items.map((item, index) => <li key={item.id} data-shortcut-id={item.id} data-custom={isCustomShortcut(item) || undefined}>
          <label className="shortcut-visibility">
            <input type="checkbox" checked={item.visible} aria-label={t("shortcuts.show", { name: name(item) })} onChange={event => setDraft({ version: 1, items: draft.items.map(old => old.id === item.id ? { ...old, visible: event.target.checked } : old) })} />
            <span className="shortcut-preview"><ShortcutIcon item={item} /></span><span className="shortcut-setting-name">{name(item)}</span>
          </label>
          <button type="button" disabled={index === 0} aria-label={t("shortcuts.earlier", { name: name(item) })} onClick={() => move(index, -1)}><span aria-hidden="true">↑</span></button>
          <button type="button" disabled={index === draft.items.length - 1} aria-label={t("shortcuts.later", { name: name(item) })} onClick={() => move(index, 1)}><span aria-hidden="true">↓</span></button>
          {isCustomShortcut(item) ? <>
            <button type="button" aria-label={t("shortcuts.edit", { name: name(item) })} onClick={() => startEdit(item)}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14Z" /></svg></button>
            <button type="button" aria-label={t("shortcuts.remove", { name: name(item) })} onClick={() => { setDraft({ version: 1, items: draft.items.filter(old => old.id !== item.id) }); if (editing === item.id) setEditing(undefined); }}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" /></svg></button>
          </> : null}
        </li>)}
      </ol>}
      {editing ? <form id="shortcut-editor" className="shortcut-editor" aria-label={t("shortcuts.add")} onSubmit={event => { event.preventDefault(); applyEdit(); }}>
        <label>{t("shortcuts.label")}<input value={label} onChange={event => setLabel(event.target.value)} maxLength={16} required /><small>{t("shortcuts.labelHint")}</small></label>
        <label>{t("shortcuts.kind")}<select value={kind} onChange={event => setKind(event.target.value as "text" | "key")}><option value="text">{t("shortcuts.text")}</option><option value="key">{t("shortcuts.combination")}</option></select></label>
        {kind === "text" ? <label>{t("shortcuts.content")}<textarea value={text} onChange={event => setText(event.target.value)} maxLength={4096} required rows={3} /><small>{t("shortcuts.textHint")}</small></label>
          : <>
            <label>{t("shortcuts.key")}<select value={keyKind} onChange={event => setKeyKind(event.target.value)}><option value="character">{t("shortcuts.character")}</option>{SPECIAL_KEYS.map(key => <option key={key} value={key}>{KEY_GLYPHS[key]} {key}</option>)}</select></label>
            {keyKind === "character" ? <label>{t("shortcuts.character")}<input value={key} onChange={event => setKey(event.target.value)} maxLength={1} required autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label> : null}
            <fieldset className="shortcut-modifiers"><legend>{t("shortcuts.modifiers")}</legend>{([['⌃ Ctrl', ctrl, setCtrl], ['⌥ Alt', alt, setAlt], ['⇧ Shift', shift, setShift]] as const).map(([label, checked, update]) => <label key={label}><input type="checkbox" checked={checked} onChange={event => update(event.target.checked)} />{label}</label>)}</fieldset>
          </>}
      </form> : <button type="button" className="shortcut-add" onClick={() => startEdit()}>{t("shortcuts.add")}</button>}
      {error ? <p role="alert" className="inline-error">{error}</p> : null}
    </div>
    <footer className="shortcut-settings-actions">
      {editing ? <>
        <button type="button" onClick={() => { setEditing(undefined); setError(""); }}>{t("shortcuts.cancelEdit")}</button>
        <button type="submit" form="shortcut-editor">{t(editing === "new" ? "shortcuts.add" : "shortcuts.update")}</button>
      </> : <>
      <button type="button" onClick={() => { setDraft(defaultShortcuts()); setEditing(undefined); setError(""); }}>{t("shortcuts.reset")}</button>
      <button type="button" onClick={onClose}>{t("shortcuts.cancel")}</button>
      <button type="button" className="primary-button" disabled={!!editing} onClick={() => { try { onSave(draft); onClose(); } catch { setError(t("shortcuts.saveError")); } }}>{t("shortcuts.save")}</button>
      </>}
    </footer>
  </Modal>;
}
