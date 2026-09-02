import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteClient, RemoteEvent } from "../../protocol/remoteClient";
import { MobileTerminal } from "../../terminal/MobileTerminal";
import { decodeBase64Utf8, encodeBase64Utf8, outputBase64Of, sessionBatchId, sessionIdOf } from "./sessionProtocol";
import type { OpenSession, RunCursor, SessionAttachResult, SessionEventPayload, TerminalGeometry } from "./types";

const CURSOR_PREFIX = "agentport-mobile-session-cursor-v1:";
const MAX_RENDERED_CHARS = 4 * 1024 * 1024;
const MOBILE_DEVICE_ID_KEY = "agentport-mobile-v2:device-id";

function mobileDeviceId(): string {
  try {
    const existing = localStorage.getItem(MOBILE_DEVICE_ID_KEY);
    if (existing) return existing;
    const created = globalThis.crypto?.randomUUID?.() ?? `mobile-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(MOBILE_DEVICE_ID_KEY, created);
    return created;
  } catch {
    return "mobile-ephemeral";
  }
}

function cursorKey(open: OpenSession) {
  return `${CURSOR_PREFIX}${open.hostProfileId}:${open.session.id}`;
}

function readCursor(open: OpenSession): RunCursor | undefined {
  try {
    const raw = localStorage.getItem(cursorKey(open));
    return raw ? JSON.parse(raw) as RunCursor : undefined;
  } catch {
    return undefined;
  }
}

function appendBounded(current: string[], value: string): string[] {
  const next = [...current, value];
  let total = next.reduce((sum, chunk) => sum + chunk.length, 0);
  while (next.length > 1 && total > MAX_RENDERED_CHARS) total -= next.shift()!.length;
  return next;
}

function errorText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

export function SessionWorkspace({ open, client, onClose, onSessionChanged }: {
  open: OpenSession;
  client: RemoteClient;
  onClose: () => void;
  onSessionChanged: (next?: OpenSession) => void;
}) {
  const { t } = useTranslation();
  const [attachmentId, setAttachmentId] = useState<string>();
  const [connectionLabel, setConnectionLabel] = useState("attaching");
  const [outputChunks, setOutputChunks] = useState<string[]>([]);
  const [resetVersion, setResetVersion] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [otherClientInput, setOtherClientInput] = useState(false);
  const [attachEpoch, setAttachEpoch] = useState(0);
  const [fontSize, setFontSize] = useState(14);
  const [confirmStop, setConfirmStop] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [terminalGeometry, setTerminalGeometry] = useState<TerminalGeometry>();
  const [inputReady, setInputReady] = useState(false);
  const cursor = useRef<RunCursor | undefined>(readCursor(open));
  const ownBatches = useRef(new Set<string>());
  const attachmentRef = useRef<string>();
  const inputQueue = useRef(Promise.resolve());
  const otherInputTimer = useRef<number>();
  const seenTimer = useRef<number>();
  const latestStatusCursor = useRef<{ runId: string; runOrdinal: number; sequence: number }>();
  const needsReattach = useRef(false);
  const pendingResize = useRef<{ cols: number; rows: number }>();
  const lastResize = useRef<{ attachmentId: string; cols: number; rows: number }>();
  const resizeFrame = useRef<number>();
  const geometryRef = useRef<TerminalGeometry>();
  const resizeOwnershipEnabled = useRef(true);
  const sourceDeviceId = useRef(mobileDeviceId());

  const handleEvent = useCallback((event: RemoteEvent<SessionEventPayload>) => {
    const payload = event.payload;
    const attachmentGap = event.eventType === "resync_required" && event.subscriptionId === attachmentRef.current;
    if (sessionIdOf(payload) !== open.session.id && !attachmentGap) return;
    if (event.cursor && typeof event.cursor === "object") {
      cursor.current = event.cursor as RunCursor;
      try { localStorage.setItem(cursorKey(open), JSON.stringify(cursor.current)); } catch { /* persistence is best effort */ }
    }
    const runId = payload.runId ?? payload.run_id;
    const runOrdinal = payload.runOrdinal ?? payload.run_ordinal;
    if (event.eventType === "state" && runId && Number.isInteger(runOrdinal) && Number.isInteger(payload.sequence)) {
      latestStatusCursor.current = { runId, runOrdinal: runOrdinal!, sequence: payload.sequence! };
    }
    if (event.eventType === "terminal_geometry_changed" && payload.geometry) {
      geometryRef.current = payload.geometry;
      setTerminalGeometry(payload.geometry);
      if (payload.geometry.sourceKind === "desktop") {
        resizeOwnershipEnabled.current = false;
        setInputReady(false);
      } else if (payload.geometry.sourceDeviceId === sourceDeviceId.current) {
        setInputReady(true);
        setConnectionLabel("live");
      }
    }
    if (["output", "replay_done", "state"].includes(event.eventType)) {
      window.clearTimeout(seenTimer.current);
      seenTimer.current = window.setTimeout(() => {
        const requests: Promise<unknown>[] = [];
        if (cursor.current) requests.push(client.request(open.hostProfileId, "session.output.unread.mark", { sessionId: open.session.id, cursor: cursor.current }));
        if (latestStatusCursor.current) requests.push(client.request(open.hostProfileId, "session.seen.mark", { sessionId: open.session.id, cursor: latestStatusCursor.current }));
        void Promise.allSettled(requests);
      }, 500);
    }
    const outputBase64 = outputBase64Of(payload);
    if ((event.eventType === "output" || event.eventType === "transient_output") && outputBase64) {
      setOutputChunks((current) => appendBounded(current, decodeBase64Utf8(outputBase64)));
    } else if (event.eventType === "resync_required") {
      cursor.current = undefined;
      try { localStorage.removeItem(cursorKey(open)); } catch { /* persistence is best effort */ }
      setOutputChunks([]);
      setResetVersion((current) => current + 1);
      setNotice(t("session.resynced"));
      setAttachEpoch((current) => current + 1);
    } else if (event.eventType === "exit") {
      setConnectionLabel("ended");
      setNotice((payload.groupCleaned ?? payload.group_cleaned) ? t("session.endedCleanly") : t("session.cleanupUnverified"));
    } else if (event.eventType === "input_batch_ack") {
      const batchId = (payload as SessionEventPayload & { batchId?: string }).batchId;
      if (batchId && !ownBatches.current.delete(batchId)) {
        setOtherClientInput(true);
        window.clearTimeout(otherInputTimer.current);
        otherInputTimer.current = window.setTimeout(() => setOtherClientInput(false), 1_500);
      }
    }
  }, [client, open, t]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribeEvents: (() => Promise<void>) | undefined;
    let unsubscribeConnection: (() => Promise<void>) | undefined;
    let attached: string | undefined;
    setConnectionLabel("attaching");
    setInputReady(false);
    setError("");
    void client.subscribe<SessionEventPayload>(open.hostProfileId, [], handleEvent).then(async (unsubscribe) => {
      if (cancelled) return unsubscribe();
      unsubscribeEvents = unsubscribe;
      try {
        const result = await client.request<SessionAttachResult>(open.hostProfileId, "session.attach", {
          sessionId: open.session.id,
          replayTailBytes: 512 * 1024,
          resumeFrom: cursor.current,
          subscribeOutput: true,
        });
        if (cancelled) {
          await client.request(open.hostProfileId, "session.detach", { attachmentId: result.attachmentId }).catch(() => undefined);
          return;
        }
        attached = result.attachmentId;
        attachmentRef.current = attached;
        geometryRef.current = result.terminalGeometry;
        setTerminalGeometry(result.terminalGeometry);
        // Opening a Session from Mobile is an explicit request to adapt it for
        // the phone, even when desktop owned the previous revision.
        resizeOwnershipEnabled.current = true;
        setAttachmentId(attached);
        setConnectionLabel(result.childAlive ? "adapting" : "ended");
      } catch (requestError) {
        if (!cancelled) {
          setConnectionLabel("failed");
          setError(errorText(requestError));
        }
      }
    }).catch((subscribeError) => {
      if (!cancelled) {
        setConnectionLabel("failed");
        setError(errorText(subscribeError));
      }
    });
    void client.onConnectionState((event) => {
      if (event.profileId !== open.hostProfileId) return;
      if (event.state === "reconnecting" || event.state === "disconnected" || event.state === "failed") {
        needsReattach.current = true;
        setConnectionLabel("reconnecting");
      }
      if (event.state === "connected" && needsReattach.current) {
        needsReattach.current = false;
        setAttachEpoch((value) => value + 1);
      }
    }).then((unsubscribe) => {
      if (cancelled) void unsubscribe();
      else unsubscribeConnection = unsubscribe;
    });
    return () => {
      cancelled = true;
      setAttachmentId(undefined);
      if (attachmentRef.current === attached) attachmentRef.current = undefined;
      if (attached) void client.request(open.hostProfileId, "session.detach", { attachmentId: attached }).catch(() => undefined);
      if (unsubscribeEvents) void unsubscribeEvents();
      if (unsubscribeConnection) void unsubscribeConnection();
    };
  }, [attachEpoch, client, handleEvent, open.hostProfileId, open.session.id]);

  useEffect(() => () => {
    window.clearTimeout(otherInputTimer.current);
    window.clearTimeout(seenTimer.current);
  }, []);

  const sendInput = useCallback((data: string) => {
    if (!attachmentId || !inputReady) {
      setError("终端仍在适配手机尺寸");
      return;
    }
    const batchId = sessionBatchId();
    ownBatches.current.add(batchId);
    inputQueue.current = inputQueue.current.then(async () => {
      try {
        const result = await client.request<{ phase: string }>(open.hostProfileId, "session.input", { attachmentId, batchId, dataBase64: encodeBase64Utf8(data) });
        if (result.phase === "unknown") setError(t("session.inputUnknown"));
      } catch (requestError) {
        ownBatches.current.delete(batchId);
        setError(errorText(requestError));
      }
    });
  }, [attachmentId, client, inputReady, open.hostProfileId, t]);

  const control = async (controlName: "interrupt" | "continue") => {
    if (!attachmentId) return;
    await client.request(open.hostProfileId, "session.control", { attachmentId, control: controlName }).catch((requestError) => setError(errorText(requestError)));
  };

  // This is the single mobile -> Bridge resize seam. Host-side CAS ownership
  // keeps xterm/viewport observation separate from cross-client authority.
  const flushResize = useCallback(() => {
    resizeFrame.current = undefined;
    const size = pendingResize.current;
    if (!attachmentId || !size || !resizeOwnershipEnabled.current) return;
    if (lastResize.current?.attachmentId === attachmentId
      && lastResize.current.cols === size.cols
      && lastResize.current.rows === size.rows) return;
    lastResize.current = { attachmentId, ...size };
    void client.request<{ accepted: boolean; terminalGeometry: TerminalGeometry }>(open.hostProfileId, "session.control", {
      attachmentId,
      control: "resize",
      cols: size.cols,
      rows: size.rows,
      expectedRevision: geometryRef.current?.revision ?? 0,
      sourceKind: "mobile",
      sourceDeviceId: sourceDeviceId.current,
      orientation: globalThis.matchMedia?.("(orientation: landscape)").matches ? "landscape" : "portrait",
    }).then((result) => {
      geometryRef.current = result.terminalGeometry;
      setTerminalGeometry(result.terminalGeometry);
      setInputReady(true);
      setConnectionLabel("live");
    }).catch((requestError) => {
      lastResize.current = undefined;
      setError(errorText(requestError));
    });
  }, [attachmentId, client, open.hostProfileId]);

  const requestTerminalResize = useCallback((cols: number, rows: number) => {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return;
    pendingResize.current = { cols, rows };
    if (resizeFrame.current !== undefined) return;
    resizeFrame.current = window.requestAnimationFrame(flushResize);
  }, [flushResize]);

  const readaptForPhone = useCallback(() => {
    resizeOwnershipEnabled.current = true;
    setInputReady(false);
    setConnectionLabel("adapting");
    lastResize.current = undefined;
    if (pendingResize.current) requestTerminalResize(pendingResize.current.cols, pendingResize.current.rows);
  }, [requestTerminalResize]);

  useEffect(() => {
    lastResize.current = undefined;
    if (attachmentId && pendingResize.current) requestTerminalResize(pendingResize.current.cols, pendingResize.current.rows);
  }, [attachmentId, requestTerminalResize]);

  useEffect(() => () => {
    if (resizeFrame.current !== undefined) window.cancelAnimationFrame(resizeFrame.current);
  }, []);

  const action = async (name: "restart" | "pin" | "archive" | "rename", value?: string) => {
    setBusyAction(name);
    setError("");
    try {
      if (name === "restart") await client.request(open.hostProfileId, "session.restart", { sessionId: open.session.id, riskAck: false });
      if (name === "pin") await client.request(open.hostProfileId, "session.pin", { sessionId: open.session.id, pinned: !open.session.pinnedAt });
      if (name === "archive") await client.request(open.hostProfileId, "session.archive", { sessionId: open.session.id });
      if (name === "rename" && value) await client.request(open.hostProfileId, "session.rename", { sessionId: open.session.id, title: value });
      if (name === "archive") {
        onSessionChanged();
        onClose();
      } else {
        const sessions = await client.request<OpenSession["session"][]>(open.hostProfileId, "session.list", { includeArchived: false });
        const updated = sessions.find((session) => session.id === open.session.id);
        if (updated) onSessionChanged({ ...open, session: updated });
        if (name === "restart") setAttachEpoch((current) => current + 1);
      }
    } catch (requestError) {
      setError(errorText(requestError));
    } finally {
      setBusyAction("");
    }
  };

  const stop = async () => {
    setBusyAction("stop");
    try {
      const result = await client.request<{ groupCleaned: boolean }>(open.hostProfileId, "session.stop", { sessionId: open.session.id, graceMs: 1_500 });
      setNotice(result.groupCleaned ? t("session.stopped") : t("session.cleanupUnverified"));
      setConfirmStop(false);
    } catch (requestError) {
      setError(errorText(requestError));
    } finally {
      setBusyAction("");
    }
  };

  return (
    <article className="session-workspace" aria-labelledby="session-title">
      <header className="session-workspace-header">
        <button className="terminal-back-button" type="button" onClick={onClose} aria-label={t("session.back")}>‹</button>
        <div><h1 id="session-title">{open.session.title}</h1><p>{open.hostName} · {open.session.projectId} · {open.session.adapterType}</p></div>
        <div className="terminal-header-actions">
          <span className={`live-pill ${connectionLabel}`}>{t(`session.connection.${connectionLabel}`)}</span>
          <button className="terminal-more-button" type="button" aria-label={t("session.actions")} aria-haspopup="dialog" onClick={() => setActionsOpen(true)}>•••</button>
        </div>
      </header>
      {otherClientInput ? <div className="ephemeral-notice" role="status">{t("session.otherClientTyping")}</div> : null}
      {notice ? <div className="ephemeral-notice" role="status">{notice}</div> : null}
      {error ? <div className="inline-error" role="alert">{error}</div> : null}
      {terminalGeometry?.sourceKind === "desktop" ? <div className="geometry-notice" role="status"><span>桌面端已恢复 {terminalGeometry.cols}×{terminalGeometry.rows}</span><button type="button" onClick={readaptForPhone}>重新适配手机</button></div> : null}
      {terminalGeometry?.sourceKind === "mobile" ? <span className="visually-hidden" aria-label="Phone terminal size">手机尺寸 {terminalGeometry.cols}×{terminalGeometry.rows}</span> : null}

      <MobileTerminal
        outputChunks={outputChunks}
        resetVersion={resetVersion}
        resizeEpoch={attachmentId}
        onInput={sendInput}
        onResize={requestTerminalResize}
        fontSize={fontSize}
        title={t("session.fullTerminal")}
        description={t("session.terminalDescription")}
        showHeading={false}
      />

      {actionsOpen ? <div className="modal-backdrop terminal-actions-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setActionsOpen(false); }}><section className="modal-sheet terminal-actions-sheet" role="dialog" aria-modal="true" aria-labelledby="terminal-actions-title"><header><div><h2 id="terminal-actions-title">{open.session.title}</h2><p>{open.session.lifecycle} · {open.session.permissionMode}</p></div><button type="button" aria-label={t("common.close")} onClick={() => setActionsOpen(false)}>×</button></header><div className="terminal-action-grid"><button type="button" onClick={() => void control("interrupt")}>{t("session.interrupt")}</button><button type="button" onClick={() => setFontSize((value) => Math.max(11, value - 1))}>A−</button><button type="button" onClick={() => setFontSize((value) => Math.min(24, value + 1))}>A+</button><button type="button" disabled={Boolean(busyAction)} onClick={() => void action("restart")}>{t("session.restart")}</button><button type="button" disabled={Boolean(busyAction)} onClick={() => void action("pin")}>{open.session.pinnedAt ? t("session.unpin") : t("session.pin")}</button><button type="button" disabled={Boolean(busyAction)} onClick={() => { const title = window.prompt(t("session.renamePrompt"), open.session.title); if (title?.trim()) void action("rename", title.trim()); }}>{t("session.rename")}</button><button type="button" disabled={Boolean(busyAction)} onClick={() => void action("archive")}>{t("session.archive")}</button><button className="danger-text" type="button" onClick={() => { setActionsOpen(false); setConfirmStop(true); }}>{t("session.stop")}</button></div></section></div> : null}

      {confirmStop ? <div className="modal-backdrop"><section className="modal-sheet compact" role="dialog" aria-modal="true" aria-labelledby="stop-title"><h2 id="stop-title">{t("session.stopTitle")}</h2><p>{t("session.stopBody")}</p><div className="modal-actions"><button type="button" onClick={() => setConfirmStop(false)}>{t("common.cancel")}</button><button className="danger-button" type="button" disabled={busyAction === "stop"} onClick={() => void stop()}>{t("session.stop")}</button></div></section></div> : null}
    </article>
  );
}
