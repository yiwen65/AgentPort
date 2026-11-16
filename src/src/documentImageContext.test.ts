import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureDocumentTabRuntime, getDocumentTabRuntime, openDocumentTarget, resetDocumentTabRuntimes, updateDocumentTabRuntime, closeDocumentTab, moveDocumentTab } from "./documents";
import { getActiveDocumentTab as activeTab, getState, setState } from "./store";
const getActiveDocumentTab = () => activeTab(getState());
import { setDeviceContext } from "./deviceContext";
import { readDocumentForDevice, writeDocumentForDevice, listDocumentDirectoryForDevice, deleteDocumentEntryForDevice } from "./api";
import { invoke } from "@tauri-apps/api/core";
import { setRemoteBackendFactoryForTests, resetRemoteBackendsForTests } from "./remote/runtime";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
beforeEach(() => { vi.clearAllMocks(); resetDocumentTabRuntimes(); resetRemoteBackendsForTests(); setDeviceContext({ kind: "local" }); setState({ docGroups: [], activeDocGroupIndex: 0, activeDevice: { kind: "local" }, explorerRoot: "/project", activeSessionId: null }); URL.revokeObjectURL = vi.fn(); });
afterEach(() => { resetDocumentTabRuntimes(); resetRemoteBackendsForTests(); });
it("captures the explorer root and document/device identity at tab opening, not preview mount", () => {
  const device = { kind: "remote" as const, deviceId: "original", deviceName: "Original", capabilities: [] };
  setState({ activeDevice: device }); openDocumentTarget({ path: "/project/docs/read.md", line: null }, { pinned: true });
  setState({ explorerRoot: "/different", activeDevice: { kind: "local" } });
  const tab = getActiveDocumentTab()!; const runtime = ensureDocumentTabRuntime(tab);
  expect(runtime.imageContext).toEqual({ path: tab.path, rootPath: "/project", device });
});
it("standalone documents use parent as root; split/remount keeps the image session until close or content replacement", () => {
  openDocumentTarget({ path: "/standalone/read.md", line: null }, { pinned: true }); const tab = getActiveDocumentTab()!;
  expect(ensureDocumentTabRuntime(tab).imageContext?.rootPath).toBe("/standalone");
  const doc = { path: tab.path, content: "![a](a.png)", sizeBytes: 12, truncated: false };
  updateDocumentTabRuntime(tab.id, { doc }); const images = getDocumentTabRuntime(tab.id)!.imageSession!;
  moveDocumentTab(tab.id, 1); expect(ensureDocumentTabRuntime(getActiveDocumentTab()!).imageSession).toBe(images);
  updateDocumentTabRuntime(tab.id, { mode: "raw" }); updateDocumentTabRuntime(tab.id, { mode: "preview" }); expect(getDocumentTabRuntime(tab.id)!.imageSession).toBe(images);
  const dispose = vi.spyOn(images, "dispose"); updateDocumentTabRuntime(tab.id, { doc: { ...doc, content: "different" }, draft: "different" }); expect(dispose).toHaveBeenCalledOnce(); expect(getDocumentTabRuntime(tab.id)!.imageSession).not.toBe(images);
  const current = getDocumentTabRuntime(tab.id)!.imageSession!; const closed = vi.spyOn(current, "dispose"); closeDocumentTab(tab.id); expect(closed).toHaveBeenCalledOnce(); expect(getDocumentTabRuntime(tab.id)).toBeNull();
});
it("explicit read/write contexts cannot be retargeted by active-device switches", async () => {
  const backend = { readSessionDocument: vi.fn(async () => ({})), writeSessionDocument: vi.fn(async () => ({})) };
  const factory = vi.fn(() => backend as never); setRemoteBackendFactoryForTests(factory);
  const origin = { kind: "remote" as const, deviceId: "one", deviceName: "One", capabilities: [] };
  setDeviceContext({ kind: "remote", deviceId: "two", deviceName: "Two", capabilities: [] });
  await readDocumentForDevice("/p/read.md", origin); await writeDocumentForDevice("/p/read.md", "draft", origin);
  expect(factory).toHaveBeenCalledWith("one"); expect(backend.readSessionDocument).toHaveBeenCalledWith("/p/read.md"); expect(backend.writeSessionDocument).toHaveBeenCalledWith("/p/read.md", "draft");
  await readDocumentForDevice("/local/read.md", { kind: "local" }); expect(invoke).toHaveBeenCalledWith("read_session_document", { path: "/local/read.md" });
});
it("pins tree listings and mutations to the tree device across switches", async () => {
  const backend = {
    listDocumentDirectory: vi.fn(async () => ({ path: "/p", entries: [], truncated: false })),
    deleteDocumentEntry: vi.fn(async () => undefined),
  };
  const factory = vi.fn(() => backend as never); setRemoteBackendFactoryForTests(factory);
  const origin = { kind: "remote" as const, deviceId: "one", deviceName: "One", capabilities: [] };
  setDeviceContext({ kind: "local" });
  await listDocumentDirectoryForDevice("/p", origin);
  await deleteDocumentEntryForDevice("/p/a.md", origin);
  expect(factory).toHaveBeenCalledWith("one");
  expect(backend.listDocumentDirectory).toHaveBeenCalledWith("/p");
  expect(backend.deleteDocumentEntry).toHaveBeenCalledWith("/p/a.md");

  setDeviceContext({ kind: "remote", deviceId: "two", deviceName: "Two", capabilities: [] });
  await listDocumentDirectoryForDevice("/local", { kind: "local" });
  expect(invoke).toHaveBeenCalledWith("list_document_directory", { path: "/local" });
});
