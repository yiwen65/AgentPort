import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import type { HostProfileSummary, RemoteClient, RemoteConnectionStateEvent } from "../../protocol/remoteClient";
import type { OpenSession } from "../sessions/types";
import { FileContent, localFileLink } from "./FileContent";
import { SessionFiles, type FileListing } from "./SessionFiles";
import { FileDownloadProvider } from "./FileDownloads";
import type { FileDownloadClient } from "../../protocol/fileDownloadClient";

const open = { hostProfileId: "host", hostName: "Host", session: { id: "session", cwd: "/project" } } as OpenSession;
const listing = (path = "."): FileListing => ({ rootPath: "/project", path, truncated: false, entries: path === "." ? [
  { name: "README.md", path: "README.md", isDir: false }, { name: "src", path: "src", isDir: true }, { name: ".git", path: ".git", isDir: true },
] : [{ name: "main.ts", path: "src/main.ts", isDir: false }] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function remote() {
  let connection: (event: RemoteConnectionStateEvent) => void = () => {};
  const unsubscribe = vi.fn(async () => {});
  const client: RemoteClient = {
    listHostProfiles: vi.fn().mockResolvedValue([{ id: "host", connectionState: "connected" } as HostProfileSummary]),
    connect: vi.fn(), disconnect: vi.fn(), subscribe: vi.fn(),
    onConnectionState: vi.fn(async listener => { connection = listener; return unsubscribe; }),
    request: vi.fn().mockImplementation(async (_host, method, params) => method === "session.files.list" ? listing(params.path)
      : { rootPath: "/project", path: params.path, content: params.path.endsWith(".md") ? "# Read me\n\n[Source](src/main.ts)" : "const answer = 42;", sizeBytes: 30, truncated: false }),
  };
  return { client, unsubscribe, emit: (state: RemoteConnectionStateEvent["state"], profileId = "host") => connection({ profileId, state }) };
}
function mount(client: RemoteClient) {
  const props = { client, open, active: true, onBack: vi.fn() };
  return { ...render(<SessionFiles {...props} />), props };
}
const row = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });
const calls = (client: RemoteClient, method: string) => vi.mocked(client.request).mock.calls.filter(([, called]) => called === `session.files.${method}`);
beforeEach(async () => { await i18n.changeLanguage("en-US"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("SessionFiles", () => {
  it("offers download from file actions without opening preview or disturbing directory taps", async () => {
    const { client } = remote();
    const download: FileDownloadClient = { available: () => true, start: vi.fn().mockResolvedValue({ jobId: "job", profileId: "host", sessionId: "session", path: "README.md", name: "README.md", totalBytes: 10, receivedBytes: 0, state: "downloading" }), poll: vi.fn().mockResolvedValue({ state: "downloading" }), cancel: vi.fn().mockResolvedValue({ state: "cancelled" }), save: vi.fn().mockResolvedValue({ state: "saved" }), discard: vi.fn().mockResolvedValue(undefined) };
    render(<FileDownloadProvider client={download}><SessionFiles open={open} client={client} active onBack={() => {}} /></FileDownloadProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "File actions for README.md" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("complete original file");
    expect(calls(client, "read")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Download file" }));
    await waitFor(() => expect(download.start).toHaveBeenCalledWith({ profileId: "host", sessionId: "session", path: "README.md" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps download available in an unsupported binary preview and explains browser unavailability", async () => {
    const { client } = remote();
    vi.mocked(client.request).mockResolvedValueOnce({ ...listing(), entries: [{ name: "archive.zip", path: "archive.zip", isDir: false }] }).mockRejectedValueOnce({ code: "unsupported_file" });
    const download: FileDownloadClient = { available: () => true, start: vi.fn().mockResolvedValue({ jobId: "job", profileId: "host", sessionId: "session", path: "archive.zip", name: "archive.zip", totalBytes: 10, receivedBytes: 0, state: "downloading" }), poll: vi.fn().mockResolvedValue({ state: "downloading" }), cancel: vi.fn().mockResolvedValue({ state: "cancelled" }), save: vi.fn().mockResolvedValue({ state: "saved" }), discard: vi.fn().mockResolvedValue(undefined) };
    const view = render(<FileDownloadProvider client={download}><SessionFiles open={open} client={client} active onBack={() => {}} /></FileDownloadProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "archive.zip File" })); await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Download file" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Download file" }));
    await waitFor(() => expect(download.start).toHaveBeenCalledWith({ profileId: "host", sessionId: "session", path: "archive.zip" }));
    view.unmount();
    const state = remote(); mount(state.client);
    fireEvent.click(await screen.findByRole("button", { name: "File actions for README.md" }));
    expect(screen.getByText(/installed iOS\/Android app only/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Download file" })).toBeDisabled();
  });

  it("lazily loads sorted directories, reads code, preserves the tree/scroll, and backs out without terminal requests", async () => {
    const { client } = remote(); const view = mount(client);
    await screen.findByRole("button", { name: "src Directory" });
    expect(calls(client, "list")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /.git/ })).toBeNull();
    const entries = [...view.container.querySelectorAll(".files-row")];
    expect(entries.map(el => el.textContent)).toEqual(["▸srcDirectory", "≡README.mdFile"]);
    expect(entries[0]).toHaveAttribute("data-page-swipe", "true");
    fireEvent.click(row("src")); await screen.findByRole("button", { name: "main.ts File" });
    expect(calls(client, "list")[1][2]).toEqual({ sessionId: "session", path: "src" });
    const scroll = view.container.querySelector(".files-tree-scroll")!; scroll.scrollTop = 180;
    fireEvent.click(row("main.ts")); await screen.findByText("answer", { exact: false });
    expect(view.container.querySelector(".hljs-keyword")).toHaveTextContent("const");
    expect(view.container.querySelector(".files-preview-page")).toHaveAttribute("data-no-page-swipe", "true");
    expect(view.container.querySelector("pre")).toHaveAttribute("data-horizontal-scroll", "true");
    fireEvent.click(screen.getByRole("button", { name: "File tree" }));
    expect(view.container.querySelector(".files-tree-scroll")).toBe(scroll); expect(scroll.scrollTop).toBe(180);
    expect(row("src")).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Terminal" })); expect(view.props.onBack).toHaveBeenCalledOnce();
    expect(vi.mocked(client.request).mock.calls.every(([, method]) => method.startsWith("session.files."))).toBe(true);
  });

  it.each(["__proto__", "constructor", "toString"])("loads a directory named %s without confusing inherited object keys for cached data", async name => {
    const { client } = remote();
    vi.mocked(client.request).mockResolvedValueOnce({ ...listing(), entries: [{ name, path: name, isDir: true }] })
      .mockResolvedValueOnce({ ...listing(name), entries: [] });
    mount(client); fireEvent.click(await screen.findByRole("button", { name: `${name} Directory` }));
    await screen.findByText("This directory is empty.");
    expect(calls(client, "list")[1][2]).toEqual({ sessionId: "session", path: name });
  });

  it("refreshes all loaded directories on reopen while retaining expansion and discarding old responses", async () => {
    const { client } = remote(); const view = mount(client);
    await screen.findByRole("button", { name: "src Directory" }); fireEvent.click(row("src")); await screen.findByRole("button", { name: "main.ts File" });
    const late = deferred<FileListing>(); vi.mocked(client.request).mockImplementationOnce(() => late.promise);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    const oldSignal = calls(client, "list")[2][3]?.signal;
    view.rerender(<SessionFiles {...view.props} active={false} />);
    expect(oldSignal?.aborted).toBe(true);
    view.rerender(<SessionFiles {...view.props} />);
    await waitFor(() => expect(calls(client, "list")).toHaveLength(6));
    await act(async () => late.resolve({ ...listing(), entries: [{ name: "obsolete", path: "obsolete", isDir: false }] }));
    expect(screen.queryByText("obsolete")).toBeNull(); expect(row("src")).toHaveAttribute("aria-expanded", "true");
    expect(row("main.ts")).toBeVisible();
  });

  it("invalidates requests on disconnect, labels cached content, ignores other hosts, and refreshes on reconnect", async () => {
    const remoteState = remote(); const { client } = remoteState; mount(client);
    await screen.findByRole("button", { name: "src Directory" });
    act(() => remoteState.emit("disconnected", "other")); expect(screen.queryByText(/Computer disconnected/)).toBeNull();
    const late = deferred<FileListing>(); vi.mocked(client.request).mockImplementationOnce(() => late.promise);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    act(() => remoteState.emit("disconnected"));
    expect(screen.getByText(/Computer disconnected/)).toBeVisible(); expect(screen.getByText(/Showing previously loaded/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
    await act(async () => late.resolve({ ...listing(), entries: [] })); expect(row("src")).toBeVisible();
    act(() => remoteState.emit("connected")); await waitFor(() => expect(screen.queryByText(/Showing previously loaded/)).toBeNull());
    expect(screen.queryByText(/Computer disconnected/)).toBeNull();
  });

  it("ignores a late host snapshot after a connection event and unsubscribes on unmount", async () => {
    const state = remote(); const snapshot = deferred<HostProfileSummary[]>(); vi.mocked(state.client.listHostProfiles).mockReturnValue(snapshot.promise);
    const view = mount(state.client); await screen.findByRole("button", { name: "src Directory" });
    act(() => state.emit("disconnected"));
    await act(async () => snapshot.resolve([{ id: "host", connectionState: "connected" } as HostProfileSummary]));
    expect(screen.getByText(/Computer disconnected/)).toBeVisible(); view.unmount(); expect(state.unsubscribe).toHaveBeenCalledOnce();
  });

  it("explains old servers without falling back, permits retry, and presents empty/truncated directories", async () => {
    const { client } = remote(); vi.mocked(client.request).mockRejectedValueOnce({ code: "unknown_method" }); mount(client);
    expect(await screen.findByRole("alert")).toHaveTextContent("Upgrade AgentPort");
    vi.mocked(client.request).mockResolvedValueOnce({ ...listing(), entries: [], truncated: true });
    fireEvent.click(screen.getByRole("button", { name: "Retry" })); await screen.findByText("This directory is empty.");
    expect(screen.getByText(/up to 2000/)).toBeVisible();
    expect(vi.mocked(client.request).mock.calls.every(([, method]) => method === "session.files.list")).toBe(true);
  });

  it.each([ ["permission_denied", "cannot read this path"], ["path_not_found", "Path not found"], ["outside_root", "outside the Session"], ["unsupported_file", "Only regular UTF-8"], ["unsupported_platform", "not yet supported on this computer"] ])("shows %s preview errors and retries", async (code, text) => {
    const { client } = remote(); mount(client); await screen.findByRole("button", { name: "README.md File" });
    vi.mocked(client.request).mockRejectedValueOnce({ code }); fireEvent.click(row("README"));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    fireEvent.click(screen.getByRole("button", { name: "Retry" })); expect(await screen.findByRole("heading", { name: "Read me" })).toBeVisible();
  });

  it("switches Markdown/source, follows local links, copies paths/content/excerpts and reports clipboard failures", async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) }; vi.stubGlobal("navigator", { ...navigator, clipboard });
    const { client } = remote(); mount(client); await screen.findByRole("button", { name: "README.md File" }); fireEvent.click(row("README"));
    await screen.findByRole("heading", { name: "Read me" });
    fireEvent.click(screen.getByRole("button", { name: "Copy relative path" })); await screen.findByText("Copied."); expect(clipboard.writeText).toHaveBeenLastCalledWith("README.md");
    fireEvent.click(screen.getByRole("button", { name: "View source" })); expect(screen.queryByRole("heading", { name: "Read me" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Render Markdown" }));
    vi.mocked(client.request).mockResolvedValueOnce({ rootPath: "/project", path: "src/main.ts", content: "partial", sizeBytes: 2_000_000, truncated: true });
    fireEvent.click(screen.getByRole("button", { name: "Source" })); await screen.findByText("partial"); expect(screen.getByText(/first 1 MiB/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Copy excerpt" })); await waitFor(() => expect(clipboard.writeText).toHaveBeenLastCalledWith("partial"));
    clipboard.writeText.mockRejectedValueOnce(new Error("denied")); fireEvent.click(screen.getByRole("button", { name: "Copy relative path" })); expect(await screen.findByText(/Copy failed/)).toBeVisible();
  });

  it("opens offline with an honest empty-cache state and loads after reconnect", async () => {
    const state = remote(); vi.mocked(state.client.listHostProfiles).mockResolvedValue([{ id: "host", connectionState: "disconnected" } as HostProfileSummary]);
    const late = deferred<FileListing>(); vi.mocked(state.client.request).mockImplementationOnce(() => late.promise);
    mount(state.client); await screen.findByText(/Computer disconnected/);
    expect(screen.queryByText("This directory is empty.")).toBeNull();
    await act(async () => late.resolve(listing())); expect(screen.queryByRole("button", { name: "src Directory" })).toBeNull();
    act(() => state.emit("connected")); expect(await screen.findByRole("button", { name: "src Directory" })).toBeVisible();
  });

  it("hides preview on leaving and reenters the preserved tree without creating a keyboard input", async () => {
    const { client } = remote(); const view = mount(client); await screen.findByRole("button", { name: "README.md File" });
    fireEvent.click(row("README")); await screen.findByRole("heading", { name: "Read me" });
    view.rerender(<SessionFiles {...view.props} active={false} />); expect(screen.queryByRole("heading", { name: "Read-only preview" })).toBeNull();
    view.rerender(<SessionFiles {...view.props} />); await screen.findByRole("button", { name: "README.md File" });
    expect(view.container.querySelector("input,textarea,[contenteditable=true]")).toBeNull();
    expect(screen.getByRole("heading", { name: "Project files" })).toBeVisible();
  });

  it("never displays a late preview after back or a different read", async () => {
    const { client } = remote(); mount(client); await screen.findByRole("button", { name: "README.md File" });
    const late = deferred<unknown>(); vi.mocked(client.request).mockImplementationOnce(() => late.promise); fireEvent.click(row("README"));
    const signal = calls(client, "read")[0][3]?.signal;
    fireEvent.click(screen.getByRole("button", { name: "File tree" })); expect(signal?.aborted).toBe(true);
    fireEvent.click(row("src")); await screen.findByRole("button", { name: "main.ts File" }); fireEvent.click(row("main.ts")); await screen.findByText("answer", { exact: false });
    await act(async () => late.resolve({ content: "OLD README", truncated: false })); expect(screen.queryByText("OLD README")).toBeNull();
  });
});

describe("safe content rendering", () => {
  it("blocks raw HTML, scripts, remote/relative images and executable/external links", () => {
    const onOpen = vi.fn(); const { container } = render(<FileContent path="docs/readme.md" rendered content={'<script>alert(1)</script>\n\n<iframe src="https://bad.example" />\n\n![remote](https://bad.example/a.png) ![local](image.png)\n\n[bad](javascript:alert%281%29) [external](https://bad.example) [relative](../src/main.ts)'} onOpen={onOpen} />);
    expect(container.querySelector("script,iframe,img,a,video,audio,object,embed")).toBeNull();
    expect(screen.getAllByText(/Image not loaded/)).toHaveLength(2); expect(screen.getAllByText(/Link disabled/)).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "relative" })); expect(onOpen).toHaveBeenCalledWith("src/main.ts");
  });
  it.each(["../../escape", "/etc/passwd", "//example.com/a", "https://example.com", "javascript:alert(1)", "data:text/html,hi", "%2e%2e/%2e%2e/escape", "..%5cescape", "bad%00name", "#anchor", "bad%ZZ"])('rejects %s', href => expect(localFileLink("docs/readme.md", href)).toBeNull());
  it("normalizes safe links without passing fragments or queries to the service", () => expect(localFileLink("docs/readme.md", "../src/main.ts?view=1#L2")).toBe("src/main.ts"));
  it("supports local filenames containing spaces and Unicode", () => {
    expect(localFileLink("docs/readme.md", "./my%20file.md")).toBe("docs/my file.md");
    const onOpen = vi.fn(); render(<FileContent path="docs/readme.md" content="[Notes](<my 笔记.md>)" rendered onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "Notes" })); expect(onOpen).toHaveBeenCalledWith("docs/my 笔记.md");
  });
  it("escapes HTML in code and keeps oversized content readable without highlighting", () => {
    const { container, rerender } = render(<FileContent path="test.ts" content={'const x = "<img src=x onerror=alert(1)>";'} rendered={false} onOpen={() => {}} />);
    expect(container.querySelector("img")).toBeNull(); expect(container.querySelector(".hljs-keyword")).not.toBeNull();
    rerender(<FileContent path="test.ts" content={"x".repeat(100_001)} rendered={false} onOpen={() => {}} />); expect(container.querySelector("code")?.textContent?.length).toBe(100_001); expect(container.querySelector("code span")).toBeNull();
  });
});
