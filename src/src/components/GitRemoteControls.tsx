import { useTranslation } from "react-i18next";
import {
  gitWritesEnabled,
  runGitRemoteAction,
} from "../gitCenter";
import { openContextMenu, useStore } from "../store";
import type { GitRemoteAction } from "../types";

export default function GitRemoteControls() {
  const { t } = useTranslation("git");
  const checkoutId = useStore((state) => state.gitCenter.activeCheckoutId);
  const cache = useStore((state) =>
    checkoutId ? state.gitCenter.caches[checkoutId] : null,
  );
  if (!cache?.changes) return null;
  const context = cache.context;
  const busy = cache.changesPhase === "refreshing";
  const protectedBranch = ["main", "master"].includes(context.actualBranch ?? "");
  const canWrite = gitWritesEnabled(cache) && !busy;
  const writeBlockReason = busy
    ? t("remote.blocked.syncing")
    : !cache.changes.complete
    ? t("remote.blocked.partial")
    : !context.writable || context.blockers.length > 0
    ? t("remote.blocked.readOnly")
    : !canWrite
    ? t("remote.blocked.busy")
    : null;
  const branchBlockReason = context.detached || !context.actualBranch || context.unborn
    ? t("remote.blocked.branchRequired")
    : null;
  const operationBlockReason = context.ongoingOperation
    ? t("remote.blocked.ongoingOperation", {
      operation: context.ongoingOperation,
    })
    : null;
  const conflictBlockReason = cache.changes.counts.conflict > 0
    ? t("remote.blocked.conflicts")
    : null;
  const fetchBlockReason = writeBlockReason ??
    (!context.hasRemote ? t("remote.blocked.noRemote") : null);
  const pullBlockReason = writeBlockReason ??
    operationBlockReason ??
    conflictBlockReason ??
    branchBlockReason ??
    (!context.upstream ? t("remote.blocked.noUpstream") : null);
  const pushBlockReason = writeBlockReason ??
    operationBlockReason ??
    branchBlockReason ??
    (!context.hasRemote ? t("remote.blocked.noRemote") : null);
  const forcePushBlockReason = protectedBranch
    ? t("remote.protectedBranch")
    : pushBlockReason ?? (!context.upstream
      ? t("remote.blocked.noUpstream")
      : null);
  const canPull = !pullBlockReason;
  const canPush = !pushBlockReason;
  const primary: GitRemoteAction = context.ahead > 0 ? "push" : "fetch";
  const primaryDisabled = primary === "push" ? !canPush : Boolean(fetchBlockReason);
  const status = [
    context.ahead > 0 ? t("remote.ahead", { count: context.ahead }) : null,
    context.behind > 0 ? t("remote.behind", { count: context.behind }) : null,
  ].filter(Boolean).join(" · ");
  const disabledLabel = (label: string, reason: string | null) =>
    reason ? `${label} · ${reason}` : label;

  const openMenu = (element: HTMLButtonElement) => {
    const rect = element.getBoundingClientRect();
    openContextMenu(rect.right - 220, rect.bottom + 6, [
      {
        label: disabledLabel(t("remote.actions.fetch"), fetchBlockReason),
        disabled: Boolean(fetchBlockReason),
        tip: fetchBlockReason ?? undefined,
        action: () => void runGitRemoteAction("fetch"),
      },
      {
        label: disabledLabel(t("remote.actions.pull"), pullBlockReason),
        disabled: !canPull,
        tip: pullBlockReason ?? undefined,
        action: () => void runGitRemoteAction("pull"),
      },
      {
        label: disabledLabel(t("remote.actions.pull_rebase"), pullBlockReason),
        disabled: !canPull,
        tip: pullBlockReason ?? undefined,
        action: () => void runGitRemoteAction("pull_rebase"),
      },
      { label: "", separator: true },
      {
        label: disabledLabel(t("remote.actions.push"), pushBlockReason),
        disabled: !canPush,
        tip: pushBlockReason ?? undefined,
        action: () => void runGitRemoteAction("push"),
      },
      {
        label: disabledLabel(
          t("remote.actions.force_push"),
          forcePushBlockReason,
        ),
        danger: true,
        disabled: !canPush || !context.upstream || protectedBranch,
        tip: forcePushBlockReason ?? undefined,
        action: () => void runGitRemoteAction("force_push"),
      },
    ]);
  };

  return (
    <section className="git-remote-controls">
      <div className="git-remote-branch">
        <span aria-hidden="true">⑂</span>
        <strong className="mono" title={context.actualBranch ?? t("context.detached")}>
          {context.actualBranch ?? t("context.detached")}
        </strong>
        {context.upstream ? (
          <small className="mono" title={context.upstream}>→ {context.upstream}</small>
        ) : context.hasRemote ? (
          <small>{t("remote.noUpstream")}</small>
        ) : (
          <small>{t("remote.noRemote")}</small>
        )}
        {status ? <span className="git-remote-status">{status}</span> : null}
      </div>
      <div className="git-remote-actions">
        <button
          className="btn small"
          disabled={primaryDisabled}
          onClick={() => void runGitRemoteAction(primary)}
        >
          {busy ? t("remote.syncing") : t(`remote.actions.${primary}`)}
        </button>
        <button
          className="btn small git-remote-menu"
          aria-label={t("remote.more")}
          onClick={(event) => openMenu(event.currentTarget)}
        >
          ▾
        </button>
      </div>
    </section>
  );
}
