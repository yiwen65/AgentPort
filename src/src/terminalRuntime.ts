// Eager shell modules must not pull xterm into the entry bundle. This facade
// loads the terminal runtime on first use and exposes synchronous helpers only
// once it is already loaded (a mounted terminal implies it is).

type TerminalRuntime = typeof import("./terminals");

let runtime: TerminalRuntime | null = null;
let loading: Promise<TerminalRuntime> | null = null;

export function loadTerminalRuntime(): Promise<TerminalRuntime> {
  if (runtime) return Promise.resolve(runtime);
  loading ??= import("./terminals").then((module) => {
    runtime = module;
    return module;
  });
  return loading;
}

export function preloadTerminalRuntime() {
  void loadTerminalRuntime();
}

export function getHandleIfLoaded(key: string) {
  return runtime?.getHandle(key) ?? null;
}

export function insertTextIntoTerminalIfLoaded(key: string, text: string) {
  return runtime?.insertTextIntoTerminal(key, text) ?? false;
}

export function scrollToBottomIfLoaded(key: string) {
  runtime?.scrollToBottom(key);
}

export async function pruneHandlesAsync() {
  (await loadTerminalRuntime()).pruneHandles();
}

export async function applyTerminalSettingsAsync() {
  (await loadTerminalRuntime()).applyTerminalSettings();
}

export async function applyXtermThemeAsync(...args: Parameters<TerminalRuntime["applyXtermTheme"]>) {
  (await loadTerminalRuntime()).applyXtermTheme(...args);
}

export async function applyTerminalLanguageAsync() {
  (await loadTerminalRuntime()).applyTerminalLanguage();
}

export async function attachHandleAsync(...args: Parameters<TerminalRuntime["attachHandle"]>) {
  return (await loadTerminalRuntime()).attachHandle(...args);
}

export async function clearUnreadOutputTrackingAsync(key: string) {
  (await loadTerminalRuntime()).clearUnreadOutputTracking(key);
}

export async function disposeHandleAsync(key: string) {
  (await loadTerminalRuntime()).disposeHandle(key);
}

export async function getHandleAsync(key: string) {
  return (await loadTerminalRuntime()).getHandle(key);
}

export async function releaseTerminalAsync(key: string) {
  return (await loadTerminalRuntime()).releaseTerminal(key);
}

export async function resetForRestartAsync(key: string, marker?: boolean) {
  const terminal = await loadTerminalRuntime();
  if (marker === undefined) terminal.resetForRestart(key);
  else terminal.resetForRestart(key, marker);
}

if (import.meta.env.MODE === "test") void loadTerminalRuntime();
