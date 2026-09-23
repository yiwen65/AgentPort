// Structured errors for the remote backend. New desktop code.

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Stable feature tags consumed by remote-mode UI gating (T-010). */
export type RemoteFeatureTag =
  | "session.logRendered"
  | "session.outputUnreadCursor"
  | "document.rename"
  | "document.duplicate"
  | "document.delete"
  | "notification.rollback"
  | "backup.restore"
  | "export.options"
  | "os.revealInFileManager"
  | "os.openInSystemTerminal"
  | "os.openInVsCode"
  | "os.openWithDefaultApp";

/**
 * Thrown when a desktop api.ts function has no remote-protocol equivalent (or
 * the remote semantics diverge unsafely). The UI turns this into a disabled,
 * annotated control instead of a runtime failure.
 */
export class RemoteUnavailableError extends Error {
  readonly featureTag: RemoteFeatureTag;

  constructor(featureTag: RemoteFeatureTag, detail?: string) {
    super(
      `Feature unavailable on a remote device: ${featureTag}` +
        (detail ? ` (${detail})` : ""),
    );
    this.name = "RemoteUnavailableError";
    this.featureTag = featureTag;
  }
}

export function isRemoteUnavailableError(
  value: unknown,
): value is RemoteUnavailableError {
  return value instanceof RemoteUnavailableError;
}

/**
 * Normalized rejection of a remote_request call. The Rust transport rejects
 * with the protocol RemoteError ({code, message}) plus, when known, the
 * terminal ResultStatus; transport-level failures use synthesized codes
 * ("not_connected", "transport_closed", ...).
 */
export class RemoteRequestError extends Error {
  readonly code: string;
  readonly status?: string;

  constructor(code: string, message: string, status?: string) {
    super(message);
    this.name = "RemoteRequestError";
    this.code = code;
    this.status = status;
  }
}

export function isRemoteRequestError(
  value: unknown,
): value is RemoteRequestError {
  return value instanceof RemoteRequestError;
}

/** Normalize any invoke rejection into a structured RemoteRequestError. */
export function normalizeRequestError(value: unknown): RemoteRequestError {
  if (value instanceof RemoteRequestError) return value;
  const record = asRecord(value);
  if (record) {
    const code = typeof record.code === "string" ? record.code : "remote_error";
    const message =
      typeof record.message === "string" ? record.message : JSON.stringify(record);
    const status = typeof record.status === "string" ? record.status : undefined;
    return new RemoteRequestError(code, message, status);
  }
  if (typeof value === "string") return new RemoteRequestError("remote_error", value);
  if (value instanceof Error) {
    return new RemoteRequestError("remote_error", value.message);
  }
  return new RemoteRequestError("remote_error", String(value));
}
