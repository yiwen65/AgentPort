import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Modal } from "../../components/Modal";
import { useTranslation } from "react-i18next";
import type { RemoteClient, RemoteEvent } from "../../protocol/remoteClient";
import { MobileTerminal, type MobileTerminalHandle } from "../../terminal/MobileTerminal";
import {
  getMobileTerminalPalette,
  getMobileTerminalWorkspaceVariables,
} from "../../terminal/terminalThemes";
import { useMobileTerminalAppearance } from "../../terminal/terminalAppearance";
import { decodeBase64Utf8, encodeBase64Utf8, outputBase64Of, sessionBatchId, sessionIdOf } from "./sessionProtocol";
import type { OpenSession, RunCursor, SessionAttachResult, SessionEventPayload, TerminalGeometry } from "./types";

const CURSOR_PREFIX = "agentport-mobile-session-cursor-v1:";
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

function errorText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

export function SessionWorkspace({ open, client, active = true, onClose, onSessionChanged, onOpened }: {
  open: OpenSession;
  active?: boolean;
  onOpened?: (session: OpenSession) => void;
  client: RemoteClient;
  onClose: () => void;
  onSessionChanged: (next?: OpenSession) => void;
}) {
  const { t } = useTranslation();
  const [attachmentId, setAttachmentId] = useState<string>();
  const [connectionLabel, setConnectionLabel] = useState("attaching");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [otherClientInput, setOtherClientInput] = useState(false);
  const [attachEpoch, setAttachEpoch] = useState(0);
  const [fontSize, setFontSize] = useState(15);
  const [terminalAppearance, , resolvedMode] = useMobileTerminalAppearance();
  const [chromeVisible, setChromeVisible] = useState(false);
  const chromeReveal = useRef<HTMLButtonElement>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [branchName, setBranchName] = useState<string>();
  const [restartRequested, setRestartRequested] = useState(false);
  const actionBusy = useRef(false);
  const stopped = ["stopped", "exited", "interrupted"].includes(open.session.lifecycle) || open.session.hostAlive === false;
  const shouldAttach = !stopped || restartRequested;
  const activeRef = useRef(active);
  activeRef.current = active;
  const openedRef = useRef("");
  const onOpenedRef = useRef(onOpened);
  onOpenedRef.current = onOpened;
  const [actionsOpen, setActionsOpen] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [terminalGeometry, setTerminalGeometry] = useState<TerminalGeometry>();
  const actionsTrigger = useRef<HTMLButtonElement>(null);
  // A fresh xterm has no retained screen to pair with a persisted tail cursor,
  // so it must request a bounded replay. This ref still advances and resumes
  // efficiently for reconnects during this renderer's lifetime.
  const terminal = useRef<MobileTerminalHandle>(null);
  const cursor = useRef<RunCursor>();
  const ownBatches = useRef(new Set<string>());
  const attachmentRef = useRef<string>();
  const inputDispatchQueue = useRef(Promise.resolve());
  const otherInputTimer = useRef<number>();
  const seenTimer = useRef<number>();
  const needsReattach = useRef(false);
  const pendingResize = useRef<{ cols: number; rows: number }>();
  const lastResize = useRef<{ attachmentId: string; cols: number; rows: number }>();
  const resizeFrame = useRef<number>();
  const geometryRef = useRef<TerminalGeometry>();
  const resizeOwnershipEnabled = useRef(true);
  const sourceDeviceId = useRef(mobileDeviceId());
  const terminalPalette = getMobileTerminalPalette(terminalAppearance.theme, resolvedMode);
  const terminalWorkspaceStyle = {
    ...getMobileTerminalWorkspaceVariables(terminalAppearance.theme, resolvedMode),
    colorScheme: resolvedMode,
  } as CSSProperties;

  useEffect(() => {
    setChromeVisible(false);
    setActionsOpen(false);
    setConfirmStop(false);
  }, [active]);

  useEffect(() => {
    if (!active) { openedRef.current = ""; return; }
    if (!["live", "ended"].includes(connectionLabel)) return;
    const key = JSON.stringify([open.hostProfileId, open.session.id, open.session.latestStatus?.runOrdinal, open.session.latestStatus?.sequence]);
    if (openedRef.current === key) return;
    openedRef.current = key;
    onOpenedRef.current?.(open);
  }, [active, connectionLabel, open]);

  useEffect(() => {
    let cancelled = false;
    setBranchName(undefined);
    void client.request<{ actualBranch?: string; expectedBranch?: string }>(open.hostProfileId, "git.context.resolve", { locator: { kind: "session", sessionId: open.session.id } })
      .then(value => { if (!cancelled) setBranchName(value?.actualBranch ?? value?.expectedBranch); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [client, open.hostProfileId, open.session.id]);

  const hideChrome = () => {
    setChromeVisible(false);
    // Keep keyboard focus reachable without focusing xterm's input/keyboard.
    window.requestAnimationFrame(() => chromeReveal.current?.focus({ preventScroll: true }));
  };

  const handleEvent = useCallback((event: RemoteEvent<SessionEventPayload>) => {
    const payload = event.payload;
    const attachmentGap = event.eventType === "resync_required" && event.subscriptionId === attachmentRef.current;
    if (sessionIdOf(payload) !== open.session.id && !attachmentGap) return;
    if (event.cursor && typeof event.cursor === "object") {
      cursor.current = event.cursor as RunCursor;
      try { localStorage.setItem(cursorKey(open), JSON.stringify(cursor.current)); } catch { /* persistence is best effort */ }
    }
    if (event.eventType === "terminal_geometry_changed" && payload.geometry) {
      geometryRef.current = payload.geometry;
      setTerminalGeometry(payload.geometry);
      if (payload.geometry.sourceKind === "desktop") {
        resizeOwnershipEnabled.current = false;
      } else if (payload.geometry.sourceDeviceId === sourceDeviceId.current) {
        setConnectionLabel("live");
      }
    }
    if (activeRef.current && ["output", "replay_done", "state"].includes(event.eventType)) {
      window.clearTimeout(seenTimer.current);
      seenTimer.current = window.setTimeout(() => {
        const requests: Promise<unknown>[] = [];
        if (!activeRef.current) return;
        if (cursor.current) requests.push(client.request(open.hostProfileId, "session.output.unread.mark", { sessionId: open.session.id, cursor: cursor.current }));
        void Promise.allSettled(requests);
      }, 500);
    }
    const outputBase64 = outputBase64Of(payload);
    if ((event.eventType === "output" || event.eventType === "transient_output") && outputBase64) {
      // xterm already owns the bounded scrollback. Stream directly into it so
      // every output event does not clone retained output and rerender React.
      terminal.current?.write(decodeBase64Utf8(outputBase64));
    } else if (event.eventType === "resync_required") {
      cursor.current = undefined;
      try { localStorage.removeItem(cursorKey(open)); } catch { /* persistence is best effort */ }
      terminal.current?.reset();
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
  }, [client, open.hostProfileId, open.session.id, t]);

  useEffect(() => {
    if (!shouldAttach) { setConnectionLabel("ended"); setError(""); return; }
    let cancelled = false;
    let unsubscribeEvents: (() => Promise<void>) | undefined;
    let unsubscribeConnection: (() => Promise<void>) | undefined;
    let attached: string | undefined;
    attachmentRef.current = undefined;
    setAttachmentId(undefined);
    setConnectionLabel("attaching");
    setError("");
    void client.subscribe<SessionEventPayload>(open.hostProfileId, [], event => { if (!cancelled) handleEvent(event); }).then(async (unsubscribe) => {
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
        // Opening from Mobile requests phone geometry, but PTY input remains
        // available while that independent resize request is in flight.
        resizeOwnershipEnabled.current = true;
        setAttachmentId(attached);
        setConnectionLabel(result.childAlive ? "live" : "ended");
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
      if (cancelled || event.profileId !== open.hostProfileId) return;
      if (event.state === "reconnecting" || event.state === "disconnected" || event.state === "failed") {
        needsReattach.current = true;
        attachmentRef.current = undefined;
        setAttachmentId(undefined);
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
  }, [attachEpoch, client, handleEvent, open.hostProfileId, open.session.id, shouldAttach]);

  useEffect(() => () => {
    window.clearTimeout(otherInputTimer.current);
    window.clearTimeout(seenTimer.current);
  }, []);

  const sendInput = useCallback((data: string) => {
    if (!attachmentId || attachmentRef.current !== attachmentId || connectionLabel !== "live") return;
    const batchId = sessionBatchId();
    ownBatches.current.add(batchId);
    // Serialize only through the local transport write, not the remote result.
    // Bridge frames therefore retain input order without adding network RTT to
    // every later keystroke.
    inputDispatchQueue.current = inputDispatchQueue.current.then(() => new Promise<void>((submitted) => {
      if (attachmentRef.current !== attachmentId) { ownBatches.current.delete(batchId); submitted(); return; }
      let submissionReleased = false;
      const releaseSubmission = () => {
        if (submissionReleased) return;
        submissionReleased = true;
        submitted();
      };
      void client.request<{ phase: string }>(open.hostProfileId, "session.input", {
        attachmentId,
        batchId,
        dataBase64: encodeBase64Utf8(data),
      }, { onSubmitted: releaseSubmission }).then((result) => {
        ownBatches.current.delete(batchId);
        if (result.phase === "unknown") setError(t("session.inputUnknown"));
      }).catch((requestError) => {
        ownBatches.current.delete(batchId);
        setError(errorText(requestError));
      }).finally(releaseSubmission);
    }));
  }, [attachmentId, client, open.hostProfileId, t, connectionLabel]);

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
      setConnectionLabel("live");
    }).catch(() => {
      // Geometry adaptation is best-effort. A resize failure must not obscure
      // or disable the already-attached PTY; the next xterm resize may retry.
      lastResize.current = undefined;
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
    setError("");
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

  const action = async (name: "restart" | "pin" | "rename", value?: string) => {
    if (actionBusy.current) return;
    actionBusy.current = true;
    setBusyAction(name);
    setError("");
    try {
      if (name === "restart") {
        await client.request(open.hostProfileId, "session.restart", { sessionId: open.session.id, riskAck: false });
        cursor.current = undefined;
        terminal.current?.reset();
        setNotice("");
        setRestartRequested(true);
        setAttachEpoch(current => current + 1);
      }
      if (name === "pin") await client.request(open.hostProfileId, "session.pin", { sessionId: open.session.id, pinned: !open.session.pinnedAt });
      if (name === "rename" && value) await client.request(open.hostProfileId, "session.rename", { sessionId: open.session.id, title: value });
      const sessions = await client.request<OpenSession["session"][]>(open.hostProfileId, "session.list", { includeArchived: false });
      const updated = sessions.find(session => session.id === open.session.id);
      if (updated) onSessionChanged({ ...open, session: updated });
    } catch (requestError) {
      setError(errorText(requestError));
    } finally {
      actionBusy.current = false;
      setBusyAction("");
    }
  };

  const closeActions = () => {
    setActionsOpen(false);
    window.requestAnimationFrame(() => actionsTrigger.current?.focus());
  };

  const stop = async () => {
    if (actionBusy.current) return;
    actionBusy.current = true;
    setBusyAction("stop");
    try {
      const result = await client.request<{ groupCleaned: boolean }>(open.hostProfileId, "session.stop", { sessionId: open.session.id, graceMs: 1_500 });
      setNotice(result.groupCleaned ? t("session.stopped") : t("session.cleanupUnverified"));
      setConfirmStop(false);
      attachmentRef.current = undefined;
      setAttachmentId(undefined);
      setConnectionLabel("ended");
    } catch (requestError) {
      setError(errorText(requestError));
    } finally {
      actionBusy.current = false;
      setBusyAction("");
    }
  };

  return (
    <article
      className="session-workspace"
      aria-label={open.session.title}
      tabIndex={-1}
      data-chrome-visible={chromeVisible}
      onPointerDownCapture={(event) => {
        if (!(event.target as Element).closest(".session-workspace-header, .terminal-chrome-reveal, .modal-backdrop, .mobile-modal-portal")) setChromeVisible(false);
      }}
      data-connection-state={connectionLabel}
      data-terminal-theme={terminalAppearance.theme}
      data-terminal-theme-mode={resolvedMode}
      style={terminalWorkspaceStyle}
    >
      <button
        ref={chromeReveal}
        className="terminal-chrome-reveal"
        type="button"
        hidden={chromeVisible}
        aria-label={t("session.showControls")}
        aria-expanded={chromeVisible}
        aria-controls="session-chrome"
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => {
          setChromeVisible(true);
          // Touch only reveals an overlay: retain terminal input and keyboard.
          // Keyboard/assistive activation moves focus to the newly shown action.
          if (event.detail === 0) window.requestAnimationFrame(() => actionsTrigger.current?.focus({ preventScroll: true }));
        }}
      />
      <header id="session-chrome" className="session-workspace-header" hidden={!chromeVisible}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); hideChrome(); } }}>
        <h1 id="session-title" title={open.session.title}><button className="terminal-title-back" type="button" aria-label={t("session.back")} onClick={onClose}>{open.session.title}</button></h1>
        <button ref={actionsTrigger} className="terminal-more-button" type="button" aria-label={t("session.actions")} aria-haspopup="dialog" onClick={() => setActionsOpen(true)}>•••</button>
      </header>
      {otherClientInput || notice || error ? <div className="terminal-status-stack">
        {otherClientInput ? <div className="terminal-status-line ephemeral-notice" role="status">{t("session.otherClientTyping")}</div> : null}
        {notice ? <div className="terminal-status-line ephemeral-notice" role="status">{notice}</div> : null}
        {error ? <div className="terminal-status-line inline-error" role="alert">{error}</div> : null}
      </div> : null}

      {terminalGeometry?.sourceKind === "desktop" ? <button className="restore-phone-size-button" type="button" onClick={readaptForPhone} aria-label={t("session.restorePhoneSize")} title={t("session.restorePhoneSize")}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M10.5 5h3M11 18.5h2" /></svg></button> : null}

      {connectionLabel === "ended" ? <section className="terminal-ended" aria-labelledby="restart-session-title">
        <div className="restart-identity">
          <p className="restart-project"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z" /></svg><span>{open.projectName ?? open.session.projectId}</span></p>
          <h2 id="restart-session-title">{open.session.title}</h2>
        </div>
        <button className="session-restart-button" type="button" disabled={Boolean(busyAction)} aria-busy={busyAction === "restart"} onClick={() => void action("restart")}>
          <svg aria-hidden="true" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M25 12a10 10 0 1 0 1 7M25 5v7h-7" /></svg>
          <span>{t("session.restart")}</span>
        </button>
      </section> : null}
      {connectionLabel === "reconnecting" ? <p className="terminal-status-line" role="status">{t("status.reconnecting")}</p> : null}
      {connectionLabel === "failed" ? <button type="button" onClick={() => setAttachEpoch(value => value + 1)}>{t("session.retryAttach")}</button> : null}
      {shouldAttach ? <MobileTerminal
        ref={terminal}
        resizeEpoch={attachmentId}
        onInput={sendInput}
        onResize={requestTerminalResize}
        fontSize={fontSize}
        theme={terminalPalette.xterm}
        title={t("session.fullTerminal")}
        description={t("session.terminalDescription")}
        showHeading={false}
        showProbeOutput={false}
      /> : null}

      {actionsOpen ? <Modal title={open.session.title} onClose={closeActions} className="terminal-actions-sheet">
          <p className="terminal-project-branch">{[open.projectName ?? open.session.projectId, branchName].filter(Boolean).join(" · ")}</p>
          <h3 className="terminal-session-actions-title">{t("session.actions")}</h3>
          <div className="terminal-action-grid">
            <button type="button" disabled={Boolean(busyAction)} onClick={() => { const title = window.prompt(t("session.renamePrompt"), open.session.title); if (title?.trim()) void action("rename", title.trim()); }}>{t("session.rename")}</button>
            <button type="button" disabled={Boolean(busyAction)} onClick={() => void action("pin")}>{open.session.pinnedAt ? t("session.unpin") : t("session.pin")}</button>
            <button type="button" disabled={Boolean(busyAction)} onClick={() => void action("restart")}>{t("session.restart")}</button>
            <button className="danger-text" type="button" onClick={() => { setActionsOpen(false); setConfirmStop(true); }}>{t("session.stop")}</button>
            <button type="button" onClick={() => setFontSize(value => Math.max(11, value - 1))}>A−</button>
            <button type="button" onClick={() => setFontSize(value => Math.min(24, value + 1))}>A+</button>
          </div>
      </Modal> : null}

      {confirmStop ? <div className="modal-backdrop"><section className="modal-sheet compact" role="dialog" aria-modal="true" aria-labelledby="stop-title"><h2 id="stop-title">{t("session.stopTitle")}</h2><p>{t("session.stopBody")}</p><div className="modal-actions"><button type="button" onClick={() => setConfirmStop(false)}>{t("common.cancel")}</button><button className="danger-button" type="button" disabled={busyAction === "stop"} onClick={() => void stop()}>{t("session.stop")}</button></div></section></div> : null}
    </article>
  );
}
