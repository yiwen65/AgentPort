import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../../components/Modal";
import type { RemoteClient } from "../../protocol/remoteClient";
import type { SessionSummary } from "./types";

type Action = "rename" | "pin" | "stop" | "archive" | "remove";
export function SessionRowActions({ session, hostId, client, onClose, onChanged, onRemovalPending, onRemovalError }: {
  session: SessionSummary; hostId: string; client: RemoteClient; onClose: () => void; onChanged: () => void | Promise<void>;
  onRemovalPending?: (pending: boolean) => void;
  onRemovalError?: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [action, setAction] = useState<Exclude<Action, "pin" | "stop">>();
  const [title, setTitle] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const submitted = useRef(false);
  const archived = useRef(Boolean(session.archivedAt));
  const run = async (name: Action) => {
    if (submitted.current || (name === "rename" && !title.trim())) return;
    submitted.current = true;
    setBusy(true);
    setError("");
    const backgroundRemoval = name === "remove" && Boolean(onRemovalPending && onRemovalError);
    if (backgroundRemoval) { setRemoving(true); onRemovalPending?.(true); }
    try {
      const params = { sessionId: session.id };
      if (name === "rename") await client.request(hostId, "session.rename", { ...params, title: title.trim() });
      if (name === "pin") await client.request(hostId, "session.pin", { ...params, pinned: !session.pinnedAt });
      if (name === "stop") await client.request(hostId, "session.stop", { ...params, graceMs: 1500 });
      if (name === "archive" || name === "remove") {
        if (!archived.current) {
          await client.request(hostId, "session.archive", params);
          archived.current = true;
        }
        if (name === "remove") await client.request(hostId, "session.archives.delete", params);
      }
      await onChanged();
      onClose();
    } catch (failure) {
      const message = failure && typeof failure === "object" && "message" in failure ? String(failure.message) : String(failure);
      const detail = (archived.current && name === "remove" ? t("session.removeArchived") + " " : "") + message;
      setError(detail);
      if (backgroundRemoval) { onRemovalError?.(detail); onClose(); }
      await onChanged();
    } finally {
      submitted.current = false;
      setBusy(false);
      if (backgroundRemoval) onRemovalPending?.(false);
    }
  };
  if (removing) return null;
  return <Modal title={session.title} onClose={onClose} className="session-row-actions">
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    {action ? <form onSubmit={event => { event.preventDefault(); void run(action); }}>
      <h3>{t(`session.${action}`)}</h3>
      {action === "rename" ? <label>{t("session.renamePrompt")}<input autoFocus maxLength={256} value={title} onChange={event => setTitle(event.target.value)} /></label>
        : <p>{t(action === "remove" ? "session.removeBody" : "session.archiveBody")}</p>}
      <div className="modal-actions"><button type="button" disabled={busy} onClick={() => setAction(undefined)}>{t("common.cancel")}</button><button type="submit" className={action === "rename" ? "primary-button" : "danger-button"} disabled={busy || (action === "rename" && !title.trim())}>{t(`session.${action}`)}</button></div>
    </form> : <div className="terminal-action-grid">
      {(["rename", "pin", "stop", "archive", "remove"] as const).map(name => <button type="button" key={name} disabled={busy} className={name === "remove" ? "danger-text" : undefined} onClick={() => (name === "pin" || name === "stop") ? void run(name) : setAction(name)}>{t(name === "pin" && session.pinnedAt ? "session.unpin" : `session.${name}`)}</button>)}
    </div>}
  </Modal>;
}
