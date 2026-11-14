// Progressive remote adapter discovery: one agent per request with a gap
// between probes. A full probe_all blocks the remote bridge for seconds, so
// terminal input queued between probes would stall; this keeps every remote
// request short and lets the adapter list fill in place.

import { api } from "./api";
import {
  cachedRemoteAdapters,
  rememberRemoteAdapters,
  remoteAdaptersStale,
} from "./remoteAdapterCache";
import { getState, setState } from "./store";
import type { AdapterInstall } from "./types";

const REMOTE_ADAPTER_MAX_AGE_MS = 5 * 60_000;
const REMOTE_ADAPTER_PROBE_GAP_MS = 250;
const adapterFillGenerations = new Map<string, number>();
const remoteAdapterFills = new Map<string, Promise<void>>();

function upsertAdapterInstall(
  adapters: AdapterInstall[],
  install: AdapterInstall,
): AdapterInstall[] {
  const index = adapters.findIndex(
    (adapter) => adapter.agentType === install.agentType,
  );
  if (index < 0) return [...adapters, install];
  const next = adapters.slice();
  next[index] = install;
  return next;
}

/**
 * Fill the active remote device's adapter list without blocking interaction.
 * The list updates progressively and is cached only when every agent has been
 * checked; successful results also feed the switch cache.
 */
export function refreshActiveRemoteAdaptersIfStale(
  maxAgeMs = REMOTE_ADAPTER_MAX_AGE_MS,
): void {
  const state = getState();
  if (state.activeDevice.kind !== "remote") return;
  const deviceId = state.activeDevice.deviceId;
  if (!remoteAdaptersStale(deviceId, maxAgeMs)) return;
  if (remoteAdapterFills.has(deviceId)) return;
  const generation = (adapterFillGenerations.get(deviceId) ?? 0) + 1;
  adapterFillGenerations.set(deviceId, generation);

  const run = (async () => {
    const stillActive = () => {
      if (adapterFillGenerations.get(deviceId) !== generation) return false;
      const current = getState().activeDevice;
      return current.kind === "remote" && current.deviceId === deviceId;
    };

    const supported = await api.listSupportedAgents().catch(() => null);
    if (!supported || !stillActive()) return;
    const cached = cachedRemoteAdapters(deviceId);
    const supportedIds = new Set(supported.map((agent) => agent.agent));
    const agents = Array.from(
      new Set([
        ...(cached?.map((adapter) => adapter.agentType) ?? []).filter((agent) =>
          supportedIds.has(agent),
        ),
        ...supported.map((agent) => agent.agent),
      ]),
    );

    const installs: AdapterInstall[] = [];
    for (const agent of agents) {
      if (!stillActive()) return;
      const confirmedPath =
        cached?.find((adapter) => adapter.agentType === agent)
          ?.executablePath ?? null;
      const outcome = await api
        .probeAgent(agent, confirmedPath)
        .catch(() => null);
      if (!outcome || !stillActive()) return;
      if (outcome.install) {
        installs.push(outcome.install);
        setState({
          adapters: upsertAdapterInstall(getState().adapters, outcome.install),
        });
      }
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, REMOTE_ADAPTER_PROBE_GAP_MS);
      });
    }

    if (!stillActive()) return;
    rememberRemoteAdapters(deviceId, installs);
    setState({ adapters: installs });
  })();

  remoteAdapterFills.set(deviceId, run);
  void run.finally(() => {
    if (remoteAdapterFills.get(deviceId) === run) {
      remoteAdapterFills.delete(deviceId);
    }
  });
}

/** Test hook: drop in-flight fill bookkeeping. */
export function resetRemoteAdapterFillForTests(): void {
  adapterFillGenerations.clear();
  remoteAdapterFills.clear();
}
