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
import { decodeBase64Bytes, encodeBase64Utf8, outputBase64Of, sessionBatchId, sessionIdOf } from "./sessionProtocol";
import type { OpenSession, RunCursor, SessionAttachResult, SessionEventPayload, TerminalGeometry } from "./types";

const MOBILE_DEVICE_ID_KEY = "agentport-mobile-v2:device-id";
// Service caps this at 4 MiB. Mobile cannot page earlier PTY bytes yet, so
// request the largest bounded replay window to make upward log review useful.
const MOBILE_ATTACH_REPLAY_TAIL_BYTES = 4 * 1024 * 1024;

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
  const [branchName, setBranchName] = useState<string>();
  const [restartRequested, setRestartRequested] = useState(false);
  const [locallyStopped, setLocallyStopped] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const actionBusy = useRef(false);
  const stopped = ["stopped", "exited", "interrupted"].includes(open.session.lifecycle) || open.session.hostAlive === false;
  const shouldAttach = (!stopped && !locallyStopped) || restartRequested;
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
  const resizeInFlight = useRef<string>();
  const geometryRef = useRef<TerminalGeometry>();
  const outputFrame = useRef<number>();
  const pendingOutputChunks = useRef<Uint8Array[]>([]);
  const pendingOutputBytes = useRef(0);
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

  const flushTerminalOutput = useCallback(() => {
    outputFrame.current = undefined;
    const chunks = pendingOutputChunks.current;
    if (chunks.length === 0) return;
    pendingOutputChunks.current = [];
    const totalBytes = pendingOutputBytes.current;
    pendingOutputBytes.current = 0;
    if (chunks.length === 1) {
      terminal.current?.write(chunks[0]);
      return;
    }
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    terminal.current?.write(merged);
  }, []);

  const scheduleTerminalOutput = useCallback((chunk: Uint8Array) => {
    pendingOutputChunks.current.push(chunk);
    pendingOutputBytes.current += chunk.byteLength;
    if (outputFrame.current !== undefined) return;
    outputFrame.current = window.requestAnimationFrame(flushTerminalOutput);
  }, [flushTerminalOutput]);

  useEffect(() => () => {
    if (outputFrame.current !== undefined) window.cancelAnimationFrame(outputFrame.current);
    outputFrame.current = undefined;
    pendingOutputChunks.current = [];
    pendingOutputBytes.current = 0;
  }, []);

  const handleEvent = useCallback((event: RemoteEvent<SessionEventPayload>) => {
    const payload = event.payload;
    const attachmentGap = event.eventType === "resync_required" && event.subscriptionId === attachmentRef.current;
    if (sessionIdOf(payload) !== open.session.id && !attachmentGap) return;
    if (event.cursor && typeof event.cursor === "object") {
      cursor.current = event.cursor as RunCursor;
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
      // xterm already owns the bounded scrollback. Coalesce bursts to one
      // renderer write per frame so mobile touch scrolling is not competing
      // with hundreds of small xterm parse/render tasks.
      scheduleTerminalOutput(decodeBase64Bytes(outputBase64));
    } else if (event.eventType === "resync_required") {
      flushTerminalOutput();
      cursor.current = undefined;
      terminal.current?.reset();
      setNotice(t("session.resynced"));
      setAttachEpoch((current) => current + 1);
    } else if (event.eventType === "exit") {
      flushTerminalOutput();
      setLocallyStopped(true);
      setRestartRequested(false);
      setTerminalGeometry(undefined);
      setConnectionLabel("ended");
      setNotice((payload.groupCleaned ?? payload.group_cleaned) ? "" : t("session.cleanupUnverified"));
    } else if (event.eventType === "input_batch_ack") {
      const batchId = (payload as SessionEventPayload & { batchId?: string }).batchId;
      if (batchId && !ownBatches.current.delete(batchId)) {
        setOtherClientInput(true);
        window.clearTimeout(otherInputTimer.current);
        otherInputTimer.current = window.setTimeout(() => setOtherClientInput(false), 1_500);
      }
    }
  }, [client, flushTerminalOutput, open.hostProfileId, open.session.id, scheduleTerminalOutput, t]);

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
          replayTailBytes: MOBILE_ATTACH_REPLAY_TAIL_BYTES,
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
        if (!result.childAlive) { setLocallyStopped(true); setRestartRequested(false); }
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

  // Exit tears down the run-scoped subscription. While its ended page is
  // visible, reconcile durable state so a restart by another client is seen.
  // This is read + attach only: never launch or replay a lifecycle mutation.
  useEffect(() => {
    if (!active || connectionLabel !== "ended" || busyAction) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const reconcile = async () => {
      try {
        const sessions = await client.request<OpenSession["session"][]>(open.hostProfileId, "session.list", { includeArchived: false });
        if (cancelled || actionBusy.current) return;
        const session = sessions.find(value => value.id === open.session.id);
        if (session?.hostAlive === true && ["running", "creating"].includes(session.lifecycle)) {
          cursor.current = undefined;
          terminal.current?.reset();
          setNotice("");
          setLocallyStopped(false);
          setRestartRequested(true);
          onSessionChanged({ ...open, session });
          setAttachEpoch(value => value + 1);
          return;
        }
      } catch { /* An unavailable read is not evidence of a restart. */ }
      if (!cancelled) timer = setTimeout(reconcile, 2000);
    };
    timer = setTimeout(reconcile, 2000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active, busyAction, client, connectionLabel, onSessionChanged, open]);

  const sendInput = useCallback((data: string) => {
    if (busyAction === "stop" || !attachmentId || attachmentRef.current !== attachmentId || connectionLabel !== "live") return;
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
  }, [attachmentId, client, open.hostProfileId, t, connectionLabel, busyAction]);

  // This is the single mobile -> Bridge resize seam. Host-side CAS ownership
  // keeps xterm/viewport observation separate from cross-client authority.
  const flushResize = useCallback((): void => {
    resizeFrame.current = undefined;
    const size = pendingResize.current;
    if (!attachmentId || !size || !resizeOwnershipEnabled.current || resizeInFlight.current === attachmentId) return;
    if (lastResize.current?.attachmentId === attachmentId
      && lastResize.current.cols === size.cols
      && lastResize.current.rows === size.rows) return;
    lastResize.current = { attachmentId, ...size };
    resizeInFlight.current = attachmentId;
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
      if (attachmentRef.current !== attachmentId) return;
      // A desktop ownership event may arrive before this older mobile reply.
      if (result.terminalGeometry.revision < (geometryRef.current?.revision ?? 0)) return;
      geometryRef.current = result.terminalGeometry;
      setTerminalGeometry(result.terminalGeometry);
      setConnectionLabel("live");
    }).catch(() => {
      // Do not replay an uncertain resize. A newer observed size may proceed.
      if (attachmentRef.current === attachmentId) lastResize.current = undefined;
    }).finally(() => {
      if (resizeInFlight.current !== attachmentId) return;
      resizeInFlight.current = undefined;
      // Keyboard animation spans frames: coalesce while awaiting the Host CAS
      // acknowledgment, then send only the latest size using its new revision.
      if (attachmentRef.current === attachmentId && pendingResize.current !== size
        && resizeOwnershipEnabled.current && resizeFrame.current === undefined) {
        resizeFrame.current = window.requestAnimationFrame(flushResize);
      }
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

  const stopCurrentSession = async () => {
    const result = await client.request<{ groupCleaned: boolean }>(open.hostProfileId, "session.stop", { sessionId: open.session.id, graceMs: 1_500 });
    setNotice(result.groupCleaned ? "" : t("session.cleanupUnverified"));
    setLocallyStopped(true);
    setRestartRequested(false);
    setTerminalGeometry(undefined);
    onSessionChanged({ ...open, session: { ...open.session, lifecycle: "stopped", hostAlive: false } });
    attachmentRef.current = undefined;
    setAttachmentId(undefined);
    setConnectionLabel("ended");
  };

  const action = async (name: "restart" | "pin" | "rename", value?: string) => {
    if (actionBusy.current) return;
    actionBusy.current = true;
    setBusyAction(name);
    setError("");
    try {
      if (name === "restart") {
        // The service only restarts ended sessions. Respect local Stop/exit and
        // successful Restart state too: parent summaries can still be stale.
        // A failed/unknown Stop must abort here, never replay or launch anyway.
        if (shouldAttach) await stopCurrentSession();
        await client.request(open.hostProfileId, "session.restart", { sessionId: open.session.id, riskAck: true });
        cursor.current = undefined;
        terminal.current?.reset();
        setNotice("");
        setLocallyStopped(false);
        setRestartRequested(true);
        setActionsOpen(false);
        onSessionChanged({ ...open, session: { ...open.session, lifecycle: "running", hostAlive: true } });
        setAttachEpoch(current => current + 1);
      }
      if (name === "pin") await client.request(open.hostProfileId, "session.pin", { sessionId: open.session.id, pinned: !open.session.pinnedAt });
      if (name === "rename" && value) {
        await client.request(open.hostProfileId, "session.rename", { sessionId: open.session.id, title: value });
        setRenaming(false);
        onSessionChanged({ ...open, session: { ...open.session, title: value } });
      }
      // A failed read after an acknowledged mutation must not look like a failed
      // Restart/Rename and invite the user to repeat that mutation.
      const sessions = await client.request<OpenSession["session"][]>(open.hostProfileId, "session.list", { includeArchived: false }).catch(() => undefined);
      const updated = sessions?.find(session => session.id === open.session.id);
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
    setRenaming(false);
    window.requestAnimationFrame(() => actionsTrigger.current?.focus());
  };

  const stop = async () => {
    if (actionBusy.current) return;
    actionBusy.current = true;
    setBusyAction("stop");
    setActionsOpen(false);
    setError("");
    try {
      await stopCurrentSession();
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
        {error && !actionsOpen ? <div className="terminal-status-line inline-error" role="alert">{error}</div> : null}
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
        obscured={busyAction === "stop"}
      /> : null}

      {actionsOpen ? <Modal title={open.session.title} onClose={closeActions} className="terminal-actions-sheet" blurBackdrop={false}
        titleContent={renaming ? <span className="session-title-editor">
          <input autoFocus aria-label={t("session.renamePrompt")} value={renameTitle} maxLength={256} disabled={Boolean(busyAction)}
            onChange={event => setRenameTitle(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing && renameTitle.trim()) { event.preventDefault(); void action("rename", renameTitle.trim()); } }} />
          <button type="button" aria-label={t("common.save")} title={t("common.save")} disabled={Boolean(busyAction) || !renameTitle.trim()} onClick={() => void action("rename", renameTitle.trim())}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4L19 6" /></svg></button>
          <button type="button" aria-label={t("common.cancel")} title={t("common.cancel")} disabled={Boolean(busyAction)} onClick={() => setRenaming(false)}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5 4 10l5 5M4 10h10a5 5 0 0 1 0 10" /></svg></button>
        </span> : undefined}>
          {error ? <p role="alert" className="inline-error">{error}</p> : null}
          <p className="terminal-project-branch">{[open.projectName ?? open.session.projectId, branchName].filter(Boolean).join(" · ")}</p>
          <h3 className="terminal-session-actions-title">{t("session.actions")}</h3>
          <div className="terminal-action-grid">
            <button type="button" disabled={Boolean(busyAction)} onClick={() => { setRenameTitle(open.session.title); setRenaming(true); setError(""); }}>{t("session.rename")}</button>
            <button type="button" disabled={Boolean(busyAction)} onClick={() => void action("pin")}>{open.session.pinnedAt ? t("session.unpin") : t("session.pin")}</button>
            <button type="button" disabled={Boolean(busyAction)} onClick={() => void action("restart")}>{t("session.restart")}</button>
            <button className="danger-text" type="button" disabled={Boolean(busyAction)} onClick={() => void stop()}>{t("session.stop")}</button>
            <button type="button" onClick={() => setFontSize(value => Math.max(11, value - 1))}>A−</button>
            <button type="button" onClick={() => setFontSize(value => Math.min(24, value + 1))}>A+</button>
          </div>
      </Modal> : null}
    </article>
  );
}
