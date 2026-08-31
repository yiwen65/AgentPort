import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { quickStartSession } from "../actions";
import { orderAgentIds, visibleAgentIds } from "../agentOrder";
import { agentDisplay } from "../format";
import { closeDialog, findSession, useStore } from "../store";
import type { PaneSplitDirection } from "../paneLayout";
import { AgentIcon } from "./AgentIcons";
import Modal from "./Modal";
import ShellIcon from "./ShellIcon";

function PickerAgentIcon({ agent }: { agent: string }) {
  const theme = useStore((state) => state.themeEffective);
  if (agent === "shell") {
    return <ShellIcon className="split-agent-picker-mark shell" size={30} />;
  }
  if (["codex", "claude", "kimi", "qoder", "pi"].includes(agent)) {
    return (
      <AgentIcon
        agent={agent}
        className={`split-agent-picker-mark ${agent}`}
        size={30}
        mono={theme === "light"}
      />
    );
  }
  return (
    <span className="split-agent-picker-fallback" aria-hidden="true">
      {agent.slice(0, 1).toUpperCase()}
    </span>
  );
}

export default function SplitAgentPicker({
  targetSessionId,
  direction,
}: {
  targetSessionId: string;
  direction: PaneSplitDirection;
}) {
  const { t } = useTranslation("shell");
  const state = useStore();
  const target = findSession(state.projects, targetSessionId);
  const agents = useMemo(
    () => visibleAgentIds(
      orderAgentIds(
        state.settings?.agentOrder,
        state.adapters.map((adapter) => adapter.agentType),
      ),
      state.settings?.agentHidden,
    ),
    [state.adapters, state.settings?.agentHidden, state.settings?.agentOrder],
  );

  useEffect(() => {
    if (!target) closeDialog();
  }, [target]);

  if (!target) return null;

  const modeFor = (agent: string) => {
    if (agent === "pi") return null;
    if (agent === "shell") return t("ui.sidebar.quickLaunch.terminal");
    return t("ui.sidebar.quickLaunch.bypassPermissionChecks");
  };
  const title = t(
    direction === "right"
      ? "ui.panePicker.titleRight"
      : "ui.panePicker.titleDown",
  );

  return (
    <Modal
      title={title}
      onClose={closeDialog}
      workspaceCentered
      className="split-agent-picker-modal"
    >
      <p className="split-agent-picker-description">
        {t(
          direction === "right"
            ? "ui.panePicker.descriptionRight"
            : "ui.panePicker.descriptionDown",
          { title: target.title },
        )}
      </p>
      {agents.length > 0 ? (
        <div
          className="split-agent-picker-grid"
          role="group"
          aria-label={t("ui.panePicker.listLabel")}
        >
          {agents.map((agent) => {
            const mode = modeFor(agent);
            return (
              <button
                key={agent}
                type="button"
                className="split-agent-picker-option"
                data-agent={agent}
                aria-label={
                  mode
                    ? t("ui.panePicker.launchLabel", {
                        agent: agentDisplay(agent),
                        mode,
                      })
                    : t("ui.panePicker.launchPlainLabel", {
                        agent: agentDisplay(agent),
                      })
                }
                onClick={() => {
                  closeDialog();
                  void quickStartSession(
                    target.projectId,
                    agent,
                    target.worktreeId ?? undefined,
                    { targetSessionId, direction },
                  );
                }}
              >
                <span className="split-agent-picker-icon">
                  <PickerAgentIcon agent={agent} />
                </span>
                <span className="split-agent-picker-name">
                  {agentDisplay(agent)}
                </span>
                {mode ? (
                  <span className="split-agent-picker-mode">{mode}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="split-agent-picker-empty">
          {t("ui.panePicker.empty")}
        </p>
      )}
    </Modal>
  );
}
