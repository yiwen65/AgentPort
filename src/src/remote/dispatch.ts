// Api dispatcher: routes api.* calls to the local Tauri backend or the active
// remote device based on T-004's ROUTING table. Local behavior is untouched:
// localOnly (and unclassified) members are returned by identity, and routed
// members still call the local function whenever the local device is active.
// New desktop code.

import {
  activeDeviceContext,
  type DeviceContext,
} from "../deviceContext";
import { ROUTING } from "./backend";
import { remoteBackendFor } from "./runtime";

export interface ApiDispatcherDeps {
  activeContext?: () => DeviceContext;
  backendFor?: (deviceId: string) => unknown;
}

/**
 * Forced-local overrides inside ROUTING.remoteCapable:
 * - `boot`: the remote boot is a multi-call composition owned by the device
 *   switch flow (T-006); api.boot stays the local Tauri command until then.
 */
const FORCED_LOCAL: ReadonlySet<string> = new Set(["boot"]);

const REMOTE_ROUTED: ReadonlySet<string> = new Set(
  [...ROUTING.remoteCapable, ...ROUTING.remoteUnavailable].filter(
    (name) => !FORCED_LOCAL.has(name),
  ),
);

/** Classify one api member name for the dispatcher. */
export function apiRouteFor(
  name: string,
): "localOnly" | "remoteRouted" | "defaultLocal" {
  if ((ROUTING.localOnly as readonly string[]).includes(name)) return "localOnly";
  if (REMOTE_ROUTED.has(name)) return "remoteRouted";
  // Forward-compatible default: new api members stay local until classified.
  return "defaultLocal";
}

type AnyFn = (...args: never[]) => unknown;

/**
 * Wrap localApi so routed members delegate to the active device's
 * RemoteBackend. Remote methods share names/signatures with localApi; a
 * synchronous RemoteUnavailableError from the backend is normalized into a
 * rejection so call sites always see promise semantics.
 *
 * Test-spy contract: vi.spyOn(api, ...) assigns/defines the spy on the proxy;
 * it is recorded in `overrides` and returned by identity afterwards, so
 * vi.mocked(api.x) and call assertions keep working. The production api
 * object is never spied, so overrides stay empty and remote routing is
 * unaffected.
 */
export function createRoutedApi<T extends object>(
  localApi: T,
  deps: ApiDispatcherDeps = {},
): T {
  const contextOf = deps.activeContext ?? activeDeviceContext;
  const backendOf = deps.backendFor ?? remoteBackendFor;
  const overrides = new Map<PropertyKey, unknown>();
  return new Proxy(localApi, {
    get(target, prop, receiver) {
      if (overrides.has(prop)) return overrides.get(prop);
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || typeof value !== "function") return value;
      if (apiRouteFor(prop) !== "remoteRouted") return value;
      const localFn = value as AnyFn;
      return (...args: unknown[]) => {
        const context = contextOf();
        if (context.kind === "local") {
          return (localFn as (...a: unknown[]) => unknown)(...args);
        }
        const backend = backendOf(context.deviceId) as Record<string, unknown>;
        const remoteFn = backend[prop];
        if (typeof remoteFn !== "function") {
          return Promise.reject(
            new Error(`remote backend does not implement ${prop}`),
          );
        }
        try {
          // Class methods rely on `this` (RemoteBackend.request/attachments);
          // an unbound call would silently break every routed invocation.
          return Promise.resolve(
            (remoteFn as (...a: unknown[]) => unknown).call(backend, ...args),
          );
        } catch (error) {
          return Promise.reject(error);
        }
      };
    },
    set(_target, prop, value) {
      overrides.set(prop, value);
      return true;
    },
    defineProperty(_target, prop, descriptor) {
      if ("value" in descriptor) overrides.set(prop, descriptor.value);
      return true;
    },
    deleteProperty(_target, prop) {
      overrides.delete(prop);
      return true;
    },
    getOwnPropertyDescriptor(target, prop) {
      if (overrides.has(prop)) {
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: overrides.get(prop),
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  }) as T;
}
