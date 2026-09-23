// Shared post-boot apply path: the initial boot and every device switch land
// here so data, theme, and initial Session selection are applied identically
// no matter which device the BootInfo describes.
// New desktop code (desktop multi-device switching).

import { api } from "./api";
import {
  applyThemeSettings,
  readLastSelectedSessionId,
  selectSession,
} from "./actions";
import {
  applyProjectsSnapshot,
  findSession,
  flattenSessions,
  getState,
  setState,
} from "./store";
import { applyTerminalLanguage } from "./terminals";
import { applyUiLanguage } from "./i18n";
import { hasPersistedTerminalLayout } from "./paneLayout";
import type { BootInfo } from "./types";

export interface ApplyBootHooks {
  /** Return true to abort between await points (unmount / newer switch). */
  isCancelled?: () => boolean;
  /**
   * Runs after the state snapshot is applied and before initial selection.
   * The initial boot replays its buffered backend events here so selection
   * observes the same tree the listeners saw.
   */
  afterStateApplied?: () => void;
  /** Notification-routed Session id (initial local boot only). */
  notificationSessionId?: string | null;
  /**
   * useBoot's notification-activation guard (initial boot only): while a
   * notification activation is being applied, the fallback selection must not
   * steal the target.
   */
  suppressFallbackSelection?: () => boolean;
  /**
   * Skip the background probe refresh. Remote boot composition already probed
   * the target device; re-probing would double the switch latency.
   */
  skipBackgroundProbeRefresh?: boolean;
}

export async function applyBootInfo(
  info: BootInfo,
  hooks: ApplyBootHooks = {},
): Promise<void> {
  const cancelled = () => hooks.isCancelled?.() ?? false;
  await applyUiLanguage(info.settings.uiLanguage);
  if (cancelled()) return;
  applyTerminalLanguage();
  if (cancelled()) return;
  applyProjectsSnapshot(info.projects);
  setState({
    ready: true,
    platform: info.platform,
    settings: info.settings,
    adapters: info.adapters,
    timeline: info.timeline,
    timelineError: info.timelineMessage ? null : info.timelineError,
    timelineMessage: info.timelineMessage ?? null,
    secretBackend: info.secretBackend,
    indexState: info.indexState,
    exportsDir: info.exportsDir,
    showOnboarding: info.adapters.length === 0,
  });
  applyThemeSettings();
  hooks.afterStateApplied?.();
  const first = flattenSessions(getState().projects)[0];
  const notificationSession = findSession(
    getState().projects,
    hooks.notificationSessionId ?? null,
  );
  const rememberedSession = findSession(
    getState().projects,
    readLastSelectedSessionId(),
  );
  if (notificationSession) selectSession(notificationSession.id);
  else if (
    !(hooks.suppressFallbackSelection?.() ?? false) &&
    !getState().activeSessionId &&
    first &&
    !hasPersistedTerminalLayout()
  ) {
    selectSession(rememberedSession?.id ?? first.id, {
      revealInSidebar: false,
    });
  }
  if (!hooks.skipBackgroundProbeRefresh && info.adapters.length > 0) {
    void api
      // Refresh metadata without replacing an executable path the user
      // explicitly selected in onboarding. A full manual re-probe still
      // auto-selects candidates via probeAgents() with the default flag.
      .probeAgents(true)
      .then((outcomes) => {
        if (cancelled()) return;
        const installs = outcomes.flatMap((outcome) =>
          outcome.install ? [outcome.install] : [],
        );
        if (installs.length > 0) {
          const refreshed = new Map(
            installs.map((install) => [install.agentType, install]),
          );
          const current = getState().adapters;
          const currentAgents = new Set(
            current.map((adapter) => adapter.agentType),
          );
          setState({
            adapters: [
              ...current.map(
                (adapter) => refreshed.get(adapter.agentType) ?? adapter,
              ),
              ...installs.filter(
                (install) => !currentAgents.has(install.agentType),
              ),
            ],
          });
        }
      })
      .catch(() => undefined);
  }
}
