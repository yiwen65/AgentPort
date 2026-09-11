import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, errorText } from "../api";
import { DEFAULT_AGENT_ORDER } from "../agentOrder";
import { agentDisplay } from "../format";
import { confirmDialog, getState, setState, useStore } from "../store";
import type { NotificationSetup } from "../types";

const agents = DEFAULT_AGENT_ORDER.filter((agent) => agent !== "shell");
const events = ["completed", "needsInput", "failed"] as const;
const eventLabels = {
  completed: "ui.notificationSetup.completed",
  needsInput: "ui.notificationSetup.needsInput",
  failed: "ui.notificationSetup.failedEvent",
} as const;

/** Notification preparation never owns CLI availability or notification toggles. */
export default function NotificationSetupPanel({ refreshKey = 0, disabled = false, onBusyChange }: {
  refreshKey?: number;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation("settings");
  const adapters = useStore((state) => state.adapters);
  const [setups, setSetups] = useState<NotificationSetup[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    onBusyChange?.(pending !== null);
    return () => onBusyChange?.(false);
  }, [pending, onBusyChange]);

  useEffect(() => {
    let active = true;
    const request = ++generation.current;
    setLoading(true);
    setError(null);
    api.notificationSetups().then((result) => {
      if (active && request === generation.current) setSetups(result);
    }).catch((e) => {
      if (active && request === generation.current) {
        setError(t("ui.notificationSetup.loadFailed", { detail: errorText(e) }));
      }
    }).finally(() => {
      if (active && request === generation.current) setLoading(false);
    });
    return () => { active = false; };
  }, [refreshKey, reloadKey, t]);

  const replaceSetup = (setup: NotificationSetup) => {
    setSetups((current) => [...current.filter((item) => item.agent !== setup.agent), setup]);
  };
  const begin = (agent: string) => {
    generation.current += 1;
    setLoading(false);
    setPending(agent);
    setError(null);
  };
  const retry = async (agent: string) => {
    begin(agent);
    try {
      const install = getState().adapters.find((item) => item.agentType === agent);
      const outcome = await api.probeAgent(agent, install?.executablePath ?? null);
      // A failed notification setup is independent from this usable CLI result.
      // A failed CLI reprobe must also not silently delete the user's selection.
      if (outcome.install) {
        setState({ adapters: [
          ...getState().adapters.filter((item) => item.agentType !== agent), outcome.install,
        ] });
      }
      if (outcome.notificationSetup) replaceSetup(outcome.notificationSetup);
      else setSetups(await api.notificationSetups());
      if (!outcome.install) setError(t("ui.notificationSetup.probeUnavailable"));
    } catch (e) {
      setError(t("ui.notificationSetup.retryFailed", { agent: agentDisplay(agent), detail: errorText(e) }));
    } finally {
      setPending(null);
    }
  };
  const rollback = async (agent: string) => {
    begin(agent);
    try {
      if (!await confirmDialog({
        title: t("ui.notificationSetup.rollbackTitle", { agent: agentDisplay(agent) }),
        body: t("ui.notificationSetup.rollbackBody"),
        confirmLabel: t("ui.notificationSetup.rollback"),
        danger: true,
      })) return;
      replaceSetup(await api.rollbackNotificationSetup(agent));
    } catch (e) {
      setError(t("ui.notificationSetup.rollbackFailed", { agent: agentDisplay(agent), detail: errorText(e) }));
    } finally {
      setPending(null);
    }
  };
  const busy = disabled || pending !== null;

  return (
    <section className="notification-setup-panel" aria-labelledby="notification-setup-title">
      <h3 className="section-title" id="notification-setup-title">{t("ui.notificationSetup.title")}</h3>
      <p className="dim">{t("ui.notificationSetup.description")}</p>
      <p className="dim">{t("ui.notificationSetup.nextStart")}</p>
      {error ? <div className="error-bar" role="alert">{error}</div> : null}
      {loading ? <p role="status">{t("ui.notificationSetup.loading")}</p> : null}
      <div className="notification-setup-table-wrap">
        <table className="table notification-setup-table" aria-label={t("ui.notificationSetup.table")}>
          <thead><tr>
            <th scope="col">Agent</th>
            <th scope="col">{t("ui.notificationSetup.cli")}</th>
            <th scope="col">{t("ui.notificationSetup.notifications")}</th>
          </tr></thead>
          <tbody>{agents.map((agent) => {
            const install = adapters.find((item) => item.agentType === agent);
            const setup = setups.find((item) => item.agent === agent);
            const state = install ? setup?.state ?? "unavailable" : "unavailable";
            return (
              <tr key={agent} data-agent={agent}>
                <th scope="row">{agentDisplay(agent)}</th>
                <td>{t(install ? "ui.notificationSetup.available" : "ui.notificationSetup.notDetected")}</td>
                <td>
                  <span className={`notification-setup-state ${state}`}>
                    {t(`ui.notificationSetup.state.${state}`)}
                  </span>
                  {setup?.updateAvailable ? <p className="dim">{t("ui.notificationSetup.updateAvailable")}</p> : null}
                  <details open={state === "failed"}>
                    <summary aria-label={t("ui.notificationSetup.coverageAgent", { agent: agentDisplay(agent) })}>
                      {t("ui.notificationSetup.coverage")}
                    </summary>
                    <dl className="notification-setup-coverage">
                      {events.map((event) => <div key={event}>
                        <dt>{t(eventLabels[event])}</dt>
                        <dd>{t(`ui.notificationSetup.source.${install ? setup?.events[event] ?? "unavailable" : "unavailable"}`)}</dd>
                      </div>)}
                    </dl>
                    {!install ? <p className="dim">{t("ui.notificationSetup.notInstalled")}</p> : null}
                    {!setup ? <p className="dim">{t("ui.notificationSetup.notPrepared")}</p> : <>
                      <p><span className="dim">{t("ui.notificationSetup.strategy")}: </span><code>{setup.strategy}</code></p>
                      {setup.detail ? <p className="notification-setup-detail"><span className="dim">{t("ui.notificationSetup.technicalDetail")}: </span>{setup.detail}</p> : null}
                      <p className="dim">{t("ui.notificationSetup.checkedAt")}: <time dateTime={setup.checkedAt}>{setup.checkedAt}</time></p>
                    </>}
                  </details>
                  <div className="notification-setup-actions">
                    <button type="button" className="btn small" disabled={busy}
                      aria-label={t("ui.notificationSetup.retryAgent", { agent: agentDisplay(agent) })}
                      onClick={() => void retry(agent)}>
                      {pending === agent ? t("ui.notificationSetup.busy") : t(setup?.updateAvailable ? "ui.notificationSetup.update" : "ui.notificationSetup.retry")}
                    </button>
                    {setup && (setup.state !== "unavailable" || setup.strategy !== "none") ? <button type="button" className="btn small ghost" disabled={busy}
                      aria-label={t("ui.notificationSetup.rollbackAgent", { agent: agentDisplay(agent) })}
                      onClick={() => void rollback(agent)}>{t("ui.notificationSetup.rollback")}</button> : null}
                  </div>
                </td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
      <button type="button" className="btn small ghost" disabled={busy || loading}
        onClick={() => setReloadKey((value) => value + 1)}>{t("ui.notificationSetup.reload")}</button>
    </section>
  );
}
