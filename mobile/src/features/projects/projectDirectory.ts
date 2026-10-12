import type { RemoteClient } from "../../protocol/remoteClient";

export interface ProjectDirectoryListing {
  path: string;
  homePath?: string;
  parentPath: string | null;
  entries: { name: string; path: string }[];
  truncated: boolean;
  compatibility: "native" | "legacy";
}

const controlCharacters = /[\u0000-\u001f]/;
function absolutePathSyntax(path: unknown): path is string {
  return typeof path === "string"
    && (path.startsWith("/") || /^[a-z]:[\\/]/i.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path));
}
export function isAbsoluteProjectPath(path: string): boolean {
  return absolutePathSyntax(path) && !controlCharacters.test(path);
}

const unsupported = (error: unknown) => error !== null && typeof error === "object" && "code" in error
  && (error.code === "unknown_method" || error.code === "capability_disabled");
const record = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === "object" && !Array.isArray(value);
const absolute = (value: unknown): value is string => typeof value === "string" && isAbsoluteProjectPath(value);
const invalidResponse = () => ({ code: "invalid_response", message: "The computer returned an invalid directory response." });
const validatePath = (path: unknown) => {
  if (!absolute(path)) throw { code: "invalid_path", message: "Enter a valid remote absolute directory path." };
};

function entry(value: unknown): { name: string; path: string } {
  // Legal filesystem control characters are not malformed wire data; selectability is checked after schema validation.
  if (!record(value) || typeof value.name !== "string" || !value.name || !absolutePathSyntax(value.path)) {
    throw invalidResponse();
  }
  return { name: value.name, path: value.path };
}
const selectableEntry = (item: { name: string; path: string }) => !controlCharacters.test(item.name) && isAbsoluteProjectPath(item.path);

function nativeListing(value: unknown): ProjectDirectoryListing {
  if (!record(value) || !absolute(value.path) || !absolute(value.homePath)
    || !(value.parentPath === null || absolute(value.parentPath))
    || !Array.isArray(value.entries) || typeof value.truncated !== "boolean") {
    throw invalidResponse();
  }
  const directories = value.entries.map(entry);
  const entries = directories.filter(selectableEntry);
  return {
    path: value.path, homePath: value.homePath, parentPath: value.parentPath,
    entries, truncated: value.truncated || entries.length < directories.length, compatibility: "native",
  };
}

interface LegacyListing {
  path: string;
  entries: { name: string; path: string; isDir: boolean }[];
  truncated: boolean;
}
function legacyListing(value: unknown): LegacyListing {
  // Old Bridge uses to_string_lossy: U+FFFD may identify a different real UTF-8 sibling, not the alias target.
  if (!record(value) || !absolute(value.path) || value.path.includes("\ufffd")
    || !Array.isArray(value.entries) || typeof value.truncated !== "boolean") {
    throw invalidResponse();
  }
  return {
    path: value.path, truncated: value.truncated,
    entries: value.entries.map(value => {
      const directory = entry(value);
      if (!record(value) || typeof value.isDir !== "boolean") throw invalidResponse();
      return { ...directory, isDir: value.isDir };
    }),
  };
}

/** Derive navigation from the returned canonical path, never normalize a user's symlink path. */
function parentPath(path: string): string | null {
  if (path.startsWith("/")) {
    const trimmed = path.replace(/\/+$/, "");
    if (!trimmed) return null;
    return trimmed.slice(0, trimmed.lastIndexOf("/")) || "/";
  }
  const root = path.match(/^\\\\\?\\[a-z]:[\\/]/i)
    ?? path.match(/^[a-z]:[\\/]/i)
    ?? path.match(/^\\\\(?:\?\\UNC\\)?[^\\/]+\\[^\\/]+(?:[\\/]|$)/i);
  if (!root) throw invalidResponse();
  const trimmed = path.replace(/[\\/]+$/, "");
  if (trimmed.length <= root[0].length) return null;
  const separator = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return separator < root[0].length ? root[0] : trimmed.slice(0, separator);
}

/** Read-only compatibility state belongs to this reader/connection lifetime, never to a global host cache. */
export function createProjectDirectoryReader(client: RemoteClient, hostId: string) {
  let nativeListAvailable = true;
  let nativeResolveAvailable = true;
  let legacyAvailable = true;
  let legacyUnavailable: unknown;

  const readLegacy = async (path: string): Promise<LegacyListing> => {
    if (!legacyAvailable) throw legacyUnavailable;
    try {
      // Old Bridge PathParams denies unknown fields: do not send showHidden.
      return legacyListing(await client.request<unknown>(hostId, "document.list", { path }));
    } catch (error) {
      if (unsupported(error)) { legacyAvailable = false; legacyUnavailable = error; }
      throw error;
    }
  };

  return {
    async list(path?: string, showHidden = false): Promise<ProjectDirectoryListing> {
      if (path !== undefined) validatePath(path);
      if (typeof showHidden !== "boolean") throw { code: "invalid_params", message: "Invalid directory options." };
      if (nativeListAvailable) {
        try {
          return nativeListing(await client.request<unknown>(hostId, "project.directory.list", {
            ...(path === undefined ? {} : { path }), showHidden,
          }));
        } catch (error) {
          if (!unsupported(error)) throw error;
          nativeListAvailable = false;
        }
      }
      // Only the verified POSIX root is a default; legacy has no account Home metadata.
      const result = await readLegacy(path ?? "/");
      const directories = result.entries.filter(item => item.isDir && (showHidden || !item.name.startsWith(".")));
      const entries = directories.filter(item => selectableEntry(item) && !item.path.includes("\ufffd"))
        .map(({ name, path }) => ({ name, path }));
      return {
        path: result.path, parentPath: parentPath(result.path), entries,
        truncated: result.truncated || entries.length < directories.length, compatibility: "legacy",
      };
    },
    async resolve(path: string): Promise<string> {
      validatePath(path);
      if (nativeResolveAvailable) {
        try {
          const result = await client.request<unknown>(hostId, "project.directory.resolve", { path });
          if (!record(result) || !absolute(result.path)) throw invalidResponse();
          return result.path;
        } catch (error) {
          if (!unsupported(error)) throw error;
          nativeResolveAvailable = false;
        }
      }
      // document.list canonicalizes and confirms a readable existing directory, including typed symlink aliases.
      return (await readLegacy(path)).path;
    },
  };
}
