import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../components/Modal";

/** Native editing only: never mirror input/composition events into xterm. */
export function DictationDraft({ available, onInsert, onClose }: {
  available: boolean; onInsert: (text: string) => boolean; onClose: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const blockedGesture = useRef(false);
  const finished = useRef(false);
  const [text, setText] = useState("");
  const [inComposition, setInComposition] = useState(false);
  const cancel = () => { finished.current = true; onClose(); };
  const insert = () => {
    if (finished.current || composing.current || blockedGesture.current || !available) return;
    const finalText = textarea.current?.value ?? "";
    if (!finalText) return;
    finished.current = true; // synchronous latch, including before React commits
    if (onInsert(finalText)) onClose();
    else finished.current = false;
  };
  return <Modal title={t("dictation.title")} onClose={cancel} className="dictation-draft">
    <p id={`${id}-hint`}>{t("dictation.hint")}</p>
    <label htmlFor={id}>{t("dictation.label")}</label>
    <textarea id={id} ref={textarea} value={text} aria-describedby={`${id}-hint`}
      onChange={event => setText(event.currentTarget.value)}
      onCompositionStart={() => { composing.current = true; setInComposition(true); }}
      onCompositionEnd={() => { composing.current = false; setInComposition(false); }} />
    {!available ? <p role="status">{t("dictation.unavailable")}</p> : null}
    <div className="dictation-actions">
      <button type="button" onClick={cancel}>{t("dictation.cancel")}</button>
      <button type="button" disabled={!available || inComposition || !text}
        onPointerDown={() => { blockedGesture.current = composing.current; }}
        onTouchStart={() => { blockedGesture.current = composing.current; }}
        onKeyDown={() => { blockedGesture.current = composing.current; }}
        onClick={insert}>{t("dictation.insert")}</button>
    </div>
  </Modal>;
}
