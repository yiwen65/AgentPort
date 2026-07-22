// First-run onboarding: load the backend adapter registry, then probe every
// registered CLI. The renderer deliberately has no fixed Agent list.

import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { getState, setState, toast } from "../store";
import type { ProbeOutcome, SupportedAgent } from "../types";

type RowState =
  | { phase: "idle" }
  | { phase: "probing" }
  | { phase: "done"; outcome: ProbeOutcome };

function mergeAdapters(outcomes: ProbeOutcome[]) {
  const installs = outcomes.flatMap((outcome) => (outcome.install ? [outcome.install] : []));
  if (installs.length > 0) {
    setState({
      adapters: [
        ...getState().adapters.filter(
          (adapter) => !installs.some((install) => install.agentType === adapter.agentType),
        ),
        ...installs,
      ],
    });
  }
}

export default function Onboarding() {
  const [agents, setAgents] = useState<SupportedAgent[]>([]);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [manualPath, setManualPath] = useState<Record<string, string>>({});
  const [probingAll, setProbingAll] = useState(false);
  const [registryError, setRegistryError] = useState<string | null>(null);

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

  const probeAll = async () => {
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
      toast(`探测失败：${errorText(error)}`, "error");
    } finally {
      setProbingAll(false);
    }
  };

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
            reason: errorText(error),
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
          placeholder={`指定 ${registered.commandNames.join(" / ")} 的绝对路径`}
          aria-label={`手动指定 ${registered.displayName} 路径`}
          value={manualPath[agent] ?? ""}
          onChange={(event) =>
            setManualPath((current) => ({ ...current, [agent]: event.target.value }))
          }
        />
        <button
          className="btn small"
          type="button"
          data-tip="选择安装目录后补全可执行文件名"
          onClick={() =>
            void api
              .pickDirectory()
              .then((path) => {
                if (path) setManualPath((current) => ({ ...current, [agent]: path }));
              })
              .catch((error) => toast(errorText(error), "error"))
          }
        >
          浏览…
        </button>
        <button
          className="btn small"
          disabled={!(manualPath[agent] ?? "").trim()}
          onClick={() => void probeOne(registered, (manualPath[agent] ?? "").trim())}
        >
          使用该路径
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
      <div className="onboarding-card" role="dialog" aria-modal="true" aria-label="设置 AgentPort">
        <h1>设置 AgentPort</h1>
        <p className="dim" style={{ margin: 0, lineHeight: 1.7 }}>
          自动检测本机已注册的 Agent。探测只读（执行 <span className="mono">--version</span> /{" "}
          <span className="mono">--help</span>）；多路径会按优先级自动验证并选择可用版本，也可手动指定。
        </p>

        {registryError ? (
          <div className="error-bar" role="alert">无法加载 Agent 注册表：{registryError}</div>
        ) : null}

        {agents.map((registered) => {
          const row: RowState = rows[registered.agent] ?? { phase: "idle" };
          return (
            <div className="agent-row" key={registered.agent}>
              <span className="name">{registered.displayName}</span>
              {row.phase === "idle" ? (
                <>
                  <span className="probe-mark pending">— 未检测</span>
                  <span className="detail dim">
                    尚未执行探测
                    <details className="agent-candidates">
                      <summary>手动指定路径</summary>
                      {manualControls(registered)}
                    </details>
                  </span>
                </>
              ) : row.phase === "probing" ? (
                <>
                  <span className="spin" aria-hidden="true" />
                  <span className="detail dim">检测中…</span>
                </>
              ) : row.outcome.state === "available" && row.outcome.install ? (
                <>
                  <span className="probe-mark ok">✓ 可用</span>
                  <span className="detail">
                    <span className="mono">{row.outcome.install.executablePath}</span>
                    <br />
                    <span className="dim">
                      {row.outcome.install.versionText} · Hook {row.outcome.install.hookStatus} ·{" "}
                      {row.outcome.install.exactResume ? "支持精确恢复" : "不支持精确恢复"}
                    </span>
                    {row.outcome.reason ? <><br /><span className="dim">{row.outcome.reason}</span></> : null}
                    <details className="agent-candidates">
                      <summary>候选路径与手动覆盖（{row.outcome.candidates.length}）</summary>
                      {row.outcome.candidates.map((candidate) => (
                        <div key={candidate.path} style={{ marginTop: 4 }}>
                          <button
                            className="btn small"
                            onClick={() => void probeOne(registered, candidate.path)}
                          >
                            使用此路径
                          </button>{" "}
                          <span className="mono">{candidate.path}</span>{" "}
                          <span className="dim">
                            {candidate.versionText ?? "尚未验证"} · {candidate.source}
                          </span>
                        </div>
                      ))}
                      {manualControls(registered)}
                    </details>
                  </span>
                </>
              ) : row.outcome.state === "conflict" ? (
                <>
                  <span className="probe-mark warn">! 需要指定路径</span>
                  <span className="detail">
                    请选择一个候选路径：
                    {row.outcome.candidates.map((candidate) => (
                      <div key={candidate.path} style={{ marginTop: 4 }}>
                        <button className="btn small" onClick={() => void probeOne(registered, candidate.path)}>
                          使用此路径
                        </button>{" "}
                        <span className="mono">{candidate.path}</span>
                      </div>
                    ))}
                    {manualControls(registered)}
                  </span>
                </>
              ) : (
                <>
                  <span className="probe-mark bad">✕ 不可用</span>
                  <span className="detail">
                    {row.outcome.reason ?? "未找到可执行文件"}
                    <details className="agent-candidates" open>
                      <summary>指定其他路径</summary>
                      {manualControls(registered)}
                    </details>
                  </span>
                </>
              )}
              {row.phase === "done" ? (
                <button className="btn small ghost" onClick={() => void probeOne(registered, null)}>
                  重新检测
                </button>
              ) : null}
            </div>
          );
        })}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button className="btn" disabled={probingAll || agents.length === 0} onClick={() => void probeAll()}>
            {probingAll ? "检测中…" : "检测全部 Agent"}
          </button>
          <button
            className="btn primary"
            onClick={close}
            data-tip={anyAvailable ? undefined : "尚未探测到可用 Agent；可稍后在设置中重新检测"}
          >
            {anyAvailable ? "继续" : "跳过，稍后设置"}
          </button>
        </div>
        <p className="form-hint" style={{ margin: 0 }}>
          已注册的新 Agent 会自动出现在此处；新增未知 CLI 仍需要相应适配器，避免以不受管参数启动。
        </p>
      </div>
    </div>
  );
}
