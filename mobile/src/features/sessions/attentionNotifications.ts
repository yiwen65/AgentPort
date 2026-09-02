import { isTauri } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { isSystemNotificationKind } from "./sessionModel";
import type { AttentionEvent } from "./types";

export interface AttentionNotificationSink {
  notify(title: string, body: string, tag: string): Promise<void> | void;
}

export function attentionEventKey(event: AttentionEvent): string {
  return `${event.sessionId}:${event.runId}:${event.runOrdinal}:${event.sequence}:${event.kind}`;
}

export async function deliverAttentionNotifications(
  events: readonly AttentionEvent[],
  delivered: Set<string>,
  sink: AttentionNotificationSink,
): Promise<number> {
  let count = 0;
  for (const event of events) {
    if (!isSystemNotificationKind(event.kind)) continue;
    const key = attentionEventKey(event);
    if (delivered.has(key)) continue;
    const body = event.kind === "approval_requested" ? "请求批准" : "任务已完成";
    await sink.notify(event.sessionTitle ?? "AgentPort", body, key);
    delivered.add(key);
    count += 1;
  }
  return count;
}

/** Browser fallback; native shells can inject a platform sink with the same contract. */
export class WebNotificationSink implements AttentionNotificationSink {
  async notify(title: string, body: string, tag: string): Promise<void> {
    if (!("Notification" in globalThis)) throw new Error("System notifications are unavailable on this device");
    if (Notification.permission === "default") await Notification.requestPermission();
    if (Notification.permission !== "granted") throw new Error("System notification permission was not granted");
    new Notification(title, { body, tag });
  }
}

export class SystemNotificationSink implements AttentionNotificationSink {
  async notify(title: string, body: string, tag: string): Promise<void> {
    if (isTauri()) {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (!granted) throw new Error("System notification permission was not granted");
      sendNotification({ title, body });
      return;
    }
    await new WebNotificationSink().notify(title, body, tag);
  }
}
