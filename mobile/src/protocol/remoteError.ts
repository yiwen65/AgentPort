/** Native invoke rejects with plain objects, not necessarily Error instances.
 * Never stringify arbitrary response objects into UI (or expose their fields). */
export function remoteErrorMessage(error: unknown): string {
  const message = typeof error === "string" ? error
    : error && typeof error === "object" && "message" in error ? error.message : undefined;
  return typeof message === "string" && message.trim() && message !== "[object Object]"
    ? message : "Request failed. Please try again.";
}
