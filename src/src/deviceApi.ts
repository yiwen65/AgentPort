// Per-device API routing for terminal panes and background Session actions.
// The global `api` proxy still follows the active device for workspace-wide
// panels; anything already bound to a device must use these helpers.

import * as apiModule from "./api";
import { remoteBackendFor } from "./remote/runtime";
import { LOCAL_DEVICE_KEY } from "./sessionIdentity";
import type {
  AttachInfo,
  ChannelMsg,
  HistoryPage,
  LogCursorView,
  ProjectView,
  RestartResult,
  SessionView,
  StatusCursorView,
} from "./types";
import type { CreateSessionResult } from "./types";
import type { ExportArgs } from "./api";

export interface DeviceTerminalApi {
  attachSession: (
    sessionId: string,
    replayTailBytes: number,
    channel: unknown,
    resumeFrom?: LogCursorView | null,
    screenSnapshot?: boolean,
  ) => Promise<AttachInfo>;
  detachSession: (
    sessionId: string,
    attachmentId: number | string,
  ) => Promise<void>;
  sendInput: (sessionId: string, data: string) => Promise<void>;
  resizePty: (
    sessionId: string,
    cols: number,
    rows: number,
    pixelWidth: number,
    pixelHeight: number,
    authority?: unknown,
  ) => Promise<void>;
  getNativeHistory: (
    sessionId: string,
    cursor: string | null,
    limit?: number,
  ) => Promise<HistoryPage>;
  markSessionLogRendered: (
    sessionId: string,
    attachmentId: number | string,
    cursor: LogCursorView,
  ) => Promise<void>;
  markSessionOutputUnread: (
    sessionId: string,
    offset: number,
    cursor: LogCursorView | null,
  ) => Promise<void>;
  autoRenameSessionFromFirstInput: (
    sessionId: string,
    input: string,
  ) => Promise<boolean>;
  /** Only used by terminal attach recovery; the workspace tree stays active-device scoped. */
  listProjects: (activeSession: string | null) => Promise<ProjectView[]>;
}

export interface DeviceSessionApi {
  renameSession: (sessionId: string, title: string) => Promise<void>;
  setSessionPinned: (sessionId: string, pinned: boolean) => Promise<void>;
  archiveSession: (sessionId: string) => Promise<void>;
  deleteArchivedSession: (sessionId: string) => Promise<void>;
  stopSession: (sessionId: string) => Promise<void>;
  interruptSession: (sessionId: string) => Promise<void>;
  resumeSession: (sessionId: string) => Promise<void>;
  restartSession: (sessionId: string, riskAck: boolean) => Promise<RestartResult>;
  markSessionSeen: (
    sessionId: string,
    cursor: StatusCursorView | null,
  ) => Promise<void>;
  createSession: (args: Record<string, unknown>) => Promise<CreateSessionResult>;
  exportSession: (args: ExportArgs) => Promise<string>;
}

export function isLocalDeviceId(deviceId: string): boolean {
  return deviceId === LOCAL_DEVICE_KEY;
}

/**
 * Tests commonly mock `api` partially and omit the separate `localApi` export;
 * falling back to the same object keeps the routed-local contract observable
 * without requiring every historical fixture to grow a new export.
 */
export function localDeviceApi(): typeof apiModule.api {
  try {
    const candidate = (apiModule as { localApi?: typeof apiModule.api })
      .localApi;
    if (candidate) return candidate;
  } catch {
    // Vitest's mock proxy throws for exports a partial mock omits.
  }
  return apiModule.api;
}

function apiForDevice(deviceId: string): unknown {
  return isLocalDeviceId(deviceId) ? localDeviceApi() : remoteBackendFor(deviceId);
}

export function deviceTerminalApiFor(deviceId: string): DeviceTerminalApi {
  return apiForDevice(deviceId) as DeviceTerminalApi;
}

export function deviceSessionApiFor(deviceId: string): DeviceSessionApi {
  return apiForDevice(deviceId) as DeviceSessionApi;
}

/** Raw Channel factory for local attaches (remote accepts the same shape). */
export type { ChannelMsg, SessionView };
