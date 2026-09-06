// Structured Pi workspace. Pi RPC traffic is attached directly to the Host
// channel and never enters xterm's terminal-input path.

import { Channel } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, b64ToBytes, errorText } from "../api";
import { i18n } from "../i18n";
import { runtimeMessageEnvelope, runtimeMessageText } from "../runtimeMessages";
import type { ChannelMsg, RuntimeMessageEnvelope, SessionView } from "../types";

const REPLAY_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 800;

type TimelineEvent = Record<string, unknown>;
type PiFailure =
  | { kind: "runtime"; message: RuntimeMessageEnvelope }
  | { kind: "detached" }
  | { kind: "attach" | "send" | "abort"; detail: string };

const INITIAL_SESSION_CREATION_PREFIX = "Warning: No project session found with id '";
const INITIAL_SESSION_CREATION_SUFFIX = "'; creating a new session with that id.";

function textOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["text", "content", "message", "delta", "error", "status"]) {
      const candidate = record[key];
      if (typeof candidate === "string") return candidate;
    }
  }
  return null;
}

function eventLabel(event: TimelineEvent): string {
  const type = typeof event.type === "string" ? event.type : "event";
  if (type.includes("tool")) return i18n.t("runtime:pi.toolEvent", { type });
  if (type.includes("message") || type.includes("text")) return i18n.t("runtime:pi.textEvent");
  if (type.includes("queue") || type.includes("pending")) return i18n.t("runtime:pi.queueEvent");
  if (type === "response") {
    return i18n.t("runtime:pi.rpcResponse", { command: String(event.command ?? "unknown") });
  }
  return type;
}

function eventDetail(event: TimelineEvent): string {
  return (
    textOf(event) ??
    textOf(event.data) ??
    textOf(event.event) ??
    JSON.stringify(event)
  );
}

/** Hide Pi bootstrap control traffic while retaining all user-visible events. */
export function isVisiblePiTimelineEvent(event: TimelineEvent): boolean {
  const successfulGetState =
    event.type === "response" &&
    event.command === "get_state" &&
    event.success === true;
  if (successfulGetState) return false;

  const message = event.message;
  return !(
    event.type === "diagnostic" &&
    typeof message === "string" &&
    message.startsWith(INITIAL_SESSION_CREATION_PREFIX) &&
    message.endsWith(INITIAL_SESSION_CREATION_SUFFIX)
  );
}

export function parseReplay(
  chunk: Uint8Array,
  buffered: string,
  decoder: TextDecoder,
): { events: TimelineEvent[]; remainder: string } {
  const text = buffered + decoder.decode(chunk, { stream: true });
  const lines = text.split("\n");
  const remainder = lines.pop() ?? "";
  const events: TimelineEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const event = parsed as TimelineEvent;
        if (isVisiblePiTimelineEvent(event)) events.push(event);
      }
    } catch {
      // The append-only RPC log may contain an older diagnostic line; it is
      // intentionally not promoted to a structured timeline event.
    }
  }
  return { events, remainder };
}

export default function PiStructuredTimeline({ ses }: { ses: SessionView }) {
  const { t } = useTranslation("runtime");
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PiFailure | null>(null);
  const [attached, setAttached] = useState(false);
  const [ended, setEnded] = useState(false);
  const [attachAttempt, setAttachAttempt] = useState(0);
  const replaying = useRef(true);
  const replayBuffer = useRef("");
  const replayDecoder = useRef(new TextDecoder());

  useEffect(() => {
    if (ses.lifecycle === "running" || ses.lifecycle === "creating") setEnded(false);
  }, [ses.lifecycle]);

  useEffect(() => {
    let cancelled = false;
    let attachmentId: number | null = null;
    let attachmentEnded = false;
    replaying.current = true;
    replayBuffer.current = "";
    replayDecoder.current = new TextDecoder();
    setEvents([]);
    setFailure(null);
    setAttached(false);
    setEnded(false);
    const append = (incoming: TimelineEvent[]) => {
      if (!incoming.length) return;
      const visible = incoming.filter(isVisiblePiTimelineEvent);
      if (visible.length) setEvents((current) => [...current, ...visible].slice(-MAX_EVENTS));
    };
    const channel = new Channel<ChannelMsg>();
    channel.onmessage = (message) => {
      if (cancelled) return;
      if (message.t === "output" && replaying.current) {
        const parsed = parseReplay(
          b64ToBytes(message.data),
          replayBuffer.current,
          replayDecoder.current,
        );
        replayBuffer.current = parsed.remainder;
        append(parsed.events);
      } else if (message.t === "replay_done") {
        replaying.current = false;
        const finalLine = replayBuffer.current + replayDecoder.current.decode();
        if (finalLine.trim()) {
          try {
            const parsed: unknown = JSON.parse(finalLine);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) append([parsed as TimelineEvent]);
          } catch {
            // Partial final frame stays a diagnostic-only log artifact.
          }
        }
        replayBuffer.current = "";
      } else if (message.t === "structured") {
        append([message.event]);
      } else if (message.t === "error") {
        setFailure({ kind: "runtime", message });
      } else if (message.t === "exit") {
        attachmentEnded = true;
        setAttached(false);
        setEnded(true);
        setBusy(false);
      } else if (message.t === "detached") {
        attachmentEnded = true;
        attachmentId = null;
        setAttached(false);
        setFailure(message.code || message.message || message.technicalDetail
          ? { kind: "runtime", message }
          : { kind: "detached" });
      }
    };
    void api
      .attachSession(ses.id, REPLAY_TAIL_BYTES, channel)
      .then((info) => {
        if (cancelled) {
          void api.detachSession(ses.id, info.attachmentId).catch(() => undefined);
          return;
        }
        attachmentId = info.attachmentId;
        if (attachmentEnded || !info.childAlive) {
          setAttached(false);
          if (!info.childAlive) setEnded(true);
          void api.detachSession(ses.id, info.attachmentId).catch(() => undefined);
          attachmentId = null;
          return;
        }
        setAttached(true);
        setFailure(null);
      })
      .catch((cause) => {
        if (cancelled) return;
        const message = runtimeMessageEnvelope(cause);
        setFailure(message
          ? { kind: "runtime", message }
          : { kind: "attach", detail: errorText(cause) });
      });
    return () => {
      cancelled = true;
      if (attachmentId !== null) void api.detachSession(ses.id, attachmentId).catch(() => undefined);
    };
  }, [attachAttempt, ses.id, ses.lifecycle]);

  const send = async () => {
    const text = prompt.trim();
    if (!text) return;
    setBusy(true);
    setFailure(null);
    try {
      await api.sendStructuredPrompt(ses.id, text);
      setPrompt("");
    } catch (cause) {
      const message = runtimeMessageEnvelope(cause);
      setFailure(message
        ? { kind: "runtime", message }
        : { kind: "send", detail: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };

  const abort = async () => {
    setFailure(null);
    try {
      await api.abortStructuredTurn(ses.id);
      setBusy(false);
    } catch (cause) {
      const message = runtimeMessageEnvelope(cause);
      setFailure(message
        ? { kind: "runtime", message }
        : { kind: "abort", detail: errorText(cause) });
    }
  };

  const live = !ended && (ses.lifecycle === "running" || ses.lifecycle === "creating");
  const error = failure?.kind === "runtime"
    ? runtimeMessageText(failure.message)
    : failure?.kind === "attach"
      ? t("pi.attachFailed", { detail: failure.detail })
      : failure?.kind === "send"
        ? t("pi.sendFailed", { detail: failure.detail })
        : failure?.kind === "abort"
          ? t("pi.abortFailed", { detail: failure.detail })
          : failure?.kind === "detached"
            ? t("pi.detached")
          : null;
  return (
    <div className="pi-rpc-workspace" aria-label={t("pi.workspaceAria")}>
      <header className="pi-rpc-header">
        <div>
          <strong>{t("pi.header")}</strong>
          <span>
            {attached
              ? t("pi.connected")
              : live && failure
                ? t("pi.disconnected")
                : live
                  ? t("pi.connecting")
                  : t("pi.ended")}
          </span>
        </div>
        <span className="pi-rpc-permission">{t("pi.permission")}</span>
      </header>
      {error ? <div className="error-bar" role="alert">{error}</div> : null}
      {live && !attached && failure ? (
        <button className="btn small" type="button" onClick={() => setAttachAttempt((value) => value + 1)}>
          {t("pi.reconnect")}
        </button>
      ) : null}
      <ol className="pi-rpc-timeline" aria-live="polite">
        {events.length ? events.map((event, index) => (
          <li key={`${index}-${String(event.type ?? "event")}`} className="pi-rpc-event">
            <span>{eventLabel(event)}</span>
            <pre>{eventDetail(event)}</pre>
          </li>
        )) : <li className="dim">{t("pi.ready")}</li>}
      </ol>
      <form
        className="pi-rpc-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={prompt}
          placeholder={t("pi.placeholder")}
          disabled={!live || !attached}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <div>
          <button className="btn ghost" type="button" disabled={!live || !attached} onClick={() => void abort()}>
            {t("pi.abort")}
          </button>
          <button className="btn primary" type="submit" disabled={!prompt.trim() || !live || !attached || busy}>
            {busy ? t("pi.sending") : t("pi.send")}
          </button>
        </div>
      </form>
    </div>
  );
}
