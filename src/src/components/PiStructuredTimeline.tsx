// Structured Pi workspace. Pi RPC traffic is attached directly to the Host
// channel and never enters xterm's terminal-input path.

import { Channel } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { api, b64ToBytes, errorText } from "../api";
import type { ChannelMsg, SessionView } from "../types";

const REPLAY_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 800;

type TimelineEvent = Record<string, unknown>;

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
  if (type.includes("tool")) return `工具 · ${type}`;
  if (type.includes("message") || type.includes("text")) return "文本";
  if (type.includes("queue") || type.includes("pending")) return "队列";
  if (type === "response") return `RPC 响应 · ${String(event.command ?? "unknown")}`;
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
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attached, setAttached] = useState(false);
  const [ended, setEnded] = useState(false);
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
    setError(null);
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
        setError(message.message);
      } else if (message.t === "exit") {
        attachmentEnded = true;
        setAttached(false);
        setEnded(true);
        setBusy(false);
      } else if (message.t === "detached") {
        attachmentEnded = true;
        setAttached(false);
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
      })
      .catch((cause) => !cancelled && setError(errorText(cause)));
    return () => {
      cancelled = true;
      if (attachmentId !== null) void api.detachSession(ses.id, attachmentId).catch(() => undefined);
    };
  }, [ses.id]);

  const send = async () => {
    const text = prompt.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      await api.sendStructuredPrompt(ses.id, text);
      setPrompt("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const abort = async () => {
    setError(null);
    try {
      await api.abortStructuredTurn(ses.id);
      setBusy(false);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const live = !ended && (ses.lifecycle === "running" || ses.lifecycle === "creating");
  return (
    <div className="pi-rpc-workspace" aria-label="Pi 结构化会话">
      <header className="pi-rpc-header">
        <div>
          <strong>Pi · 结构化 RPC</strong>
          <span>{attached ? "已连接" : live ? "连接中" : "会话已结束"}</span>
        </div>
        <span className="pi-rpc-permission">无逐项权限确认，本地用户权限执行</span>
      </header>
      {error ? <div className="error-bar" role="alert">{error}</div> : null}
      <ol className="pi-rpc-timeline" aria-live="polite">
        {events.length ? events.map((event, index) => (
          <li key={`${index}-${String(event.type ?? "event")}`} className="pi-rpc-event">
            <span>{eventLabel(event)}</span>
            <pre>{eventDetail(event)}</pre>
          </li>
        )) : <li className="dim">Pi 已就绪，发送消息开始对话。</li>}
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
          placeholder="发送给 Pi…"
          disabled={!live || !attached}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <div>
          <button className="btn ghost" type="button" disabled={!live || !attached} onClick={() => void abort()}>
            中止当前轮次
          </button>
          <button className="btn primary" type="submit" disabled={!prompt.trim() || !live || !attached || busy}>
            {busy ? "发送中…" : "发送"}
          </button>
        </div>
      </form>
    </div>
  );
}
