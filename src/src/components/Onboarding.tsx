// First-run onboarding: load the backend adapter registry, then probe every
// registered CLI. The renderer deliberately has no fixed Agent list.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, errorText } from "../api";
import { hookStatusLabel, probeSourceLabel } from "../format";
import { runtimeMessageText } from "../runtimeMessages";
import { getState, setState, toast } from "../store";
import type { ProbeOutcome, SupportedAgent } from "../types";

type RowState =
  | { phase: "idle" }
  | { phase: "probing" }
  | { phase: "done"; outcome: ProbeOutcome };

function mergeAdapters(outcomes: ProbeOutcome[]) {
  const installs = outcomes.flatMap((outcome) => (outcome.install ? [outcome.install] : []));
  const probedAgents = new Set(outcomes.map((outcome) => outcome.agent));
  setState({
    adapters: [
      ...getState().adapters.filter((adapter) => !probedAgents.has(adapter.agentType)),
      ...installs,
    ],
  });
}

function probeReason(outcome: ProbeOutcome): string | null {
  return outcome.reasonMessage ? runtimeMessageText(outcome.reasonMessage) : outcome.reason;
}

export default function Onboarding() {
  const { t } = useTranslation(["shell", "common", "settings"]);
  const [agents, setAgents] = useState<SupportedAgent[]>([]);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [manualPath, setManualPath] = useState<Record<string, string>>({});
  const [probingAll, setProbingAll] = useState(false);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const automaticProbeStarted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listSupportedAgents()
      .then((registered) => {
        if (!cancelled) setAgents(registered);
      })
      .catch((error) => {
        if (!cancelled) setRegistryError(errorText(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const probeAll = useCallback(async () => {
    setProbingAll(true);
    setRows((current) => {
      const next = { ...current };
      for (const agent of agents) next[agent.agent] = { phase: "probing" };
      return next;
    });
    try {
      const outcomes = await api.probeAgents();
      setRows(() => {
        const next: Record<string, RowState> = {};
        for (const outcome of outcomes) next[outcome.agent] = { phase: "done", outcome };
        return next;
      });
      mergeAdapters(outcomes);
    } catch (error) {
      setRows({});
      toast(t("shell:onboarding.probeFailed", { detail: errorText(error) }), "error");
    } finally {
      setProbingAll(false);
    }
  }, [agents, t]);

  useEffect(() => {
    if (agents.length === 0 || automaticProbeStarted.current) return;
    automaticProbeStarted.current = true;
    void probeAll();
  }, [agents.length, probeAll]);

  const probeOne = async (registered: SupportedAgent, path: string | null) => {
    const agent = registered.agent;
    setRows((current) => ({ ...current, [agent]: { phase: "probing" } }));
    try {
      const outcome = await api.probeAgent(agent, path);
      setRows((current) => ({ ...current, [agent]: { phase: "done", outcome } }));
      mergeAdapters([outcome]);
    } catch (error) {
      setRows((current) => ({
        ...current,
        [agent]: {
          phase: "done",
          outcome: {
            agent,
            displayName: registered.displayName,
            state: "unavailable",
            reason: t("shell:onboarding.probeFailed", { detail: errorText(error) }),
            install: null,
            candidates: [],
          },
        },
      }));
    }
  };

  const manualControls = (registered: SupportedAgent) => {
    const agent = registered.agent;
    return (
      <span className="inline-form" style={{ marginTop: 6 }}>
        <input
          type="text"
          className="mono"
          placeholder={t("shell:onboarding.manualPathPlaceholder", {
            commands: registered.commandNames.join(" / "),
          })}
          aria-label={t("shell:onboarding.manualPathAria", { agent: registered.displayName })}
          value={manualPath[agent] ?? ""}
          onChange={(event) =>
            setManualPath((current) => ({ ...current, [agent]: event.target.value }))
          }
        />
        <button
          className="btn small"
          type="button"
          data-tip={t("shell:onboarding.chooseExecutable")}
          onClick={() =>
            void api
              .pickFile(null)
              .then((path) => {
                if (path) setManualPath((current) => ({ ...current, [agent]: path }));
              })
              .catch((error) => toast(
                t("shell:onboarding.chooseFileFailed", { detail: errorText(error) }),
                "error",
              ))
          }
        >
          {t("common:actions.browse")}
        </button>
        <button
          className="btn small"
          disabled={!(manualPath[agent] ?? "").trim()}
          onClick={() => void probeOne(registered, (manualPath[agent] ?? "").trim())}
        >
          {t("shell:onboarding.usePath")}
        </button>
      </span>
    );
  };

  const anyAvailable = Object.values(rows).some(
    (row) => row.phase === "done" && row.outcome.state === "available",
  );
  const close = () => setState({ showOnboarding: false });

  return (
    <div className="onboarding">
      <div className="onboarding-card" role="dialog" aria-modal="true" aria-label={t("shell:onboarding.title")}>
        <h1>{t("shell:onboarding.title")}</h1>
        <p className="dim" style={{ margin: 0, lineHeight: 1.7 }}>
          {t("shell:onboarding.intro")}
        </p>
        <p className="dim" style={{ margin: 0, lineHeight: 1.7 }}>
          {t("settings:ui.notificationSetup.description")}
        </p>

        {registryError ? (
          <div className="error-bar" role="alert">
            {t("shell:onboarding.registryFailed", { detail: registryError })}
          </div>
        ) : null}

        {agents.map((registered) => {
          const row: RowState = rows[registered.agent] ?? { phase: "idle" };
          return (
            <div className="agent-row" key={registered.agent}>
              <span className="name">{registered.displayName}</span>
              {row.phase === "idle" ? (
                <>
                  <span className="probe-mark pending">{t("shell:onboarding.notChecked")}</span>
                  <span className="detail dim">
                    {t("shell:onboarding.preparing")}
                  </span>
                </>
              ) : row.phase === "probing" ? (
                <>
                  <span className="spin" aria-hidden="true" />
                  <span className="detail dim">{t("shell:onboarding.probing")}</span>
                </>
              ) : row.outcome.state === "available" && row.outcome.install ? (
                <>
                  <span className="probe-mark ok">{t("shell:onboarding.available")}</span>
                  <span className="detail">
                    <span className="mono">{row.outcome.install.executablePath}</span>
                    <br />
                    <span className="dim">
                      {row.outcome.install.versionText} · Hook {hookStatusLabel(row.outcome.install.hookStatus)} ·{" "}
                      {row.outcome.install.exactResume
                        ? t("shell:onboarding.exactResumeSupported")
                        : t("shell:onboarding.exactResumeUnsupported")}
                    </span>
                    {row.outcome.notificationSetup && registered.agent !== "shell" ? (
                      <><br /><span>
                        {t("settings:ui.notificationSetup.notifications")}: {t(`settings:ui.notificationSetup.state.${row.outcome.notificationSetup.state}`)}
                      </span></>
                    ) : null}
                    {probeReason(row.outcome) ? <><br /><span className="dim">{probeReason(row.outcome)}</span></> : null}
                    <details className="agent-candidates">
                      <summary>
                        {t("shell:onboarding.advancedOptions", {
                          count: row.outcome.candidates.length,
                        })}
                      </summary>
                      {row.outcome.candidates.map((candidate) => (
                        <div key={candidate.path} style={{ marginTop: 4 }}>
                          <button
                            className="btn small"
                            onClick={() => void probeOne(registered, candidate.path)}
                          >
                            {t("shell:onboarding.usePath")}
                          </button>{" "}
                          <span className="mono">{candidate.path}</span>{" "}
                          <span className="dim">
                            {candidate.versionText ?? t("shell:onboarding.notVerified")} · {probeSourceLabel(candidate.source)}
                          </span>
                        </div>
                      ))}
                      {manualControls(registered)}
                    </details>
                  </span>
                </>
              ) : row.outcome.state === "conflict" ? (
                <>
                  <span className="probe-mark warn">{t("shell:onboarding.pathRequired")}</span>
                  <span className="detail">
                    {t("shell:onboarding.chooseCandidate")}
                    {row.outcome.candidates.map((candidate) => (
                      <div key={candidate.path} style={{ marginTop: 4 }}>
                        <button className="btn small" onClick={() => void probeOne(registered, candidate.path)}>
                          {t("shell:onboarding.usePath")}
                        </button>{" "}
                        <span className="mono">{candidate.path}</span>
                      </div>
                    ))}
                    {manualControls(registered)}
                  </span>
                </>
              ) : (
                <>
                  <span className="probe-mark bad">{t("shell:onboarding.unavailable")}</span>
                  <span className="detail">
                    {probeReason(row.outcome) ?? t("shell:onboarding.executableNotFound")}
                    <details className="agent-candidates" open>
                      <summary>
                        {t("shell:onboarding.advancedOptions", {
                          count: row.outcome.candidates.length,
                        })}
                      </summary>
                      {manualControls(registered)}
                    </details>
                  </span>
                </>
              )}
              {row.phase === "done" ? (
                <button className="btn small ghost" onClick={() => void probeOne(registered, null)}>
                  {t("shell:onboarding.probeAgain")}
                </button>
              ) : null}
            </div>
          );
        })}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button className="btn" disabled={probingAll || agents.length === 0} onClick={() => void probeAll()}>
            {probingAll ? t("shell:onboarding.probing") : t("shell:onboarding.probeAll")}
          </button>
          <button
            className="btn primary"
            onClick={close}
            data-tip={anyAvailable ? undefined : t("shell:onboarding.noAvailableAgent")}
          >
            {anyAvailable ? t("shell:onboarding.continue") : t("shell:onboarding.skip")}
          </button>
        </div>
        <p className="form-hint" style={{ margin: 0 }}>
          {t("shell:onboarding.adapterNote")}
        </p>
      </div>
    </div>
  );
}
