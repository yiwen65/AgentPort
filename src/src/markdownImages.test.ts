import { beforeEach, describe, expect, it, vi } from "vitest";
import { IMAGE_CHUNK_BYTES, IMAGE_MAX_BYTES, MarkdownImageSession, imageTransport, readLocalMarkdownImage, resolveMarkdownImage, sanitizeMarkdownSvg, type ImageTransport, type ValidatedMarkdownImage } from "./markdownImages";
import { extractImageReferences, markdownImageTokens } from "./markdownImageGrammar";
import { invoke } from "@tauri-apps/api/core";
import { setRemoteBackendFactoryForTests, resetRemoteBackendsForTests } from "./remote/runtime";
import { setDeviceContext } from "./deviceContext";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
const context = { path: "/project/docs/read.md", rootPath: "/project", device: { kind: "local" as const } };
const png: ValidatedMarkdownImage = { mime: "image/png", width: 2, height: 3, contentBase64: btoa("png") };
function transport(): ImageTransport {
  return { open: vi.fn(async () => ({ downloadId: "id", sizeBytes: 3, chunkBytes: IMAGE_CHUNK_BYTES })), chunk: vi.fn(async (_id, offset) => ({ offset, contentBase64: btoa("png"), eof: true })), finish: vi.fn(async () => ({})), close: vi.fn(async () => ({})), fetch: vi.fn(async () => png), validate: vi.fn(async () => png) };
}
beforeEach(() => { vi.clearAllMocks(); resetRemoteBackendsForTests(); setDeviceContext({ kind: "local" }); URL.createObjectURL = vi.fn(() => "blob:test"); URL.revokeObjectURL = vi.fn(); });
describe("desktop image grammar", () => {
  it("parses Chinese/spaces, angle destinations, title, balanced and escaped parentheses", () => {
    const text = '![报告](../图 片/a(1).png "title") ![x](<图 片.png>) ![y](a\\(2\\).png)';
    expect(markdownImageTokens(text).map(t => t.source)).toEqual(["../图 片/a(1).png", "图 片.png", "a(2).png"]);
  });
  it("supports full/collapsed/shortcut case-insensitive references outside fences", () => {
    const parsed = extractImageReferences('![a][REF] ![name][] ![name]\n[ref]: <图 片.png> "title"\n[name]: a.png\n```\n[bad]: no.png\n```');
    expect(markdownImageTokens(parsed.source, parsed.references).map(t => t.source)).toEqual(["图 片.png", "a.png", "a.png"]);
    expect(parsed.references.has("bad")).toBe(false);
  });
  it("consumes image-wrapped links without turning them into navigable anchors", () => {
    const text = '[![a](a.png)](https://example.com)';
    expect(markdownImageTokens(text)).toEqual([{ start: 0, end: text.length, alt: "a", source: "a.png" }]);
    expect(markdownImageTokens('`![x](x.png)` \\![y](y.png)')).toEqual([]);
    expect(markdownImageTokens('``![x](x.png)``')).toEqual([]);
    expect(markdownImageTokens('![a](<a(b.png> "title)")')[0].source).toBe("a(b.png");
  });
});
describe("root and device boundaries", () => {
  it("allows root-contained parents but refuses absolute/protocol/escaped outside paths", () => {
    expect(resolveMarkdownImage("../图片 a.png", context)).toEqual({ kind: "local", path: "图片 a.png" });
    expect(resolveMarkdownImage("a.png?version=1#fragment", context)).toEqual({ kind: "local", path: "docs/a.png" });
    expect(resolveMarkdownImage("a%23b.png", context).path).toBe("docs/a#b.png");
    expect(resolveMarkdownImage("https://example.com:8443/a#fragment", context)).toEqual({ kind: "remote", path: "https://example.com:8443/a" });
    expect(() => resolveMarkdownImage("https://@example.com/a", context)).toThrow();
    for (const source of ["../../secret.png", "/project/a.png", "file:///a.png", "data:image/png;base64,a", "http://example.com/a", "//example.com/a", "%2fproject/a.png", "C:\\a.png", "..\\a.png", "https://u:p@example.com/a"]) expect(() => resolveMarkdownImage(source, context), source).toThrow();
  });
  it("pins remote chunks to the original backend and fetches remote HTTPS on reader native only", async () => {
    const backend = { documentImageOpen: vi.fn(async () => ({ downloadId: "r" })), documentImageChunk: vi.fn(), documentImageFinish: vi.fn(), documentImageClose: vi.fn() };
    const factory = vi.fn(() => backend as never); setRemoteBackendFactoryForTests(factory);
    const pinned = imageTransport({ kind: "remote", deviceId: "one", deviceName: "One", capabilities: [] });
    setDeviceContext({ kind: "remote", deviceId: "two", deviceName: "Two", capabilities: [] });
    await pinned.open("/project", "a.png"); await pinned.fetch("https://example.com/a");
    expect(factory).toHaveBeenCalledWith("one"); expect(backend.documentImageOpen).toHaveBeenCalledWith("/project", "a.png");
    expect(invoke).toHaveBeenCalledWith("markdown_image_fetch", { url: "https://example.com/a" });
  });
});
describe("image stream and lifetime", () => {
  it("checks finish before validation, closes on success and errors", async () => {
    const t = transport(); await readLocalMarkdownImage(t, "/project", "a.png");
    expect(t.chunk).toHaveBeenCalledWith("id", 0, IMAGE_CHUNK_BYTES);
    expect(vi.mocked(t.finish).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(t.validate).mock.invocationCallOrder[0]);
    expect(t.close).toHaveBeenCalledWith("id");
    vi.mocked(t.finish).mockRejectedValueOnce(new Error("source changed"));
    await expect(readLocalMarkdownImage(t, "/project", "a.png")).rejects.toThrow("source changed");
    expect(t.close).toHaveBeenCalledTimes(2);
  });
  it("rejects cap/invalid chunks without decoding and always closes", async () => {
    const t = transport(); vi.mocked(t.open).mockResolvedValueOnce({ downloadId: "id", sizeBytes: IMAGE_MAX_BYTES + 1, chunkBytes: IMAGE_CHUNK_BYTES });
    await expect(readLocalMarkdownImage(t, "/project", "a")).rejects.toThrow("20 MiB"); expect(t.validate).not.toHaveBeenCalled();
    vi.mocked(t.chunk).mockResolvedValueOnce({ offset: 1, contentBase64: btoa("png"), eof: true });
    await expect(readLocalMarkdownImage(t, "/project", "a")).rejects.toThrow("chunk"); expect(t.close).toHaveBeenCalledTimes(2);
  });
  it("makes zero remote requests until consent; reuses URLs, releases on disposal; consent is not shared", async () => {
    const t = transport(); const s = new MarkdownImageSession(context, t); const source = "https://example.com/a";
    await s.load(source); expect(s.snapshot(source).status).toBe("blocked"); expect(t.fetch).not.toHaveBeenCalled();
    s.allowRemote(); await s.load(source); await s.load(source); expect(t.fetch).toHaveBeenCalledTimes(1);
    s.dispose(); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
    const next = new MarkdownImageSession(context, t); await next.load(source); expect(next.consent).toBe(false); expect(t.fetch).toHaveBeenCalledTimes(1); next.dispose();
  });
  it("does not create blobs after disposal or after pixel cap failure", async () => {
    const t = transport(); let finish!: (value: ValidatedMarkdownImage) => void;
    vi.mocked(t.fetch).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const s = new MarkdownImageSession(context, t); s.allowRemote(); const loading = s.load("https://example.com/a"); await Promise.resolve(); s.dispose(); finish(png); await loading; expect(URL.createObjectURL).not.toHaveBeenCalled();
    const next = new MarkdownImageSession(context, t); next.allowRemote(); vi.mocked(t.fetch).mockResolvedValueOnce({ ...png, width: 20_000_001, height: 1 }); await next.load("https://example.com/a"); expect(next.snapshot("https://example.com/a").status).toBe("error"); expect(URL.createObjectURL).not.toHaveBeenCalled(); next.dispose();
  });
  it("bounds concurrent reads and cancels queued requests on document disposal", async () => {
    const t = transport();
    let release!: (value: ValidatedMarkdownImage) => void;
    const pending = new Promise<ValidatedMarkdownImage>((resolve) => { release = resolve; });
    vi.mocked(t.fetch).mockReturnValue(pending);
    const s = new MarkdownImageSession(context, t); s.allowRemote();
    const jobs = ["a", "b", "c"].map((name) => s.load(`https://example.com/${name}`));
    await Promise.resolve(); expect(t.fetch).toHaveBeenCalledTimes(2);
    s.dispose(); release(png); await Promise.all(jobs); expect(t.fetch).toHaveBeenCalledTimes(2); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it("caps retained compressed blobs at 64 MiB without evicting visible assets", async () => {
    const t = transport(); const large = { ...png, contentBase64: btoa("x".repeat(17 * 1024 * 1024)) };
    vi.mocked(t.fetch).mockResolvedValue(large);
    const s = new MarkdownImageSession(context, t); s.allowRemote();
    for (const name of ["a", "b", "c"]) { const source = `https://example.com/${name}`; s.retain(source); await s.load(source); }
    await s.load("https://example.com/d"); expect(s.snapshot("https://example.com/d").status).toBe("error"); expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    s.release("https://example.com/a"); await s.load("https://example.com/d", true);
    expect(s.snapshot("https://example.com/a").status).toBe("idle"); expect(s.snapshot("https://example.com/d").status).toBe("ready"); expect(URL.revokeObjectURL).toHaveBeenCalledOnce(); s.dispose();
  });
  it("cancels a disposed local reading between chunks and closes the handle", async () => {
    const t = transport(); await expect(readLocalMarkdownImage(t, "/project", "a", () => false)).rejects.toThrow("ended"); expect(t.chunk).not.toHaveBeenCalled(); expect(t.close).toHaveBeenCalledWith("id");
  });
});
describe("static SVG defense", () => {
  it("strips all resource/script/style surfaces while preserving local gradients/text", () => {
    const input = '<svg xmlns="http://www.w3.org/2000/svg" width="999999" height="999999"><script>alert(1)</script><foreignObject><p>x</p></foreignObject><image href="https://evil/a"/><style>path{fill:u\\72l(https://evil)}</style><a href="https://evil"><text onclick="x()">safe</text></a><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><path fill="url(#g)" stroke="url(https://evil)" style="stroke:url(https://evil)" d="M0 0"/></svg>';
    const clean = sanitizeMarkdownSvg(input, 10, 20);
    expect(clean).not.toMatch(/<script|foreignObject|<image|<style|<a |onclick|https:\/\/evil|999999/);
    expect(clean).toContain("url(#g)"); expect(clean).toContain("linearGradient"); expect(clean).toContain("safe"); expect(clean).toContain('width="10"'); expect(clean).toContain("overflow:hidden");
  });
  it("preserves safe class/inline paint/font styles as attributes and finite local use references", () => {
    const clean = sanitizeMarkdownSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20" style="width:999999px!important;height:999999px!important"><style>.light {fill:#fff;font-size:12px} path {fill:black}</style><defs><path id="p" d="M0 0"/></defs><g class="light"><text style="font-weight:bold;fill:rgb(255, 0, 0)">Text</text></g><use href="#p" x="2"/></svg>', 10, 20);
    expect(clean).toContain('fill="#fff"'); expect(clean).toContain('font-size="12px"'); expect(clean).toContain('font-weight="bold"'); expect(clean).toContain('href="#p"'); expect(clean).not.toContain("999999"); expect(clean).not.toContain("<style");
  });
  it("rejects use cycles and exponential reference expansion", () => {
    expect(() => sanitizeMarkdownSvg('<svg xmlns="http://www.w3.org/2000/svg"><defs><g id="g"><use href="#g"/></g></defs><use href="#g"/></svg>')).toThrow(/cycle/);
    const groups = ['<path id="g0" d="M0 0"/>'];
    for (let i = 1; i <= 15; i++) groups.push(`<g id="g${i}"><use href="#g${i - 1}"/><use href="#g${i - 1}"/></g>`);
    expect(() => sanitizeMarkdownSvg(`<svg xmlns="http://www.w3.org/2000/svg"><defs>${groups.join("")}</defs><use href="#g15"/></svg>`)).toThrow(/expansion/);
  });
  it("rejects malformed XML, declarations and use graph expansion", () => {
    for (const svg of ['<!DOCTYPE svg><svg/>', '<svg><path></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><use href="#a"/></svg>']) expect(() => sanitizeMarkdownSvg(svg)).toThrow();
  });
});
