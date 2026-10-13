import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import type { HostProfileSummary, RemoteClient, RemoteConnectionStateEvent } from "../../protocol/remoteClient";
import type { OpenSession } from "../sessions/types";
import { FileContent, localFileLink } from "./FileContent";
import { SessionFiles, type FileListing } from "./SessionFiles";
import { FileDownloadProvider } from "./FileDownloads";
import type { FileDownloadClient } from "../../protocol/fileDownloadClient";

const open = { hostProfileId: "host", hostName: "Host", session: { id: "session", title: "Task", cwd: "/project" } } as OpenSession;
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
      : { rootPath: "/project", path: params.path, content: params.path.endsWith(".md") ? "# Read me\n\nOrdinary reading text.\n\n[Source](src/main.ts)" : "const answer = 42;", sizeBytes: 30, truncated: false }),
  };
  return { client, unsubscribe, emit: (state: RemoteConnectionStateEvent["state"], profileId = "host") => connection({ profileId, state }) };
}
function downloads(): FileDownloadClient {
  const snapshot = { jobId: "job", profileId: "host", sessionId: "session", path: "a.zip", name: "a.zip", totalBytes: 10, receivedBytes: 0, state: "downloading" as const };
  return { available: () => true, start: vi.fn().mockResolvedValue(snapshot), poll: vi.fn().mockResolvedValue(snapshot), cancel: vi.fn().mockResolvedValue({ ...snapshot, state: "cancelled" }), save: vi.fn().mockResolvedValue({ ...snapshot, state: "saved" }), discard: vi.fn().mockResolvedValue(undefined) };
}
function mount(client: RemoteClient) {
  const props = { client, open, active: true, onBack: vi.fn() };
  return { ...render(<SessionFiles {...props} />), props };
}
const row = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });
const calls = (client: RemoteClient, method: string) => vi.mocked(client.request).mock.calls.filter(([, called]) => called === `session.files.${method}`);
function more() { fireEvent.click(screen.getByRole("button", { name: /^More file actions/ })); return screen.getByRole("dialog"); }
function action(name: string) { fireEvent.click(within(more()).getByRole("button", { name })); }
function swipe(node: Element, x: number, to: number, y = 200) {
  fireEvent.touchStart(node, { touches: [{ identifier: 1, clientX: x, clientY: y }] });
  fireEvent.touchMove(node, { touches: [{ identifier: 1, clientX: to, clientY: y + 2 }] });
  fireEvent.touchEnd(node, { changedTouches: [{ identifier: 1, clientX: to, clientY: y + 2 }], touches: [] });
}
function width(container: Element) {
  const viewport = container.querySelector(".files-page-viewport")!;
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 390, height: 844, left: 0, right: 390, top: 0, bottom: 844, toJSON() {} });
}
beforeEach(async () => { await i18n.changeLanguage("en-US"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("SessionFiles", () => {
  it("places only filename/back/more above healthy content and moves actions/information to the menu", async () => {
    const { client } = remote(); const view = mount(client);
    fireEvent.click(await screen.findByRole("button", { name: "README.md File" })); await screen.findByRole("heading", { name: "Read me" });
    const preview = view.container.querySelector(".files-preview-page")!;
    expect(within(preview as HTMLElement).getByRole("heading", { name: "README.md" })).toBeVisible();
    expect(preview.querySelectorAll(".files-header button")).toHaveLength(2);
    expect(preview.querySelector(".files-root,.files-actions,.files-caption")).toBeNull();
    expect(screen.queryByText(/^Safe preview:/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy content" })).toBeNull();
    const menu = more(); expect(within(menu).getByRole("button", { name: "Refresh" })).toBeEnabled();
    expect(within(menu).getByRole("button", { name: "Copy content" })).toBeEnabled();
    fireEvent.click(within(menu).getByRole("button", { name: "File information and safety" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("/project/README.md");
    expect(screen.getByRole("dialog")).toHaveTextContent("images, HTML and external resources are not loaded");
  });
  it("keeps the same preview DOM, scroll and source mode across back/resume without another read", async () => {
    const { client } = remote(); const view = mount(client);
    const treeScroll = view.container.querySelector(".files-tree-scroll")!; treeScroll.scrollTop = 140;
    fireEvent.click(await screen.findByRole("button", { name: "README.md File" })); await screen.findByRole("heading", { name: "Read me" });
    action("View source");
    const code = view.container.querySelector(".files-source"); const body = view.container.querySelector(".files-preview-scroll")!; body.scrollTop = 180;
    fireEvent.click(screen.getByRole("button", { name: "File tree" }));
    expect(view.container.querySelector(".files-tree-scroll")).toBe(treeScroll); expect(treeScroll.scrollTop).toBe(140);
    expect(screen.queryByRole("button", { name: "File tree" })).toBeNull();
    action("Continue reading README.md");
    expect(view.container.querySelector(".files-source")).toBe(code); expect(body.scrollTop).toBe(180);
    expect(calls(client, "read")).toHaveLength(1); expect(within(more()).getByRole("button", { name: "Render Markdown" })).toBeVisible();
  });
  it("keeps rendered Markdown code DOM and horizontal position through menus and page navigation", async () => {
    const { client } = remote(); const view = mount(client);
    await screen.findByRole("button", { name: "README.md File" });
    vi.mocked(client.request).mockResolvedValueOnce({ rootPath: "/project", path: "README.md", content: "# Notes\n\n```ts\nconst value = 'a very long code line';\n```", sizeBytes: 60, truncated: false });
    fireEvent.click(row("README")); await screen.findByRole("heading", { name: "Notes" });
    const code = view.container.querySelector(".files-markdown pre")!; code.scrollLeft = 87;
    const menu = more(); fireEvent.click(within(menu).getByRole("button", { name: "Close" }));
    expect(view.container.querySelector(".files-markdown pre")).toBe(code); expect(code.scrollLeft).toBe(87);
    fireEvent.click(screen.getByRole("button", { name: "File tree" })); action("Continue reading README.md");
    expect(view.container.querySelector(".files-markdown pre")).toBe(code); expect(code.scrollLeft).toBe(87);
    expect(calls(client, "read")).toHaveLength(1);
  });
  it("keeps rendered code and link nodes while native download progress updates", async () => {
    const { client } = remote(); const download = downloads();
    const view = render(<FileDownloadProvider client={download}><SessionFiles open={open} client={client} active onBack={() => {}} /></FileDownloadProvider>);
    await screen.findByRole("button", { name: "README.md File" });
    vi.mocked(client.request).mockResolvedValueOnce({ rootPath: "/project", path: "README.md", content: "# Notes\n\n[Source](src/main.ts)\n\n```ts\nconst value = 'a very long code line';\n```", sizeBytes: 80, truncated: false });
    fireEvent.click(row("README")); await screen.findByRole("heading", { name: "Notes" });
    const code = view.container.querySelector(".files-markdown pre")!; const link = screen.getByRole("link", { name: "Source" }); code.scrollLeft = 87;
    action("Download file"); await waitFor(() => expect(download.poll).toHaveBeenCalled());
    expect(view.container.querySelector(".files-markdown pre")).toBe(code); expect(code.scrollLeft).toBe(87);
    expect(screen.getByRole("link", { name: "Source" })).toBe(link); expect(screen.queryByRole("complementary")).toBeNull();
  });
  it("consumes one-layer preview swipes and resumes by tree swipe without losing selection or reading mode", async () => {
    const { client } = remote(); const parent = vi.fn();
    const view = render(<div onTouchEnd={parent}><SessionFiles open={open} client={client} active onBack={() => {}} /></div>); width(view.container);
    fireEvent.click(await screen.findByRole("button", { name: "README.md File" })); await screen.findByRole("heading", { name: "Read me" });
    swipe(screen.getByText("Ordinary reading text."), 60, 240);
    expect(screen.getByRole("heading", { name: "project" })).toBeVisible(); expect(parent).not.toHaveBeenCalled();
    // The settling guard lasts 250ms; the next deliberate gesture starts later.
    await act(() => new Promise(resolve => setTimeout(resolve, 270)));
    swipe(view.container.querySelector(".files-tree-scroll")!, 270, 80);
    expect(screen.getByRole("heading", { name: "README.md" })).toBeVisible(); expect(calls(client, "read")).toHaveLength(1);
  });
  it("never enters an empty preview and keeps code/link gestures out of page navigation", async () => {
    const { client } = remote(); const view = mount(client); width(view.container);
    await screen.findByRole("button", { name: "README.md File" }); swipe(view.container.querySelector(".files-tree-scroll")!, 270, 80);
    expect(screen.queryByRole("button", { name: "File tree" })).toBeNull();
    fireEvent.click(row("README")); await screen.findByRole("heading", { name: "Read me" });
    swipe(screen.getByRole("link", { name: "Source" }), 60, 240);
    expect(screen.getByRole("button", { name: "File tree" })).toBeVisible();
    action("View source"); swipe(view.container.querySelector("pre")!, 60, 240);
    expect(screen.getByRole("button", { name: "File tree" })).toBeVisible();
  });
  it("offers download from file actions without opening preview or disturbing directory taps", async () => {
    const { client } = remote(); const download = downloads();
    render(<FileDownloadProvider client={download}><SessionFiles open={open} client={client} active onBack={() => {}} /></FileDownloadProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "File actions for README.md" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("complete original file"); expect(calls(client, "read")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Download file" }));
    await waitFor(() => expect(download.start).toHaveBeenCalledWith({ profileId: "host", sessionId: "session", path: "README.md" }));
    expect(screen.queryByRole("dialog")).toBeNull(); expect(screen.queryByRole("complementary")).toBeNull();
    const menu = more(); fireEvent.click(within(menu).getByRole("button", { name: /File download/ }));
    expect(await screen.findByRole("dialog", { name: "File download" })).toHaveTextContent("Host · Task");
    expect(screen.getByRole("button", { name: "Cancel download" })).toBeEnabled();
  });
  it("keeps download in the binary preview menu and explains browser unavailability", async () => {
    const { client } = remote(); vi.mocked(client.request).mockResolvedValueOnce({ ...listing(), entries: [{ name: "archive.zip", path: "archive.zip", isDir: false }] }).mockRejectedValueOnce({ code: "unsupported_file" });
    const download = downloads(); const view = render(<FileDownloadProvider client={download}><SessionFiles open={open} client={client} active onBack={() => {}} /></FileDownloadProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "archive.zip File" })); await screen.findByRole("alert");
    const menu = more(); expect(within(menu).getByRole("button", { name: "Download file" })).toBeEnabled(); fireEvent.click(within(menu).getByRole("button", { name: "Download file" }));
    await waitFor(() => expect(download.start).toHaveBeenCalledWith({ profileId: "host", sessionId: "session", path: "archive.zip" }));
    view.unmount(); const state = remote(); mount(state.client); fireEvent.click(await screen.findByRole("button", { name: "File actions for README.md" }));
    expect(screen.getByText(/installed iOS\/Android app only/)).toBeVisible(); expect(screen.getByRole("button", { name: "Download file" })).toBeDisabled();
  });
  it("lazily loads sorted directories, reads code and preserves tree/scroll without terminal requests", async () => {
    const { client } = remote(); const view = mount(client); await screen.findByRole("button", { name: "src Directory" });
    expect(calls(client, "list")).toHaveLength(1); expect(screen.queryByRole("button", { name: /.git/ })).toBeNull();
    const entries = [...view.container.querySelectorAll(".files-row")]; expect(entries.map(el => el.textContent)).toEqual(["▸srcDirectory", "≡README.mdFile"]);
    expect(entries[0]).toHaveAttribute("data-page-swipe", "true"); fireEvent.click(row("src")); await screen.findByRole("button", { name: "main.ts File" });
    expect(calls(client, "list")[1][2]).toEqual({ sessionId: "session", path: "src" });
    const scroll = view.container.querySelector(".files-tree-scroll")!; scroll.scrollTop = 180;
    fireEvent.click(row("main.ts")); await screen.findByText("answer", { exact: false }); expect(view.container.querySelector(".hljs-keyword")).toHaveTextContent("const");
    expect(view.container.querySelector(".files-preview-page")).toHaveAttribute("data-no-page-swipe", "true"); expect(view.container.querySelector("pre")).toHaveAttribute("data-horizontal-scroll", "true");
    fireEvent.click(screen.getByRole("button", { name: "File tree" })); expect(view.container.querySelector(".files-tree-scroll")).toBe(scroll); expect(scroll.scrollTop).toBe(180); expect(row("src")).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Terminal" })); expect(view.props.onBack).toHaveBeenCalledOnce(); expect(vi.mocked(client.request).mock.calls.every(([, method]) => method.startsWith("session.files."))).toBe(true);
  });
  it.each(["__proto__", "constructor", "toString"])("loads directory %s without confusing inherited keys with cache", async name => {
    const { client } = remote(); vi.mocked(client.request).mockResolvedValueOnce({ ...listing(), entries: [{ name, path: name, isDir: true }] }).mockResolvedValueOnce({ ...listing(name), entries: [] });
    mount(client); fireEvent.click(await screen.findByRole("button", { name: `${name} Directory` })); await screen.findByText("This directory is empty."); expect(calls(client, "list")[1][2]).toEqual({ sessionId: "session", path: name });
  });
  it("refreshes loaded directories on reopen retaining expansion and discarding old responses", async () => {
    const { client } = remote(); const view = mount(client); await screen.findByRole("button", { name: "src Directory" }); fireEvent.click(row("src")); await screen.findByRole("button", { name: "main.ts File" });
    const late = deferred<FileListing>(); vi.mocked(client.request).mockImplementationOnce(() => late.promise); action("Refresh"); const oldSignal = calls(client, "list")[2][3]?.signal;
    view.rerender(<SessionFiles {...view.props} active={false} />); expect(oldSignal?.aborted).toBe(true); view.rerender(<SessionFiles {...view.props} />);
    await waitFor(() => expect(calls(client, "list")).toHaveLength(6)); await act(async () => late.resolve({ ...listing(), entries: [{ name: "obsolete", path: "obsolete", isDir: false }] }));
    expect(screen.queryByText("obsolete")).toBeNull(); expect(row("src")).toHaveAttribute("aria-expanded", "true"); expect(row("main.ts")).toBeVisible();
  });
  it("invalidates disconnect requests, labels cache, ignores other hosts and refreshes on reconnect", async () => {
    const state = remote(); const { client } = state; mount(client); await screen.findByRole("button", { name: "src Directory" });
    act(() => state.emit("disconnected", "other")); expect(screen.queryByText(/Disconnected · cached/)).toBeNull();
    const late = deferred<FileListing>(); vi.mocked(client.request).mockImplementationOnce(() => late.promise); action("Refresh"); act(() => state.emit("disconnected"));
    expect(screen.getByText(/Disconnected · cached/)).toBeVisible(); const menu = more(); expect(within(menu).getByRole("button", { name: "Refresh" })).toBeDisabled(); fireEvent.click(within(menu).getByRole("button", { name: "Close" }));
    await act(async () => late.resolve({ ...listing(), entries: [] })); expect(row("src")).toBeVisible();
    act(() => state.emit("connected")); await waitFor(() => expect(screen.queryByText(/Cached content · not yet/)).toBeNull()); expect(screen.queryByText(/Disconnected · cached/)).toBeNull();
  });
  it("ignores late host snapshot after connection event and unsubscribes on unmount", async () => {
    const state = remote(); const snapshot = deferred<HostProfileSummary[]>(); vi.mocked(state.client.listHostProfiles).mockReturnValue(snapshot.promise); const view = mount(state.client);
    await screen.findByRole("button", { name: "src Directory" }); act(() => state.emit("disconnected")); await act(async () => snapshot.resolve([{ id: "host", connectionState: "connected" } as HostProfileSummary]));
    expect(screen.getByText(/Disconnected · cached/)).toBeVisible(); view.unmount(); expect(state.unsubscribe).toHaveBeenCalledOnce();
  });
  it("explains old servers without fallback, permits retry and presents empty/truncated directories", async () => {
    const { client } = remote(); vi.mocked(client.request).mockRejectedValueOnce({ code: "unknown_method" }); mount(client); expect(await screen.findByRole("alert")).toHaveTextContent("Upgrade AgentPort");
    vi.mocked(client.request).mockResolvedValueOnce({ ...listing(), entries: [], truncated: true }); fireEvent.click(screen.getByRole("button", { name: "Retry" })); await screen.findByText("This directory is empty."); expect(screen.getByText(/up to 2000/)).toBeVisible(); expect(vi.mocked(client.request).mock.calls.every(([, method]) => method === "session.files.list")).toBe(true);
  });
  it.each([["permission_denied", "cannot read this path"], ["path_not_found", "Path not found"], ["outside_root", "outside the Session"], ["unsupported_file", "Only regular UTF-8"], ["unsupported_platform", "not yet supported on this computer"]])("shows %s errors and retries", async (code, text) => {
    const { client } = remote(); mount(client); await screen.findByRole("button", { name: "README.md File" }); vi.mocked(client.request).mockRejectedValueOnce({ code }); fireEvent.click(row("README"));
    expect(await screen.findByRole("alert")).toHaveTextContent(text); fireEvent.click(screen.getByRole("button", { name: "Retry" })); expect(await screen.findByRole("heading", { name: "Read me" })).toBeVisible();
  });
  it("switches modes, follows local links, copies paths/content/excerpts and reports clipboard failures", async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) }; vi.stubGlobal("navigator", { ...navigator, clipboard }); const { client } = remote(); mount(client);
    fireEvent.click(await screen.findByRole("button", { name: "README.md File" })); await screen.findByRole("heading", { name: "Read me" });
    action("Copy relative path"); await screen.findByText("Copied."); expect(clipboard.writeText).toHaveBeenLastCalledWith("README.md");
    action("View source"); expect(screen.queryByRole("heading", { name: "Read me" })).toBeNull(); action("Render Markdown");
    vi.mocked(client.request).mockResolvedValueOnce({ rootPath: "/project", path: "src/main.ts", content: "partial", sizeBytes: 2_000_000, truncated: true });
    fireEvent.click(screen.getByRole("link", { name: "Source" })); await screen.findByText("partial"); expect(screen.getByRole("button", { name: /first 1 MiB/ })).toBeVisible();
    action("Copy excerpt"); await waitFor(() => expect(clipboard.writeText).toHaveBeenLastCalledWith("partial")); clipboard.writeText.mockRejectedValueOnce(new Error("denied")); action("Copy relative path"); expect(await screen.findByText(/Copy failed/)).toBeVisible();
  });
  it("dismisses copy feedback without inserting a permanent content row", async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) }; vi.stubGlobal("navigator", { ...navigator, clipboard });
    const { client } = remote(); const view = mount(client);
    fireEvent.click(await screen.findByRole("button", { name: "README.md File" })); await screen.findByRole("heading", { name: "Read me" });
    const menu = more();
    vi.useFakeTimers();
    try {
      await act(async () => { fireEvent.click(within(menu).getByRole("button", { name: "Copy relative path" })); });
      expect(screen.getByText("Copied.")).toHaveClass("files-toast");
      act(() => vi.advanceTimersByTime(3100));
      expect(screen.queryByText("Copied.")).toBeNull(); expect(view.container.querySelector(".files-preview-scroll .files-toast")).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it("opens offline with an honest empty cache and loads after reconnect", async () => {
    const state = remote(); vi.mocked(state.client.listHostProfiles).mockResolvedValue([{ id: "host", connectionState: "disconnected" } as HostProfileSummary]); const late = deferred<FileListing>(); vi.mocked(state.client.request).mockImplementationOnce(() => late.promise);
    mount(state.client); await screen.findByText(/Disconnected · cached/); expect(screen.queryByText("This directory is empty.")).toBeNull(); await act(async () => late.resolve(listing())); expect(screen.queryByRole("button", { name: "src Directory" })).toBeNull(); act(() => state.emit("connected")); expect(await screen.findByRole("button", { name: "src Directory" })).toBeVisible();
  });
  it("reenters tree on activation but remembers the prior preview without keyboard input", async () => {
    const { client } = remote(); const view = mount(client); fireEvent.click(await screen.findByRole("button", { name: "README.md File" })); await screen.findByRole("heading", { name: "Read me" });
    view.rerender(<SessionFiles {...view.props} active={false} />); expect(screen.queryByRole("button", { name: "File tree" })).toBeNull(); view.rerender(<SessionFiles {...view.props} />); await screen.findByRole("button", { name: "README.md File" });
    expect(view.container.querySelector("input,textarea,[contenteditable=true]")).toBeNull(); expect(screen.getByRole("heading", { name: "project" })).toBeVisible(); action("Continue reading README.md"); expect(screen.getByRole("heading", { name: "README.md" })).toBeVisible();
  });
  it("keeps a pending read when going back, but fences it when selecting a different file", async () => {
    const { client } = remote(); mount(client); await screen.findByRole("button", { name: "README.md File" }); const late = deferred<unknown>(); vi.mocked(client.request).mockImplementationOnce(() => late.promise); fireEvent.click(row("README")); const signal = calls(client, "read")[0][3]?.signal;
    fireEvent.click(screen.getByRole("button", { name: "File tree" })); expect(signal?.aborted).toBe(false); fireEvent.click(row("src")); await screen.findByRole("button", { name: "main.ts File" }); fireEvent.click(row("main.ts")); await screen.findByText("answer", { exact: false }); expect(signal?.aborted).toBe(true);
    await act(async () => late.resolve({ content: "OLD README", truncated: false })); expect(screen.queryByText("OLD README")).toBeNull();
  });
});

describe("safe content rendering", () => {
  it("blocks HTML/resources/unsafe links and exposes local links with link semantics", () => {
    const onOpen = vi.fn(); const { container } = render(<FileContent path="docs/readme.md" rendered content={'<script>alert(1)</script>\n\n<iframe src="https://bad.example" />\n\n![remote](https://bad.example/a.png) ![local](image.png)\n\n[bad](javascript:alert%281%29) [external](https://bad.example) [relative](../src/main.ts)'} onOpen={onOpen} />);
    expect(container.querySelector("script,iframe,img,a,video,audio,object,embed")).toBeNull(); expect(screen.getAllByText(/Image not loaded/)).toHaveLength(2); expect(screen.getAllByText(/Link disabled/)).toHaveLength(2); expect(screen.queryByText(/^Safe preview:/)).toBeNull(); fireEvent.click(screen.getByRole("link", { name: "relative" })); expect(onOpen).toHaveBeenCalledWith("src/main.ts");
  });
  it.each(["../../escape", "/etc/passwd", "//example.com/a", "https://example.com", "javascript:alert(1)", "data:text/html,hi", "%2e%2e/%2e%2e/escape", "..%5cescape", "bad%00name", "#anchor", "bad%ZZ"])("rejects %s", href => expect(localFileLink("docs/readme.md", href)).toBeNull());
  it("normalizes safe links without fragments/query", () => expect(localFileLink("docs/readme.md", "../src/main.ts?view=1#L2")).toBe("src/main.ts"));
  it("supports local spaces and Unicode", () => {
    expect(localFileLink("docs/readme.md", "./my%20file.md")).toBe("docs/my file.md"); const onOpen = vi.fn(); render(<FileContent path="docs/readme.md" content="[Notes](<my 笔记.md>)" rendered onOpen={onOpen} />); fireEvent.click(screen.getByRole("link", { name: "Notes" })); expect(onOpen).toHaveBeenCalledWith("docs/my 笔记.md");
  });
  it("escapes code HTML and bounds highlighter work", () => {
    const { container, rerender } = render(<FileContent path="test.ts" content={'const x = "<img src=x onerror=alert(1)>";'} rendered={false} onOpen={() => {}} />); expect(container.querySelector("img")).toBeNull(); expect(container.querySelector(".hljs-keyword")).not.toBeNull();
    rerender(<FileContent path="test.ts" content={"x".repeat(100_001)} rendered={false} onOpen={() => {}} />); expect(container.querySelector("code")?.textContent?.length).toBe(100_001); expect(container.querySelector("code span")).toBeNull();
  });
});
