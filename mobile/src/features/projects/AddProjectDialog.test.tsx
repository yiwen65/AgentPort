import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import type { HostProfileSummary, RemoteClient, RemoteConnectionStateEvent } from "../../protocol/remoteClient";
import type { ProjectSummary } from "../sessions/types";
import { AddProjectDialog, isAbsoluteProjectPath } from "./AddProjectDialog";
import { beginPendingProjectAdd, readPendingProjectAdd, updatePendingProjectAdd } from "./pendingProjectAdd";

const host: HostProfileSummary = { id: "studio", name: "Studio", hostname: "studio.local", port: 22, username: "dev", preferredTransport: "ssh", connectionState: "connected", lastConnectedAt: null, lastError: null };
const project = (rootPath = "/home/dev/work"): ProjectSummary => ({ id: "project-1", name: "Work", rootPath, pinned: false, sortOrder: 0 });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function remote() {
  let connection: (event: RemoteConnectionStateEvent) => void = () => {};
  const client: RemoteClient = {
    listHostProfiles: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), subscribe: vi.fn(),
    onConnectionState: vi.fn(async listener => { connection = listener; return async () => {}; }),
    request: vi.fn().mockImplementation(async (_id, method, params) => {
      if (method === "project.directory.list") {
        const path = params.path ?? "/home/dev";
        return { path, homePath: "/home/dev", parentPath: path === "/" ? null : path.slice(0, path.lastIndexOf("/")) || "/", entries: path === "/home/dev" ? [{ name: "work", path: "/home/dev/work" }, ...(params.showHidden ? [{ name: ".private", path: "/home/dev/.private" }] : [])] : [], truncated: false };
      }
      if (method === "project.directory.resolve") return { path: params.path };
      if (method === "project.add") return { project: project(params.path), focusedExisting: false };
      if (method === "project.list") return [];
      if (method === "document.list") throw { code: "unknown_method", status: "not_executed" };
      throw new Error(`Unexpected method ${method}`);
    }),
  };
  return { client, emit: (state: RemoteConnectionStateEvent["state"], profileId = host.id) => connection({ profileId, state }) };
}
const calls = (client: RemoteClient, method: string) => vi.mocked(client.request).mock.calls.filter(([, called]) => called === method);
function mount(client: RemoteClient, overrides: Partial<React.ComponentProps<typeof AddProjectDialog>> = {}) {
  const onAdded = vi.fn().mockResolvedValue(undefined), onClose = vi.fn();
  return { ...render(<AddProjectDialog client={client} host={host} onAdded={onAdded} onClose={onClose} {...overrides} />), onAdded, onClose };
}
const add = () => screen.getByRole("button", { name: "Add project" });
const pathInput = () => screen.getByLabelText("Remote absolute path");
const nameInput = () => screen.getByLabelText("Display name (optional)");
async function ready() { await screen.findByRole("button", { name: "Open directory work" }); }

const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
function animatedDismissal() {
  const animations: { cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null }[] = [];
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, writable: true, value: () => {
    const animation = { cancel: vi.fn(), onfinish: null };
    animations.push(animation);
    return animation as unknown as Animation;
  } });
  return animations;
}

beforeEach(async () => { localStorage.clear(); await i18n.changeLanguage("en-US"); });
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
  else Reflect.deleteProperty(HTMLElement.prototype, "animate");
});

describe("Add project dialog", () => {
  it("browses remote Home, follows a directory, resolves it and submits without starting an agent", async () => {
    const { client } = remote();
    const { onAdded, onClose } = mount(client);
    await ready();
    expect(screen.getByRole("dialog", { name: "Add project" })).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("Computer: Studio")).toBeInTheDocument();
    expect(calls(client, "project.directory.list")[0]).toEqual([host.id, "project.directory.list", { showHidden: false }]);
    fireEvent.click(screen.getByRole("button", { name: "Open directory work" }));
    await screen.findByText("No visible subdirectories. You can add this directory.");
    fireEvent.click(add());
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith({ project: project(), focusedExisting: false }));
    expect(calls(client, "project.directory.resolve")[0][2]).toEqual({ path: "/home/dev/work" });
    expect(calls(client, "project.add")[0]).toEqual([host.id, "project.add", { path: "/home/dev/work", name: null }]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(readPendingProjectAdd(host.id)).toBeNull();
    expect(calls(client, "session.create")).toHaveLength(0);
  });

  it("shows hidden directories, supports Up and Home, and reports truncation", async () => {
    const { client } = remote();
    const base = vi.mocked(client.request).getMockImplementation()!;
    vi.mocked(client.request).mockImplementation(async (...args) => {
      const result = await base(...args);
      return args[1] === "project.directory.list" ? { ...(result as Record<string, unknown>), truncated: true } : result;
    });
    mount(client); await ready();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show hidden directories" }));
    await screen.findByRole("button", { name: "Open directory .private" });
    expect(screen.getByText(i18n.t("project.truncated"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open directory work" }));
    await waitFor(() => expect(pathInput()).toHaveValue("/home/dev/work"));
    fireEvent.click(screen.getByRole("button", { name: "Up" }));
    await waitFor(() => expect(pathInput()).toHaveValue("/home/dev"));
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await waitFor(() => expect(calls(client, "project.directory.list").at(-1)?.[2]).toEqual({ showHidden: true }));
  });

  it.each(["", "   ", "  Personal notes  "])("adds a manual ordinary directory with optional name %j, without listing it", async name => {
    const { client } = remote();
    const base = vi.mocked(client.request).getMockImplementation()!;
    vi.mocked(client.request).mockImplementation(async (...args) => {
      if (args[1] === "project.directory.resolve") return { path: "/canonical/plain" };
      if (args[1] === "project.add") expect(readPendingProjectAdd(host.id)).toMatchObject({ path: "/alias/plain", canonicalPath: "/canonical/plain", name: name.trim() || null, state: "pending" });
      return base(...args);
    });
    const { onAdded } = mount(client); await ready();
    fireEvent.change(pathInput(), { target: { value: "/alias/plain" } });
    fireEvent.change(nameInput(), { target: { value: name } });
    expect(nameInput()).toHaveAttribute("maxlength", "80");
    fireEvent.click(add());
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(calls(client, "project.add")[0][2]).toEqual({ path: "/canonical/plain", name: name.trim() || null });
    expect(calls(client, "project.directory.list")).toHaveLength(1);
  });

  it("browses the installed Ubuntu legacy document API instead of downgrading to manual-only", async () => {
    const { client } = remote(); const base = vi.mocked(client.request).getMockImplementation()!;
    vi.mocked(client.request).mockImplementation((...args) => {
      if (args[1].startsWith("project.directory.")) return Promise.reject({ code: "unknown_method", status: "not_executed" });
      if (args[1] === "document.list") {
        const path = (args[2] as { path: string }).path;
        return Promise.resolve({ path: path === "/alias" ? "/canonical/plain" : path, truncated: false,
          entries: path === "/" ? [{ name: "home", path: "/home", isDir: true }, { name: ".private", path: "/.private", isDir: true }, { name: "file", path: "/file", isDir: false }] : [] });
      }
      return base(...args);
    });
    const { onAdded } = mount(client);
    await screen.findByRole("button", { name: "Open directory home" });
    expect(pathInput()).toHaveValue("/");
    expect(screen.queryByText(i18n.t("project.manualFallback"))).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Root" })).toBeInTheDocument();
    expect(screen.getByText(i18n.t("project.legacyBrowsing"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open directory file" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open directory .private" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show hidden directories" }));
    await screen.findByRole("button", { name: "Open directory .private" });
    fireEvent.change(pathInput(), { target: { value: "/alias" } });
    fireEvent.click(add());
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(calls(client, "project.add")[0][2]).toEqual({ path: "/canonical/plain", name: null });
    expect(readPendingProjectAdd(host.id)).toBeNull();
  });

  it("keeps legacy permission/service failures as errors and never submits an unvalidated directory", async () => {
    const { client } = remote(); const base = vi.mocked(client.request).getMockImplementation()!;
    vi.mocked(client.request).mockImplementation((...args) => {
      if (args[1].startsWith("project.directory.")) return Promise.reject({ code: "unknown_method", status: "not_executed" });
      if (args[1] === "document.list") {
        const path = (args[2] as { path: string }).path;
        if (path === "/denied") return Promise.reject({ code: "service_error", status: "failed", message: "request failed on the remote host" });
        return Promise.resolve({ path, truncated: false, entries: [] });
      }
      return base(...args);
    });
    mount(client);
    await screen.findByText(i18n.t("project.legacyBrowsing"));
    fireEvent.change(pathInput(), { target: { value: "/denied" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await screen.findByRole("alert");
    expect(add()).toBeDisabled();
    expect(screen.queryByLabelText("Current directory")).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("project.manualFallback"))).not.toBeInTheDocument();
    fireEvent.change(pathInput(), { target: { value: "/edit" } });
    fireEvent.change(pathInput(), { target: { value: "/denied" } });
    fireEvent.submit(add().closest("form")!);
    await waitFor(() => expect(calls(client, "project.directory.resolve")).toHaveLength(1));
    await act(async () => {});
    expect(calls(client, "project.add")).toHaveLength(0);
    expect(readPendingProjectAdd(host.id)).toBeNull();
    expect(pathInput()).toHaveValue("/denied");
  });

  it("persists the legacy canonical path and reconciles an unknown write without another add", async () => {
    const { client } = remote(); const base = vi.mocked(client.request).getMockImplementation()!;
    let found = false;
    vi.mocked(client.request).mockImplementation((...args) => {
      if (args[1].startsWith("project.directory.")) return Promise.reject({ code: "unknown_method", status: "not_executed" });
      if (args[1] === "document.list") return Promise.resolve({ path: (args[2] as { path: string }).path === "/alias" ? "/canonical" : "/", truncated: false, entries: [] });
      if (args[1] === "project.add") return Promise.reject({ code: "request_timeout", status: "unknown" });
      if (args[1] === "project.list") return Promise.resolve(found ? [project("/canonical")] : []);
      return base(...args);
    });
    const first = mount(client);
    await screen.findByText(i18n.t("project.legacyBrowsing"));
    fireEvent.change(pathInput(), { target: { value: "/alias" } });
    fireEvent.click(add());
    await screen.findByText(/original request may still be running/);
    expect(readPendingProjectAdd(host.id)?.canonicalPath).toBe("/canonical");
    first.unmount(); found = true;
    const next = mount(client);
    await waitFor(() => expect(next.onAdded).toHaveBeenCalledWith({ project: project("/canonical"), focusedExisting: true }));
    expect(calls(client, "project.add")).toHaveLength(1);
    expect(readPendingProjectAdd(host.id)).toBeNull();
  });

  it("never writes an ambiguous legacy canonical path into a replacement-character sibling", async () => {
    const { client } = remote(); const base = vi.mocked(client.request).getMockImplementation()!;
    vi.mocked(client.request).mockImplementation((...args) => {
      if (args[1].startsWith("project.directory.")) return Promise.reject({ code: "unknown_method", status: "not_executed" });
      if (args[1] === "document.list") return Promise.resolve({ path: (args[2] as { path: string }).path === "/alias" ? "/work\uFFFD" : "/", truncated: false, entries: [] });
      return base(...args);
    });
    mount(client);
    await screen.findByText(i18n.t("project.legacyBrowsing"));
    fireEvent.change(pathInput(), { target: { value: "/alias" } });
    fireEvent.click(add());
    await screen.findByRole("alert");
    expect(calls(client, "project.add")).toHaveLength(0);
    expect(readPendingProjectAdd(host.id)).toBeNull();
    expect(pathInput()).toHaveValue("/alias");
  });

  it("does not submit a directory preflight from a previous connection generation", async () => {
    const { client, emit } = remote(); const base = vi.mocked(client.request).getMockImplementation()!;
    const validation = deferred<{ path: string }>();
    vi.mocked(client.request).mockImplementation((...args) => args[1] === "project.directory.resolve" ? validation.promise : base(...args));
    mount(client); await ready();
    fireEvent.click(add());
    await waitFor(() => expect(calls(client, "project.directory.resolve")).toHaveLength(1));
    await act(async () => emit("disconnected"));
    await act(async () => emit("connected"));
    await act(async () => validation.resolve({ path: "/old-connection-directory" }));
    expect(calls(client, "project.add")).toHaveLength(0);
    expect(readPendingProjectAdd(host.id)).toBeNull();
  });

  it("does not let a stale unsupported preflight disable resolution on the fresh connection", async () => {
    const { client, emit } = remote(); const base = vi.mocked(client.request).getMockImplementation()!;
    const validation = deferred<{ path: string }>(); let resolutions = 0;
    vi.mocked(client.request).mockImplementation((...args) => {
      if (args[1] === "project.directory.resolve") return ++resolutions === 1 ? validation.promise
        : Promise.reject({ code: "permission_denied", status: "not_executed" });
      return base(...args);
    });
    mount(client); await ready();
    fireEvent.click(add());
    await waitFor(() => expect(resolutions).toBe(1));
    await act(async () => emit("disconnected"));
    await act(async () => emit("connected"));
    await act(async () => validation.reject({ code: "unknown_method", status: "not_executed" }));
    expect(calls(client, "project.add")).toHaveLength(0);
    fireEvent.click(add());
    await screen.findByRole("alert");
    expect(resolutions).toBe(2);
    expect(calls(client, "project.add")).toHaveLength(0);
    expect(readPendingProjectAdd(host.id)).toBeNull();
  });

  it("reprobes native directory capabilities after a legacy host reconnects", async () => {
    const { client, emit } = remote(); const base = vi.mocked(client.request).getMockImplementation()!;
    let upgraded = false;
    vi.mocked(client.request).mockImplementation((...args) => {
      if (args[1].startsWith("project.directory.") && !upgraded) return Promise.reject({ code: "unknown_method", status: "not_executed" });
      if (args[1] === "document.list") return Promise.resolve({ path: "/", truncated: false, entries: [] });
      return base(...args);
    });
    mount(client);
    await screen.findByText(i18n.t("project.legacyBrowsing"));
    await act(async () => emit("disconnected"));
    upgraded = true;
    await act(async () => emit("connected"));
    await screen.findByRole("button", { name: "Home" });
    expect(screen.queryByText(i18n.t("project.legacyBrowsing"))).not.toBeInTheDocument();
    expect(calls(client, "project.directory.list")).toHaveLength(2);
    expect(calls(client, "project.add")).toHaveLength(0);
  });

  it.each(["unknown_method", "capability_disabled"])("downgrades only explicit unsupported %s to absolute manual paths", async code => {
    const { client } = remote();
    const base = vi.mocked(client.request).getMockImplementation()!;
    vi.mocked(client.request).mockImplementation((...args) => args[1].startsWith("project.directory.") ? Promise.reject({ code, status: "not_executed" }) : base(...args));
    const { onAdded } = mount(client);
    await screen.findByText(i18n.t("project.manualFallback"));
    fireEvent.change(pathInput(), { target: { value: "/plain/non-git" } });
    fireEvent.click(add());
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(calls(client, "project.add")[0][2]).toEqual({ path: "/plain/non-git", name: null });
  });

  it.each(["permission_denied", "directory_read_failed", "connection_closed"])("does not misrepresent a %s read failure as unsupported", async code => {
    const { client } = remote();
    vi.mocked(client.request).mockRejectedValue({ code, message: "read unavailable" });
    mount(client);
    await screen.findByRole("alert");
    expect(screen.queryByText(i18n.t("project.manualFallback"))).not.toBeInTheDocument();
    expect(add()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Home" })).toBeEnabled();
    expect(calls(client, "project.add")).toHaveLength(0);
  });

  it.each(["relative/path", "~/work", "", "C:relative"])("rejects invalid absolute path %j without remote submission", async path => {
    const { client } = remote(); mount(client); await ready();
    fireEvent.change(pathInput(), { target: { value: path } });
    expect(add()).toBeDisabled();
    if (path) {
      fireEvent.click(screen.getByRole("button", { name: "Go" }));
      await screen.findByText(/Enter a valid remote absolute directory path/);
    }
    expect(calls(client, "project.add")).toHaveLength(0);
    expect(calls(client, "project.directory.list")).toHaveLength(1);
  });

  it("recognizes native POSIX, drive and UNC absolute paths, without accepting control characters", () => {
    expect(["/", "/home/a b", "C:\\work", "D:/work", "\\\\server\\share\\work"].every(isAbsoluteProjectPath)).toBe(true);
    expect(isAbsoluteProjectPath("/home/\u0000bad")).toBe(false);
  });

  it("disables offline reads and writes while retaining editable input; reconnect resumes browsing", async () => {
    const { client, emit } = remote(); mount(client, { host: { ...host, connectionState: "disconnected" } });
    fireEvent.change(pathInput(), { target: { value: "/notes" } });
    fireEvent.change(nameInput(), { target: { value: "Notes" } });
    expect(screen.getByText(/This computer is offline/)).toBeInTheDocument();
    expect(add()).toBeDisabled(); expect(screen.getByRole("button", { name: "Go" })).toBeDisabled();
    expect(client.request).not.toHaveBeenCalled();
    await act(async () => emit("connected"));
    await waitFor(() => expect(add()).toBeEnabled());
    expect(pathInput()).toHaveValue("/notes"); expect(nameInput()).toHaveValue("Notes");
    expect(calls(client, "project.directory.list")[0][2]).toEqual({ path: "/notes", showHidden: false });
    await act(async () => emit("disconnected"));
    expect(add()).toBeDisabled(); expect(pathInput()).toHaveValue("/notes");
  });

  it("guards double submits before asynchronous validation and targets the captured host", async () => {
    const { client } = remote(); const validation = deferred<{ path: string }>();
    const base = vi.mocked(client.request).getMockImplementation()!;
    vi.mocked(client.request).mockImplementation((...args) => args[1] === "project.directory.resolve" ? validation.promise : base(...args));
    const { onAdded } = mount(client); await ready();
    fireEvent.change(pathInput(), { target: { value: "/notes" } });
    const form = add().closest("form")!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(calls(client, "project.directory.resolve")).toHaveLength(1);
    await act(async () => validation.resolve({ path: "/notes" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(calls(client, "project.add")).toHaveLength(1);
    expect(calls(client, "project.add")[0][0]).toBe(host.id);
  });

  it("ignores stale browse responses and never adds the old directory after navigation fails", async () => {
    const { client } = remote(); const old = deferred<unknown>();
    const base = vi.mocked(client.request).getMockImplementation()!;
    vi.mocked(client.request).mockImplementation((...args) => {
      if (args[1] === "project.directory.list" && (args[2] as any).path === "/slow") return old.promise;
      if (args[1] === "project.directory.list" && (args[2] as any).path === "/denied") return Promise.reject({ code: "permission_denied" });
      return base(...args);
    });
    mount(client); await ready();
    fireEvent.change(pathInput(), { target: { value: "/slow" } }); fireEvent.click(screen.getByRole("button", { name: "Go" }));
    fireEvent.change(pathInput(), { target: { value: "/denied" } }); fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await screen.findByText(/service account cannot access/);
    await act(async () => old.resolve({ path: "/slow", homePath: "/home/dev", parentPath: "/", entries: [], truncated: false }));
    expect(pathInput()).toHaveValue("/denied"); expect(add()).toBeDisabled();
    expect(screen.queryByLabelText("Current directory")).not.toBeInTheDocument();
    expect(calls(client, "project.add")).toHaveLength(0);
  });

  it("cancel before submit performs no write", async () => {
    const { client } = remote(); const { onClose } = mount(client); await ready();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1); expect(calls(client, "project.add")).toHaveLength(0);
  });

  it("closing during directory validation still prevents a write", async () => {
    const { client } = remote(); const validation = deferred<{ path: string }>();
    const base = vi.mocked(client.request).getMockImplementation()!;
    vi.mocked(client.request).mockImplementation((...args) => args[1] === "project.directory.resolve" ? validation.promise : base(...args));
    const { onClose } = mount(client); await ready();
    fireEvent.click(add()); fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await act(async () => validation.resolve({ path: "/home/dev" }));
    expect(onClose).toHaveBeenCalled(); expect(calls(client, "project.add")).toHaveLength(0);
    expect(readPendingProjectAdd(host.id)).toBeNull();
  });

  it.each(["header", "Escape", "backdrop"])("blocks a preflight write as soon as animated %s dismissal starts", async dismissal => {
    const animations = animatedDismissal();
    const { client } = remote(); const validation = deferred<{ path: string }>();
    const base = vi.mocked(client.request).getMockImplementation()!;
    vi.mocked(client.request).mockImplementation((...args) => args[1] === "project.directory.resolve" ? validation.promise : base(...args));
    const { onClose, onAdded } = mount(client); await ready(); fireEvent.click(add());
    expect(calls(client, "project.directory.resolve")).toHaveLength(1);
    if (dismissal === "header") fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    else if (dismissal === "Escape") fireEvent.keyDown(document, { key: "Escape" });
    else fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(animations).toHaveLength(4);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => validation.resolve({ path: "/home/dev" })); // Still inside the unfinished 130ms exit.
    expect(calls(client, "project.add")).toHaveLength(0);
    expect(onAdded).not.toHaveBeenCalled(); expect(readPendingProjectAdd(host.id)).toBeNull();
    act(() => animations[3].onfinish?.());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("retains a late durable receipt when an already invoked write completes during animated dismissal", async () => {
    const animations = animatedDismissal();
    const { client } = remote(); const write = deferred<unknown>();
    const base = vi.mocked(client.request).getMockImplementation()!;
    vi.mocked(client.request).mockImplementation((...args) => args[1] === "project.add" ? write.promise : base(...args));
    const first = mount(client); await ready(); fireEvent.click(add());
    await waitFor(() => expect(calls(client, "project.add")).toHaveLength(1));
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    expect(first.onClose).not.toHaveBeenCalled();
    await act(async () => write.resolve({ project: project("/home/dev"), focusedExisting: false }));
    expect(first.onAdded).not.toHaveBeenCalled(); expect(first.onClose).not.toHaveBeenCalled();
    expect(readPendingProjectAdd(host.id)?.state).toBe("confirmed");
    act(() => animations[3].onfinish?.()); expect(first.onClose).toHaveBeenCalledTimes(1);
    first.unmount(); const second = mount(client);
    await waitFor(() => expect(second.onAdded).toHaveBeenCalledTimes(1));
    expect(calls(client, "project.add")).toHaveLength(1); expect(readPendingProjectAdd(host.id)).toBeNull();
  });

  it.each(["path_not_found", "not_directory", "permission_denied", "invalid_path", "directory_read_failed"])("preserves input and permits corrected retry after a known %s add failure", async code => {
    const { client } = remote(); const base = vi.mocked(client.request).getMockImplementation()!;
    vi.mocked(client.request).mockImplementation((...args) => args[1] === "project.add" ? Promise.reject({ code, status: "not_executed" }) : base(...args));
    mount(client); await ready(); fireEvent.change(nameInput(), { target: { value: "My work" } }); fireEvent.click(add());
    await screen.findByRole("alert");
    expect(readPendingProjectAdd(host.id)).toBeNull(); expect(add()).toBeEnabled();
    expect(nameInput()).toHaveValue("My work"); expect(pathInput()).toHaveValue("/home/dev");
  });

  it("explains upgrade required for unsupported add without leaving an unknown write", async () => {
    const { client } = remote(); const base = vi.mocked(client.request).getMockImplementation()!;
    vi.mocked(client.request).mockImplementation((...args) => args[1] === "project.add" ? Promise.reject({ code: "capability_disabled", status: "not_executed" }) : base(...args));
    mount(client); await ready(); fireEvent.click(add());
    await screen.findByText(/Upgrade AgentPort on the computer/);
    expect(readPendingProjectAdd(host.id)).toBeNull(); expect(add()).toBeEnabled();
  });

  it.each([{ code: "request_timeout", status: "unknown" }, { code: "connection_closed", message: "Transport lost" }])("persists unknown write %j across close/reopen and only reconciles positive evidence", async failure => {
    const { client } = remote(); const base = vi.mocked(client.request).getMockImplementation()!;
    let found = false;
    vi.mocked(client.request).mockImplementation((...args) => {
      if (args[1] === "project.add") return Promise.reject(failure);
      if (args[1] === "project.list") return Promise.resolve(found ? [project("/notes")] : []);
      return base(...args);
    });
    const first = mount(client); await ready(); fireEvent.change(pathInput(), { target: { value: "/notes" } }); fireEvent.click(add());
    await screen.findByText(/add result is still unconfirmed/);
    expect(readPendingProjectAdd(host.id)).toMatchObject({ path: "/notes", canonicalPath: "/notes", state: "pending" });
    first.unmount();
    const second = mount(client);
    await waitFor(() => expect(calls(client, "project.list")).toHaveLength(1));
    await screen.findByText(/original request may still be running/);
    expect(add()).toBeDisabled(); expect(readPendingProjectAdd(host.id)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check add result" }));
    await waitFor(() => expect(calls(client, "project.list")).toHaveLength(2));
    expect(add()).toBeDisabled(); expect(calls(client, "project.add")).toHaveLength(1);
    found = true;
    fireEvent.click(screen.getByRole("button", { name: "Check add result" }));
    await waitFor(() => expect(second.onAdded).toHaveBeenCalledWith({ project: project("/notes"), focusedExisting: true }));
    expect(first.onAdded).not.toHaveBeenCalled(); expect(readPendingProjectAdd(host.id)).toBeNull();
  });

  it("resolves a pending alias before list reconciliation and rechecks automatically on reconnect", async () => {
    beginPendingProjectAdd(host.id, { id: "pending-alias", path: "/alias", name: "Notes", state: "pending" });
    const { client, emit } = remote(); const base = vi.mocked(client.request).getMockImplementation()!;
    let found = false;
    vi.mocked(client.request).mockImplementation((...args) => {
      if (args[1] === "project.directory.resolve") return Promise.resolve({ path: "/canonical" });
      if (args[1] === "project.list") return Promise.resolve(found ? [project("/canonical")] : []);
      return base(...args);
    });
    const { onAdded } = mount(client);
    await screen.findByText(/original request may still be running/);
    expect(readPendingProjectAdd(host.id)?.canonicalPath).toBe("/canonical");
    await act(async () => emit("disconnected")); found = true;
    await act(async () => emit("connected"));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith({ project: project("/canonical"), focusedExisting: true }));
    expect(calls(client, "project.add")).toHaveLength(0);
  });

  it("late success after close updates the journal, never the old dialog, then a fresh dialog consumes it", async () => {
    const { client } = remote(); const write = deferred<unknown>(); const base = vi.mocked(client.request).getMockImplementation()!;
    vi.mocked(client.request).mockImplementation((...args) => args[1] === "project.add" ? write.promise : base(...args));
    const first = mount(client); await ready(); fireEvent.click(add());
    await waitFor(() => expect(calls(client, "project.add")).toHaveLength(1));
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]); first.unmount();
    await act(async () => write.resolve({ project: project("/home/dev"), focusedExisting: false }));
    expect(first.onAdded).not.toHaveBeenCalled();
    expect(readPendingProjectAdd(host.id)).toMatchObject({ state: "confirmed", result: { project: project("/home/dev") } });
    const second = mount(client);
    await waitFor(() => expect(second.onAdded).toHaveBeenCalledWith({ project: project("/home/dev"), focusedExisting: false }));
    expect(calls(client, "project.add")).toHaveLength(1);
  });

  it("keeps pending records host-specific and does not invoke callbacks into a switched device", async () => {
    const { client } = remote(); const write = deferred<unknown>(); const base = vi.mocked(client.request).getMockImplementation()!;
    vi.mocked(client.request).mockImplementation((...args) => args[1] === "project.add" ? write.promise : base(...args));
    const oldAdded = vi.fn(), newAdded = vi.fn().mockResolvedValue(undefined), onClose = vi.fn();
    const view = mount(client, { onAdded: oldAdded }); await ready(); fireEvent.click(add());
    await waitFor(() => expect(calls(client, "project.add")).toHaveLength(1));
    view.rerender(<AddProjectDialog client={client} host={{ ...host, id: "laptop", name: "Laptop" }} onAdded={newAdded} onClose={onClose} />);
    await ready(); expect(add()).toBeEnabled();
    await act(async () => write.resolve({ project: project("/home/dev"), focusedExisting: false }));
    expect(oldAdded).not.toHaveBeenCalled(); expect(newAdded).not.toHaveBeenCalled();
    expect(readPendingProjectAdd(host.id)?.state).toBe("confirmed"); expect(readPendingProjectAdd("laptop")).toBeNull();
  });

  it("distinguishes callback refresh failure from add failure, and refresh retry never writes again", async () => {
    const { client } = remote(); const onAdded = vi.fn().mockRejectedValueOnce(new Error("List failed")).mockResolvedValueOnce(undefined);
    const { onClose } = mount(client, { onAdded }); await ready(); fireEvent.click(add());
    await screen.findByText("Project added, but refreshing the list failed. Retry the refresh, not the add.");
    expect(add()).toBeDisabled(); expect(readPendingProjectAdd(host.id)?.state).toBe("confirmed");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh project list again" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onAdded).toHaveBeenCalledTimes(2); expect(calls(client, "project.add")).toHaveLength(1);
  });

  it("recovers a confirmed add refresh failure across disconnect/reconnect without another write", async () => {
    const { client, emit } = remote();
    const onAdded = vi.fn().mockRejectedValueOnce(new Error("Refresh failed")).mockResolvedValueOnce(undefined);
    const { onClose } = mount(client, { onAdded }); await ready(); fireEvent.click(add());
    await screen.findByRole("button", { name: "Refresh project list again" });
    expect(readPendingProjectAdd(host.id)?.state).toBe("confirmed");
    await act(async () => emit("disconnected"));
    await act(async () => emit("connected"));
    expect(onAdded).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1); expect(readPendingProjectAdd(host.id)).toBeNull();
    expect(calls(client, "project.add")).toHaveLength(1);
  });

  it("keeps read-only explicit refresh recovery actionable if the reconnect retry also fails", async () => {
    const { client, emit } = remote();
    const onAdded = vi.fn().mockRejectedValueOnce(new Error("First refresh failed"))
      .mockRejectedValueOnce(new Error("Reconnect refresh failed")).mockResolvedValueOnce(undefined);
    const { onClose } = mount(client, { onAdded }); await ready(); fireEvent.click(add());
    await screen.findByRole("button", { name: "Refresh project list again" });
    await act(async () => emit("disconnected")); await act(async () => emit("connected"));
    expect(onAdded).toHaveBeenCalledTimes(2);
    const retry = await screen.findByRole("button", { name: "Refresh project list again" });
    fireEvent.click(retry);
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(3));
    expect(onClose).toHaveBeenCalledTimes(1); expect(readPendingProjectAdd(host.id)).toBeNull();
    expect(calls(client, "project.add")).toHaveLength(1);
  });

  it("keeps refresh callbacks single-flight across repeated reconnects and duplicate receipts", async () => {
    const { client, emit } = remote(); const refresh = deferred<void>();
    const onAdded = vi.fn().mockRejectedValueOnce(new Error("First refresh failed")).mockImplementationOnce(() => refresh.promise);
    const { onClose } = mount(client, { onAdded }); await ready(); fireEvent.click(add());
    await screen.findByRole("button", { name: "Refresh project list again" });
    await act(async () => emit("disconnected")); await act(async () => emit("connected"));
    expect(onAdded).toHaveBeenCalledTimes(2);
    await act(async () => {
      const receipt = readPendingProjectAdd(host.id)!;
      updatePendingProjectAdd(host.id, receipt); updatePendingProjectAdd(host.id, receipt);
      emit("disconnected"); emit("connected");
    });
    expect(onAdded).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Project added. Updating the list…")).toBeInTheDocument();
    await act(async () => refresh.resolve());
    expect(onClose).toHaveBeenCalledTimes(1); expect(readPendingProjectAdd(host.id)).toBeNull();
    expect(calls(client, "project.add")).toHaveLength(1);
  });

  it("blocks writes when the durable pending record cannot be saved", async () => {
    const { client } = remote(); mount(client); await ready();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Disk full"); });
    fireEvent.click(add());
    await screen.findByText(/Unable to read or save the add record/);
    expect(add()).toBeDisabled(); expect(calls(client, "project.add")).toHaveLength(0);
  });

  it.each(["path_not_found", "not_directory", "permission_denied", "invalid_path", "directory_read_failed", "connection_closed"])("does not send an add or downgrade after a %s resolve failure", async code => {
    const { client } = remote(); const base = vi.mocked(client.request).getMockImplementation()!;
    vi.mocked(client.request).mockImplementation((...args) => args[1] === "project.directory.resolve" ? Promise.reject({ code, message: "resolve failed" }) : base(...args));
    mount(client); await ready(); fireEvent.click(add());
    await screen.findByRole("alert");
    expect(calls(client, "project.add")).toHaveLength(0); expect(readPendingProjectAdd(host.id)).toBeNull();
    expect(screen.queryByText(i18n.t("project.manualFallback"))).not.toBeInTheDocument();
    expect(pathInput()).toHaveValue("/home/dev"); expect(add()).toBeEnabled();
  });

  it("is StrictMode-safe for restored unknown requests and ignores the first lifetime's stale resolve", async () => {
    beginPendingProjectAdd(host.id, { id: "strict-pending", path: "/alias", name: null, state: "pending" });
    const { client } = remote(); const stale = deferred<{ path: string }>();
    const base = vi.mocked(client.request).getMockImplementation()!;
    let resolves = 0;
    vi.mocked(client.request).mockImplementation((...args) => args[1] === "project.directory.resolve"
      ? ++resolves === 1 ? stale.promise : Promise.resolve({ path: "/current" }) : base(...args));
    const stop = vi.fn().mockResolvedValue(undefined);
    vi.mocked(client.onConnectionState).mockResolvedValue(stop);
    render(<StrictMode><AddProjectDialog client={client} host={host} onClose={vi.fn()} onAdded={vi.fn()} /></StrictMode>);
    await screen.findByText(/original request may still be running/);
    expect(calls(client, "project.directory.resolve")).toHaveLength(2);
    expect(calls(client, "project.list")).toHaveLength(1);
    expect(stop).toHaveBeenCalledTimes(1);
    await act(async () => stale.resolve({ path: "/stale" }));
    expect(readPendingProjectAdd(host.id)?.canonicalPath).toBe("/current");
    expect(screen.getByRole("button", { name: "Check add result" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Check add result" }));
    await waitFor(() => expect(calls(client, "project.list")).toHaveLength(2));
    expect(calls(client, "project.add")).toHaveLength(0);
  });

  it("can reopen after a confirmed add whose list refresh failed without another write", async () => {
    const { client } = remote();
    const first = mount(client, { onAdded: vi.fn().mockRejectedValue(new Error("refresh failed")) });
    await ready(); fireEvent.click(add());
    await screen.findByText(/Project added, but refreshing the list failed/);
    first.unmount();
    const second = mount(client);
    await waitFor(() => expect(second.onAdded).toHaveBeenCalled());
    expect(calls(client, "project.add")).toHaveLength(1);
  });

  it("retains unknown legacy aliases when resolution is unsupported and the project list has no match", async () => {
    beginPendingProjectAdd(host.id, { id: "legacy-alias", path: "/alias", name: null, state: "pending" });
    const { client } = remote(); const base = vi.mocked(client.request).getMockImplementation()!;
    vi.mocked(client.request).mockImplementation((...args) => args[1] === "project.directory.resolve"
      ? Promise.reject({ code: "unknown_method", status: "not_executed" }) : base(...args));
    mount(client);
    await screen.findByText(/original request may still be running/);
    expect(readPendingProjectAdd(host.id)).toMatchObject({ path: "/alias", state: "pending" });
    expect(add()).toBeDisabled(); expect(calls(client, "project.add")).toHaveLength(0);
    // Resolution failure alone does not prove that both browsers are unavailable.
    expect(screen.queryByText(i18n.t("project.manualFallback"))).not.toBeInTheDocument();
  });

  it("focuses an existing project without replacing its name", async () => {
    const { client } = remote(); const base = vi.mocked(client.request).getMockImplementation()!;
    vi.mocked(client.request).mockImplementation((...args) => args[1] === "project.add"
      ? Promise.resolve({ project: project("/home/dev"), focusedExisting: true }) : base(...args));
    const { onAdded } = mount(client); await ready();
    fireEvent.change(nameInput(), { target: { value: "New name" } }); fireEvent.click(add());
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith({ project: project("/home/dev"), focusedExisting: true }));
  });

  it("defers list-refresh callbacks when a write succeeds after the device goes offline", async () => {
    const { client, emit } = remote(); const write = deferred<unknown>();
    const base = vi.mocked(client.request).getMockImplementation()!;
    vi.mocked(client.request).mockImplementation((...args) => args[1] === "project.add" ? write.promise : base(...args));
    const { onAdded } = mount(client); await ready(); fireEvent.click(add());
    await waitFor(() => expect(calls(client, "project.add")).toHaveLength(1));
    await act(async () => emit("disconnected"));
    await act(async () => write.resolve({ project: project("/home/dev"), focusedExisting: false }));
    expect(onAdded).not.toHaveBeenCalled(); expect(readPendingProjectAdd(host.id)?.state).toBe("confirmed");
    expect(screen.getByText("Project added. Reconnect to refresh and focus it; no further add is needed.")).toBeInTheDocument();
    await act(async () => emit("connected"));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(calls(client, "project.add")).toHaveLength(1);
  });

  it("honestly displays a confirmed receipt while offline, then refreshes it after reconnect", async () => {
    const record = { id: "offline-confirmed", path: "/notes", name: null, state: "pending" as const };
    beginPendingProjectAdd(host.id, record);
    updatePendingProjectAdd(host.id, { ...record, state: "confirmed", result: { project: project("/notes"), focusedExisting: false } });
    const { client, emit } = remote();
    const { onAdded } = mount(client, { host: { ...host, connectionState: "disconnected" } });
    expect(screen.getByText("Project added. Reconnect to refresh and focus it; no further add is needed.")).toBeInTheDocument();
    expect(client.request).not.toHaveBeenCalled(); expect(onAdded).not.toHaveBeenCalled(); expect(add()).toBeDisabled();
    await act(async () => emit("connected"));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith({ project: project("/notes"), focusedExisting: false }));
    expect(calls(client, "project.add")).toHaveLength(0);
  });

  it("provides Chinese labels and announced path errors", async () => {
    await i18n.changeLanguage("zh-CN"); const { client } = remote(); mount(client);
    await screen.findByRole("button", { name: "打开目录 work" });
    fireEvent.change(screen.getByLabelText("远程绝对路径"), { target: { value: "~/notes" } });
    fireEvent.click(screen.getByRole("button", { name: "前往" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请输入有效的远程绝对目录路径");
    expect(screen.getByLabelText("显示名称（可选）")).toBeInTheDocument();
  });
});
