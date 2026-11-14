import type { AdapterInstall } from "./types";

interface CachedRemoteAdapters {
  adapters: AdapterInstall[];
  at: number;
}

/** Last successful remote agent discovery, keyed by device registry id. */
const adaptersByDevice = new Map<string, CachedRemoteAdapters>();

export function cachedRemoteAdapters(
  deviceId: string,
): AdapterInstall[] | null {
  return adaptersByDevice.get(deviceId)?.adapters ?? null;
}

export function remoteAdaptersStale(deviceId: string, maxAgeMs: number): boolean {
  const cached = adaptersByDevice.get(deviceId);
  return !cached || Date.now() - cached.at > maxAgeMs;
}

export function rememberRemoteAdapters(
  deviceId: string,
  adapters: AdapterInstall[],
): void {
  if (deviceId) adaptersByDevice.set(deviceId, { adapters, at: Date.now() });
}

export function resetRemoteAdapterCacheForTests(): void {
  adaptersByDevice.clear();
}
