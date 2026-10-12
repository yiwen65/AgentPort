import { describe, expect, it, vi } from "vitest";
import type { RemoteClient } from "../../protocol/remoteClient";
import { createProjectDirectoryReader, isAbsoluteProjectPath } from "./projectDirectory";

const native = (path = "/home/w") => ({
  path, homePath: "/home/w", parentPath: path === "/" ? null : "/home",
  entries: [{ name: "work", path: "/home/w/work" }], truncated: false,
});
const legacy = (path = "/", entries: unknown[] = [], truncated = false) => ({ path, entries, truncated });
const unavailable = (code = "unknown_method") => ({ code, status: "not_executed", message: "Not supported" });
function remote(handler: (method: string, params: Record<string, unknown>, hostId: string) => unknown) {
  const request = vi.fn(async (hostId: string, method: string, params: unknown) => handler(method, params as Record<string, unknown>, hostId));
  return { client: { request } as unknown as RemoteClient, request };
}
function oldRemote(result: unknown = legacy()) {
  return remote(method => {
    if (method === "document.list") return result;
    throw unavailable();
  });
}
const methods = (request: ReturnType<typeof remote>["request"]) => request.mock.calls.map(([, method]) => method);

// Fixtures mirror the installed old Bridge: document.list canonical path, isDir, and truncated; no Home.
describe("project directory read compatibility", () => {
  it("prefers and validates native list/resolve without any legacy request", async () => {
    const { client, request } = remote((method, params) => {
      if (method === "project.directory.list") return native(params.path as string | undefined);
      if (method === "project.directory.resolve") return { path: "/srv/canonical", ignored: "not forwarded" };
      throw new Error("Unexpected legacy request");
    });
    const reader = createProjectDirectoryReader(client, "ubuntu");
    await expect(reader.list()).resolves.toEqual({ ...native(), compatibility: "native" });
    expect(request.mock.calls[0]).toEqual(["ubuntu", "project.directory.list", { showHidden: false }]);
    await expect(reader.list("/home/w/work", true)).resolves.toMatchObject({ path: "/home/w/work", compatibility: "native" });
    expect(request.mock.calls[1]).toEqual(["ubuntu", "project.directory.list", { path: "/home/w/work", showHidden: true }]);
    await expect(reader.resolve("/home/w/alias")).resolves.toBe("/srv/canonical");
    expect(request.mock.calls[2]).toEqual(["ubuntu", "project.directory.resolve", { path: "/home/w/alias" }]);
  });

  it.each(["unknown_method", "capability_disabled"])("only %s enables legacy list; default root has no invented Home", async code => {
    const { client, request } = remote((method, params) => {
      if (method === "document.list") return legacy(params.path as string);
      throw unavailable(code);
    });
    const reader = createProjectDirectoryReader(client, "ubuntu");
    await expect(reader.list()).resolves.toEqual({ path: "/", parentPath: null, entries: [], truncated: false, compatibility: "legacy" });
    expect(request.mock.calls[1]).toEqual(["ubuntu", "document.list", { path: "/" }]);
    expect(await reader.list("/home/w", true)).not.toHaveProperty("homePath");
    expect(request.mock.calls[2]).toEqual(["ubuntu", "document.list", { path: "/home/w" }]);
    expect(methods(request)).toEqual(["project.directory.list", "document.list", "document.list"]);
  });

  it("filters files and legacy non-directory symlinks, hides dot directories locally, and preserves truncation", async () => {
    const entries = [
      { name: "file.txt", path: "/home/w/file.txt", isDir: false },
      { name: "work", path: "/home/w/work", isDir: true },
      { name: ".private", path: "/home/w/.private", isDir: true },
      { name: "alias", path: "/home/w/alias", isDir: false },
    ];
    const { client, request } = oldRemote(legacy("/home/w", entries, true));
    const reader = createProjectDirectoryReader(client, "ubuntu");
    await expect(reader.list("/home/w")).resolves.toEqual({
      path: "/home/w", parentPath: "/home", entries: [{ name: "work", path: "/home/w/work" }], truncated: true, compatibility: "legacy",
    });
    await expect(reader.list("/home/w", true)).resolves.toMatchObject({
      entries: [{ name: "work", path: "/home/w/work" }, { name: ".private", path: "/home/w/.private" }], truncated: true,
    });
    expect(methods(request)).toEqual(["project.directory.list", "document.list", "document.list"]);
    expect(request.mock.calls.slice(1).map(([, , params]) => params)).toEqual([{ path: "/home/w" }, { path: "/home/w" }]);
  });

  it("keeps truncated true even when every legacy entry is a file", async () => {
    const { client, request } = oldRemote(legacy("/", [{ name: "a", path: "/a", isDir: false }], true));
    await expect(createProjectDirectoryReader(client, "ubuntu").list()).resolves.toMatchObject({ entries: [], truncated: true });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(["unknown_method", "capability_disabled"])("resolves a manually typed symlink canonical path through legacy after native %s", async code => {
    const { client, request } = remote(method => {
      if (method === "document.list") return legacy("/srv/real", [], true);
      throw unavailable(code);
    });
    const reader = createProjectDirectoryReader(client, "ubuntu");
    const alias = "/home/w/alias";
    await expect(reader.resolve(alias)).resolves.toBe("/srv/real");
    await expect(reader.resolve(alias)).resolves.toBe("/srv/real");
    expect(request.mock.calls).toEqual([
      ["ubuntu", "project.directory.resolve", { path: alias }],
      ["ubuntu", "document.list", { path: alias }],
      ["ubuntu", "document.list", { path: alias }],
    ]);
  });

  it("sends parent traversal unchanged and propagates the legacy rejection instead of collapsing across symlinks", async () => {
    const error = { code: "service_error", status: "failed", message: "Invalid request" };
    const { client, request } = remote(method => {
      if (method === "document.list") throw error;
      throw unavailable();
    });
    const reader = createProjectDirectoryReader(client, "ubuntu");
    const path = "/home/w/alias/../real";
    await expect(reader.resolve(path)).rejects.toBe(error);
    await expect(reader.list(path)).rejects.toBe(error);
    expect(request.mock.calls.every(([, , params]) => (params as { path: string }).path === path)).toBe(true);
    expect(methods(request)).toEqual(["project.directory.resolve", "document.list", "project.directory.list", "document.list"]);
  });

  it("does not couple native resolve support to a previously unsupported native list", async () => {
    const { client, request } = remote(method => {
      if (method === "project.directory.list") throw unavailable();
      if (method === "document.list") return legacy("/");
      return { path: "/canonical" };
    });
    const reader = createProjectDirectoryReader(client, "ubuntu");
    await reader.list();
    await expect(reader.resolve("/alias")).resolves.toBe("/canonical");
    expect(methods(request)).toEqual(["project.directory.list", "document.list", "project.directory.resolve"]);
  });

  it("does not couple native list support to a previously unsupported native resolve", async () => {
    const { client, request } = remote(method => {
      if (method === "project.directory.resolve") throw unavailable();
      if (method === "document.list") return legacy("/canonical");
      return native();
    });
    const reader = createProjectDirectoryReader(client, "ubuntu");
    await reader.resolve("/alias");
    await expect(reader.list()).resolves.toMatchObject({ compatibility: "native" });
    expect(methods(request)).toEqual(["project.directory.resolve", "document.list", "project.directory.list"]);
  });

  it("retains explicit double-unsupported errors and avoids repeated requests, but still probes untried native resolve", async () => {
    const error = unavailable("capability_disabled");
    const { client, request } = remote(method => { throw method === "document.list" ? error : unavailable(); });
    const reader = createProjectDirectoryReader(client, "ubuntu");
    await expect(reader.list()).rejects.toBe(error);
    await expect(reader.list("/work")).rejects.toBe(error);
    await expect(reader.resolve("/work")).rejects.toBe(error);
    await expect(reader.resolve("/work")).rejects.toBe(error);
    expect(methods(request)).toEqual(["project.directory.list", "document.list", "project.directory.resolve"]);
  });

  it("can use native resolution even when both list APIs are unsupported", async () => {
    const { client, request } = remote(method => {
      if (method === "project.directory.resolve") return { path: "/canonical" };
      throw unavailable();
    });
    const reader = createProjectDirectoryReader(client, "ubuntu");
    await expect(reader.list()).rejects.toMatchObject({ code: "unknown_method" });
    await expect(reader.resolve("/alias")).resolves.toBe("/canonical");
    expect(methods(request)).toEqual(["project.directory.list", "document.list", "project.directory.resolve"]);
  });

  it.each([
    "path_not_found", "not_directory", "permission_denied", "invalid_path", "directory_read_failed",
    "service_error", "transport_error", "disconnected", "timeout", "invalid_params", "invalid_response",
  ])("propagates native %s for list and resolve without attempting legacy or caching it as unsupported", async code => {
    const error = { code, status: "failed", message: "Read failed" };
    const { client, request } = remote(() => { throw error; });
    const reader = createProjectDirectoryReader(client, "ubuntu");
    await expect(reader.list()).rejects.toBe(error);
    await expect(reader.list()).rejects.toBe(error);
    await expect(reader.resolve("/work")).rejects.toBe(error);
    await expect(reader.resolve("/work")).rejects.toBe(error);
    expect(methods(request)).toEqual(["project.directory.list", "project.directory.list", "project.directory.resolve", "project.directory.resolve"]);
  });

  it.each(["service_error", "permission_denied", "invalid_path", "transport_error", "invalid_response"])("preserves legacy %s instead of returning an unvalidated raw path", async code => {
    const error = { code, status: "failed", message: "Legacy read failed" };
    const { client, request } = remote(method => {
      if (method === "document.list") throw error;
      throw unavailable();
    });
    const reader = createProjectDirectoryReader(client, "ubuntu");
    await expect(reader.list("/missing")).rejects.toBe(error);
    await expect(reader.resolve("/missing")).rejects.toBe(error);
    await expect(reader.resolve("/missing")).rejects.toBe(error);
    expect(methods(request)).toEqual(["project.directory.list", "document.list", "project.directory.resolve", "document.list", "document.list"]);
  });

  it.each([new Error("network failed"), "connection closed", null, { code: "UNKNOWN_METHOD" }, { code: "unknown_method_other" }])("does not classify an unrecognized failure as unsupported: %j", async error => {
    const { client, request } = remote(() => { throw error; });
    const reader = createProjectDirectoryReader(client, "ubuntu");
    await expect(reader.list()).rejects.toBe(error);
    await expect(reader.resolve("/work")).rejects.toBe(error);
    expect(methods(request)).toEqual(["project.directory.list", "project.directory.resolve"]);
  });

  it("does not retain a cached double-unsupported result across reader lifetimes", async () => {
    let available = false;
    const { client, request } = remote(method => {
      if (available) return method === "project.directory.list" ? native() : { path: "/canonical" };
      throw unavailable();
    });
    const old = createProjectDirectoryReader(client, "ubuntu");
    await expect(old.list()).rejects.toMatchObject({ code: "unknown_method" });
    available = true;
    await expect(old.list()).rejects.toMatchObject({ code: "unknown_method" });
    const fresh = createProjectDirectoryReader(client, "ubuntu");
    await expect(fresh.list()).resolves.toMatchObject({ compatibility: "native" });
    await expect(fresh.resolve("/alias")).resolves.toBe("/canonical");
    expect(methods(request)).toEqual(["project.directory.list", "document.list", "project.directory.list", "project.directory.resolve"]);
  });

  it("keeps support state independent for mixed hosts and for a fresh reader on the same host/client", async () => {
    const { client, request } = remote((method, params, hostId) => {
      if (hostId === "new") return method === "project.directory.list" ? native() : { path: "/canonical" };
      if (method === "document.list") return legacy(params.path as string);
      throw unavailable();
    });
    const old = createProjectDirectoryReader(client, "old");
    const modern = createProjectDirectoryReader(client, "new");
    await old.list();
    await expect(modern.list()).resolves.toMatchObject({ compatibility: "native" });
    await expect(modern.resolve("/alias")).resolves.toBe("/canonical");
    await old.list("/work");
    await createProjectDirectoryReader(client, "old").list();
    expect(request.mock.calls.filter(([id, method]) => id === "old" && method === "project.directory.list")).toHaveLength(2);
    expect(request.mock.calls.filter(([id, method]) => id === "new" && method === "document.list")).toHaveLength(0);
  });
});

describe("directory path identity and selectable entries", () => {
  it("rejects ambiguous lossy legacy canonical paths for a typed alias instead of returning a different UTF-8 sibling", async () => {
    // A raw-byte /tmp/work\\xff target and a real UTF-8 /tmp/work� sibling serialize identically on old Bridge.
    const { client, request } = oldRemote(legacy("/tmp/work�"));
    const reader = createProjectDirectoryReader(client, "ubuntu");
    await expect(reader.resolve("/tmp/alias")).rejects.toMatchObject({
      code: "invalid_response", message: "The computer returned an invalid directory response.",
    });
    await expect(reader.list("/tmp/alias")).rejects.toMatchObject({ code: "invalid_response" });
    expect(methods(request)).toEqual(["project.directory.resolve", "document.list", "project.directory.list", "document.list"]);
  });

  it("omits both ambiguous legacy directory rows in a lossy UTF-8 collision and reports incompleteness", async () => {
    const { client, request } = oldRemote(legacy("/tmp", [
      { name: "safe", path: "/tmp/safe", isDir: true },
      { name: "work�", path: "/tmp/work�", isDir: true },
      { name: "work�", path: "/tmp/work�", isDir: true },
    ]));
    await expect(createProjectDirectoryReader(client, "ubuntu").list("/tmp")).resolves.toMatchObject({
      entries: [{ name: "safe", path: "/tmp/safe" }], truncated: true,
    });
    expect(methods(request)).toEqual(["project.directory.list", "document.list"]);
  });

  it.each(["notes\nold", "notes\told"])("does not let a legal control-named ordinary legacy file %j block listing or canonical resolution", async name => {
    const { client, request } = oldRemote(legacy("/tmp", [
      { name, path: `/tmp/${name}`, isDir: false },
      { name: "safe", path: "/tmp/safe", isDir: true },
      { name: "lossy�", path: "/tmp/lossy�", isDir: false },
    ]));
    const reader = createProjectDirectoryReader(client, "ubuntu");
    await expect(reader.list("/tmp")).resolves.toMatchObject({
      entries: [{ name: "safe", path: "/tmp/safe" }], truncated: false,
    });
    await expect(reader.resolve("/tmp/alias")).resolves.toBe("/tmp");
    expect(methods(request)).toEqual(["project.directory.list", "document.list", "project.directory.resolve", "document.list"]);
  });

  it("resolves a readable legacy alias despite an unrelated legal newline-named ordinary file", async () => {
    const { client, request } = oldRemote(legacy("/tmp/safe", [
      { name: "notes\nold", path: "/tmp/safe/notes\nold", isDir: false },
    ]));
    await expect(createProjectDirectoryReader(client, "ubuntu").resolve("/tmp/alias")).resolves.toBe("/tmp/safe");
    expect(methods(request)).toEqual(["project.directory.resolve", "document.list"]);
  });

  it("does not let a legal hidden control-named legacy directory poison a visible listing; reports omitted rows when shown", async () => {
    const { client } = oldRemote(legacy("/tmp", [
      { name: ".hidden\nold", path: "/tmp/.hidden\nold", isDir: true },
      { name: "safe", path: "/tmp/safe", isDir: true },
    ]));
    const reader = createProjectDirectoryReader(client, "ubuntu");
    await expect(reader.list("/tmp")).resolves.toMatchObject({ entries: [{ name: "safe", path: "/tmp/safe" }], truncated: false });
    await expect(reader.list("/tmp", true)).resolves.toMatchObject({ entries: [{ name: "safe", path: "/tmp/safe" }], truncated: true });
    await expect(reader.resolve("/tmp/alias")).resolves.toBe("/tmp");
  });

  it("omits unselectable legacy directory names/paths without poisoning their siblings or resolution", async () => {
    const { client } = oldRemote(legacy("/tmp", [
      { name: "safe", path: "/tmp/safe", isDir: true },
      { name: "name\nonly", path: "/tmp/clean-alias", isDir: true },
      { name: "path-only", path: "/tmp/path\tonly", isDir: true },
    ]));
    const reader = createProjectDirectoryReader(client, "ubuntu");
    await expect(reader.list("/tmp")).resolves.toMatchObject({ entries: [{ name: "safe", path: "/tmp/safe" }], truncated: true });
    await expect(reader.resolve("/tmp/alias")).resolves.toBe("/tmp");
  });

  it.each(["notes\nold", "notes\told"])("omits legal but unselectable native directory %j and reports incompleteness", async name => {
    const { client, request } = remote(() => ({ ...native("/tmp"), entries: [
      { name, path: `/tmp/${name}` }, { name: "safe", path: "/tmp/safe" },
    ] }));
    await expect(createProjectDirectoryReader(client, "ubuntu").list("/tmp", true)).resolves.toMatchObject({
      entries: [{ name: "safe", path: "/tmp/safe" }], truncated: true, compatibility: "native",
    });
    expect(methods(request)).toEqual(["project.directory.list"]);
  });

  it("preserves genuine native UTF-8 replacement-character canonical paths and rows", async () => {
    const path = "/tmp/work�";
    const result = { ...native(path), entries: [{ name: "child�", path: `${path}/child�` }] };
    const { client, request } = remote(method => method === "project.directory.list" ? result : { path });
    const reader = createProjectDirectoryReader(client, "ubuntu");
    await expect(reader.list("/tmp/alias")).resolves.toEqual({ ...result, compatibility: "native" });
    await expect(reader.resolve("/tmp/alias")).resolves.toBe(path);
    expect(methods(request)).toEqual(["project.directory.list", "project.directory.resolve"]);
  });
});

describe("directory response validation", () => {
  const invalidNative = [
    null, [], {}, { ...native(), path: "relative" }, { ...native(), path: "/bad\u0000path" },
    { ...native(), homePath: undefined }, { ...native(), homePath: "~" },
    { ...native(), parentPath: undefined }, { ...native(), parentPath: "relative" },
    { ...native(), entries: null }, { ...native(), truncated: undefined }, { ...native(), truncated: "false" },
    { ...native(), entries: [null] }, { ...native(), entries: [{ name: "bad", path: "relative" }] },
    { ...native(), entries: [{ name: "", path: "/work" }] },
    { ...native(), entries: [{ name: 42, path: "/work" }] },
  ];
  it.each(invalidNative.map((value, index) => ({ value, index })))("fails closed on malformed native list $index without legacy fallback", async ({ value }) => {
    const { client, request } = remote(() => value);
    await expect(createProjectDirectoryReader(client, "ubuntu").list()).rejects.toMatchObject({
      code: "invalid_response", message: "The computer returned an invalid directory response.",
    });
    expect(methods(request)).toEqual(["project.directory.list"]);
  });

  it.each([null, [], {}, { path: 42 }, { path: "relative" }, { path: "/bad\npath" }])("fails closed on malformed native resolve %j", async value => {
    const { client, request } = remote(() => value);
    await expect(createProjectDirectoryReader(client, "ubuntu").resolve("/work")).rejects.toMatchObject({ code: "invalid_response" });
    expect(methods(request)).toEqual(["project.directory.resolve"]);
  });

  const invalidLegacy = [
    null, [], {}, legacy("relative"), legacy("/bad\npath"), { ...legacy(), truncated: undefined },
    { ...legacy(), truncated: 0 }, { ...legacy(), entries: {} },
    legacy("/", [{ name: "work", path: "/work" }]), legacy("/", [{ name: "work", path: "/work", isDir: 1 }]),
    legacy("/", [{ name: "work", path: "relative", isDir: true }]),
    legacy("/", [{ name: 7, path: "/work", isDir: true }]), legacy("/", [null]),
    // Even filtered-out files must have a valid wire shape, not silently masquerade as a safe listing.
    legacy("/", [{ name: "file", path: "relative", isDir: false }]),
  ];
  it.each(invalidLegacy.map((value, index) => ({ value, index })))("fails closed on malformed legacy list and resolve $index", async ({ value }) => {
    const { client, request } = oldRemote(value);
    const reader = createProjectDirectoryReader(client, "ubuntu");
    await expect(reader.list()).rejects.toMatchObject({ code: "invalid_response" });
    await expect(reader.resolve("/work")).rejects.toMatchObject({ code: "invalid_response" });
    expect(methods(request)).toEqual(["project.directory.list", "document.list", "project.directory.resolve", "document.list"]);
  });

  it("does not disable a valid native method after one malformed response", async () => {
    let malformed = true;
    const { client, request } = remote(() => malformed ? {} : native());
    const reader = createProjectDirectoryReader(client, "ubuntu");
    await expect(reader.list()).rejects.toMatchObject({ code: "invalid_response" });
    malformed = false;
    await expect(reader.list()).resolves.toMatchObject({ compatibility: "native" });
    expect(methods(request)).toEqual(["project.directory.list", "project.directory.list"]);
  });
});

describe("absolute project paths and canonical legacy parents", () => {
  it.each(["/", "/home/a b", "C:\\work", "D:/work", "\\\\server\\share\\work", "\\\\?\\C:\\work", "\\\\?\\UNC\\server\\share\\work"])("accepts existing absolute syntax %s", path => {
    expect(isAbsoluteProjectPath(path)).toBe(true);
  });
  it.each(["", "relative", "~/work", "C:work", "\\work", "\\\\server", "/bad\u0000path", "/bad\npath", "C:\\bad\tpath"])("rejects invalid input %j before any read", async path => {
    expect(isAbsoluteProjectPath(path)).toBe(false);
    const { client, request } = oldRemote();
    const reader = createProjectDirectoryReader(client, "ubuntu");
    await expect(reader.list(path)).rejects.toMatchObject({ code: "invalid_path" });
    await expect(reader.resolve(path)).rejects.toMatchObject({ code: "invalid_path" });
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects non-string paths and non-boolean options before calls", async () => {
    const { client, request } = oldRemote();
    const reader = createProjectDirectoryReader(client, "ubuntu");
    await expect(reader.list(null as unknown as string)).rejects.toMatchObject({ code: "invalid_path" });
    await expect(reader.resolve(undefined as unknown as string)).rejects.toMatchObject({ code: "invalid_path" });
    await expect(reader.list("/work", "true" as unknown as boolean)).rejects.toMatchObject({ code: "invalid_params" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["/", null], ["/home", "/"], ["/home/w", "/home"], ["/home/w/", "/home"],
    ["C:\\", null], ["C:\\work", "C:\\"], ["C:\\work\\child", "C:\\work"], ["D:/", null], ["D:/work", "D:/"],
    ["\\\\server\\share", null], ["\\\\server\\share\\", null], ["\\\\server\\share\\work", "\\\\server\\share\\"],
    ["\\\\server\\share\\work\\child", "\\\\server\\share\\work"],
    ["\\\\?\\C:\\", null], ["\\\\?\\C:\\work", "\\\\?\\C:\\"], ["\\\\?\\C:\\work\\child", "\\\\?\\C:\\work"],
    ["\\\\?\\UNC\\server\\share\\", null], ["\\\\?\\UNC\\server\\share\\work", "\\\\?\\UNC\\server\\share\\"],
  ])("derives canonical legacy parent of %s as %s without guessing Home", async (path, parentPath) => {
    const { client } = oldRemote(legacy(path as string));
    await expect(createProjectDirectoryReader(client, "host").list()).resolves.toEqual({
      path, parentPath, entries: [], truncated: false, compatibility: "legacy",
    });
  });
});
