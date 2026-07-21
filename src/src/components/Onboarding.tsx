// First-run onboarding (PRD 3.1): probe agents, resolve conflicts by
// explicit path choice, manual path fallback, never a silent random pick.

import { useState } from "react";
import { api, errorText } from "../api";
import { getState, setState, toast } from "../store";
import type { ProbeOutcome } from "../types";

type RowState =
  | { phase: "idle" }
  | { phase: "probing" }
  | { phase: "done"; outcome: ProbeOutcome };

const AGENT_ORDER = ["claude", "codex", "kimi", "shell"];
const AGENT_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  kimi: "Kimi Code",
  shell: "Generic Shell",
};

function mergeAdapters(outcomes: ProbeOutcome[]) {
  const installs = outcomes.flatMap((o) => (o.install ? [o.install] : []));
  if (installs.length > 0) {
    setState({
      adapters: [
        ...getState().adapters.filter(
          (a) => !installs.some((i) => i.agentType === a.agentType),
        ),
        ...installs,
      ],
    });
  }
}

export default function Onboarding() {
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [manualPath, setManualPath] = useState<Record<string, string>>({});
  const [probingAll, setProbingAll] = useState(false);

  const probeAll = async () => {
    setProbingAll(true);
    setRows((r) => {
      const next = { ...r };
      for (const a of AGENT_ORDER) next[a] = { phase: "probing" };
      return next;
    });
    try {
      const outcomes = await api.probeAgents();
      setRows(() => {
        const next: Record<string, RowState> = {};
        for (const o of outcomes) next[o.agent] = { phase: "done", outcome: o };
        return next;
      });
      mergeAdapters(outcomes);
    } catch (e) {
      setRows({});
      toast(`探测失败：${errorText(e)}`, "error");
    } finally {
      setProbingAll(false);
    }
  };

  const probeOne = async (agent: string, path: string | null) => {
    setRows((r) => ({ ...r, [agent]: { phase: "probing" } }));
    try {
      const outcome = await api.probeAgent(agent, path);
      setRows((r) => ({ ...r, [agent]: { phase: "done", outcome } }));
      mergeAdapters([outcome]);
    } catch (e) {
      setRows((r) => ({
        ...r,
        [agent]: {
          phase: "done",
          outcome: {
            agent: agent as ProbeOutcome["agent"],
            displayName: AGENT_NAMES[agent] ?? agent,
            state: "unavailable",
            reason: errorText(e),
            install: null,
            candidates: [],
          },
        },
      }));
    }
  };

  const anyAvailable = Object.values(rows).some(
    (r) => r.phase === "done" && r.outcome.state === "available",
  );
  const close = () => setState({ showOnboarding: false });

  return (
    <div className="onboarding">
      <div className="onboarding-card" role="dialog" aria-modal="true" aria-label="设置 AgentPort">
        <h1>设置 AgentPort</h1>
        <p className="dim" style={{ margin: 0, lineHeight: 1.7 }}>
          连接你已经安装的 Claude Code、Codex 或 Kimi Code。
          探测是只读的（执行 <span className="mono">--version</span> /{" "}
          <span className="mono">--help</span>），权限默认沿用各 CLI 原生审批。
        </p>

        {AGENT_ORDER.map((agent) => {
          const row: RowState = rows[agent] ?? { phase: "idle" };
          return (
            <div className="agent-row" key={agent}>
              <span className="name">{AGENT_NAMES[agent]}</span>
              {row.phase === "idle" ? (
                <>
                  <span className="probe-mark pending">— 未检测</span>
                  <span className="detail dim">尚未执行探测</span>
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
                      {row.outcome.install.versionText} · Hook{" "}
                      {row.outcome.install.hookStatus} ·{" "}
                      {row.outcome.install.exactResume ? "支持精确恢复" : "不支持精确恢复"}
                    </span>
                  </span>
                </>
              ) : row.outcome.state === "conflict" ? (
                <>
                  <span className="probe-mark warn">! 发现多个候选</span>
                  <span className="detail">
                    请选择一个路径（不会静默随机选择）：
                    {row.outcome.candidates.map((c) => (
                      <div key={c.path} style={{ marginTop: 4 }}>
                        <button
                          className="btn small"
                          onClick={() => void probeOne(agent, c.path)}
                        >
                          使用此路径
                        </button>{" "}
                        <span className="mono">{c.path}</span>{" "}
                        <span className="dim">
                          {c.versionText ?? "版本未知"} · {c.source}
                        </span>
                      </div>
                    ))}
                  </span>
                </>
              ) : (
                <>
                  <span className="probe-mark bad">✕ 不可用</span>
                  <span className="detail">
                    {row.outcome.reason ?? "未找到可执行文件"}
                    <span className="inline-form" style={{ marginTop: 6 }}>
                      <input
                        type="text"
                        className="mono"
                        placeholder="手动指定可执行文件绝对路径"
                        aria-label={`手动指定 ${AGENT_NAMES[agent]} 路径`}
                        value={manualPath[agent] ?? ""}
                        onChange={(e) =>
                          setManualPath((m) => ({ ...m, [agent]: e.target.value }))
                        }
                      />
                      <button
                        className="btn small"
                        type="button"
                        data-tip="选择安装目录后补全可执行文件名"
                        onClick={() =>
                          void api
                            .pickDirectory()
                            .then((p) => {
                              if (p) setManualPath((m) => ({ ...m, [agent]: p }));
                            })
                            .catch((e) => toast(errorText(e), "error"))
                        }
                      >
                        浏览…
                      </button>
                      <button
                        className="btn small"
                        disabled={!(manualPath[agent] ?? "").trim()}
                        onClick={() => void probeOne(agent, (manualPath[agent] ?? "").trim())}
                      >
                        使用该路径
                      </button>
                    </span>
                  </span>
                </>
              )}
              {row.phase === "done" ? (
                <button className="btn small ghost" onClick={() => void probeOne(agent, null)}>
                  重新检测
                </button>
              ) : null}
            </div>
          );
        })}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button className="btn" disabled={probingAll} onClick={() => void probeAll()}>
            {probingAll ? "检测中…" : "检测 Agent"}
          </button>
          <button
            className="btn primary"
            onClick={close}
            data-tip={
              anyAvailable ? undefined : "尚未探测到可用 Agent；可稍后在设置中重新检测"
            }
          >
            {anyAvailable ? "继续" : "跳过，稍后设置"}
          </button>
        </div>
        <p className="form-hint" style={{ margin: 0 }}>
          GUI 的 PATH 可能与交互式 Shell 不一致；找不到 CLI 时可手动指定绝对路径。
        </p>
      </div>
    </div>
  );
}
