// Store-driven confirm & prompt dialogs (used by all destructive flows).

import { useEffect, useState } from "react";
import Modal from "./Modal";
import { resolveConfirm, resolvePrompt, useStore } from "../store";

export function ConfirmDialogHost() {
  const confirm = useStore((state) => state.confirm);
  if (!confirm) return null;
  return (
    <Modal
      title={confirm.title}
      onClose={() => resolveConfirm(false)}
      footer={
        <>
          <button className="btn ghost" onClick={() => resolveConfirm(false)}>
            取消
          </button>
          <button
            className={confirm.danger ? "btn danger" : "btn primary"}
            onClick={() => resolveConfirm(true)}
            autoFocus
          >
            {confirm.confirmLabel ?? "确认"}
          </button>
        </>
      }
    >
      {confirm.body ? <p className="dim" style={{ margin: 0, lineHeight: 1.7 }}>{confirm.body}</p> : null}
    </Modal>
  );
}

export function PromptDialogHost() {
  const prompt = useStore((state) => state.prompt);
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => setValue(null), [prompt]);
  if (!prompt) return null;
  const v = value ?? prompt.initial ?? "";
  const submit = () => resolvePrompt(v.trim() ? v : null);
  return (
    <Modal
      title={prompt.title}
      onClose={() => resolvePrompt(null)}
      footer={
        <>
          <button className="btn ghost" onClick={() => resolvePrompt(null)}>
            取消
          </button>
          <button className="btn primary" onClick={submit} disabled={!v.trim()}>
            {prompt.okLabel ?? "确定"}
          </button>
        </>
      }
    >
      <div className="form-row">
        <label htmlFor="prompt-input">{prompt.label}</label>
        <input
          id="prompt-input"
          type="text"
          value={v}
          placeholder={prompt.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
      </div>
    </Modal>
  );
}
