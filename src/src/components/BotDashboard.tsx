import { useCallback, useEffect, useState } from "react";
import { localApi, bytesToB64, errorText } from "../api";
import { activeDeviceContext } from "../deviceContext";
import { openSessionForExternalAgent, refreshProjectsSoon, selectSession } from "../actions";
import { findSession, useStore } from "../store";
import type { BotMemory, BotSnapshot, BotTask } from "../types";
import "./BotDashboard.css";

type Props = { open: boolean; onClose: () => void };

function taskTone(status: string): string {
  if (status === "completed") return "is-complete";
  if (status === "failed" || status === "needs_review") return "is-risk";
  if (status === "running" || status === "dispatching") return "is-running";
  if (status === "waiting_user") return "is-user";
  return "is-muted";
}

function taskLabel(task: BotTask): string {
  return task.status === "needs_review" ? "Needs review" : task.status.replaceAll("_", " ");
}

export default function BotDashboard({ open, onClose }: Props) {
  const projects = useStore((state) => state.projects);
  const activeSession = useStore((state) => findSession(state.projects, state.activeSessionId));
  const activeProject = activeSession
    ? projects.find((project) => project.id === activeSession.projectId) ?? null
    : projects[0] ?? null;
  const [snapshots, setSnapshots] = useState<BotSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState("claude");
  const [title, setTitle] = useState("Project Manager Bot");
  const [creating, setCreating] = useState(false);
  const [busyTask, setBusyTask] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!open || !activeProject || activeDeviceContext().kind !== "local") return;
    setLoading(true);
    try {
      const result = await localApi.listBots(activeProject.id);
      setSnapshots(result.bots);
      setError(null);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  }, [activeProject, open]);

  useEffect(() => {
    void refresh();
    if (!open) return;
    const timer = window.setInterval(() => void refresh(), 4_000);
    return () => window.clearInterval(timer);
  }, [open, refresh]);

  const create = async () => {
    if (!activeProject || !agent.trim() || creating) return;
    setCreating(true);
    try {
      const result = await localApi.createBot({
        projectId: activeProject.id,
        agent: agent.trim(),
        title: title.trim() || "Project Manager Bot",
        permission: "auto",
        riskAck: true,
      });
      refreshProjectsSoon();
      selectSession(result.sessionId);
      // The Host is attached by TerminalArea after the project snapshot. Retry
      // the bootstrap only through the normal renderer attachment capability.
      const encoded = bytesToB64(new TextEncoder().encode(`${result.bootstrap}\r`));
      void (async () => {
        for (const delay of [400, 900, 1_800]) {
          await new Promise((resolve) => window.setTimeout(resolve, delay));
          try {
            await localApi.sendInput(result.sessionId, encoded);
            await localApi.markBotBootstrapDelivered(result.botId);
            await localApi.setBotStatus(result.botId, "running");
            await refresh();
            return;
          } catch {
            // TerminalArea may not have attached yet; retry once at the next
            // bounded interval without ever sending the bootstrap twice after
            // the first successful capability write.
          }
        }
        await localApi.setBotStatus(result.botId, "needs_attention").catch(() => undefined);
        await refresh();
      })();
      await refresh();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setCreating(false);
    }
  };

  const confirmMemory = async (snapshot: BotSnapshot, memory: BotMemory, action: "confirm" | "forget") => {
    try {
      await localApi.confirmBotMemory(snapshot.bot.botId, memory.memoryId, action);
      await refresh();
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const setControl = async (snapshot: BotSnapshot, task: BotTask) => {
    const owner = task.controlOwner === "user" ? "bot" : "user";
    setBusyTask(task.taskId);
    try {
      await localApi.setBotTaskControl(snapshot.bot.botId, task.taskId, owner);
      await refresh();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusyTask(null);
    }
  };

  const openChild = (sessionId: string | null) => {
    if (!sessionId) return;
    openSessionForExternalAgent(sessionId, true);
  };

  const current = snapshots[0] ?? null;
  const managerVisible = current
    ? Boolean(findSession(projects, current.bot.managerSessionId))
    : false;

  if (!open) return null;
  return (
    <div className="bot-dashboard-layer">
      <section className="bot-dashboard-shell" role="dialog" aria-modal="true" aria-label="Project Manager Bot">
        <header className="bot-dashboard-header">
          <div>
            <span className="bot-dashboard-eyebrow">Workspace / Orchestration</span>
            <h1>Project Manager Bot</h1>
            <p>{activeProject ? `${activeProject.name} · ${activeProject.rootPath}` : "Select a project to start a Bot."}</p>
          </div>
          <div className="bot-dashboard-header-actions">
            <button type="button" className="btn" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
            <button type="button" className="btn" onClick={onClose}>Close</button>
          </div>
        </header>

        <div className="bot-dashboard-body">
          {activeDeviceContext().kind !== "local" ? (
            <div className="bot-dashboard-empty">Bot control is currently available on the local device only.</div>
          ) : !activeProject ? (
            <div className="bot-dashboard-empty">Open a project before creating a Project Manager Bot.</div>
          ) : !current ? (
            <div className="bot-dashboard-create">
              <h2>Start a project manager</h2>
              <p>The Bot is a durable coordinator. Child Agents remain ordinary Sessions and appear in panes automatically.</p>
              <label>Manager Agent<input value={agent} onChange={(event) => setAgent(event.target.value)} placeholder="claude" /></label>
              <label>Bot title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
              <button type="button" className="btn primary" onClick={() => void create()} disabled={creating}>{creating ? "Creating…" : "Create Bot"}</button>
            </div>
          ) : (
            <>
              <section className="bot-dashboard-summary">
                <div className="bot-dashboard-identity"><span className="bot-dashboard-mark">PM</span><div><h2>{current.bot.title}</h2><p>{current.bot.agent} · {current.bot.status}</p></div></div>
                <div className="bot-dashboard-summary-actions">
                  <button type="button" className="btn" onClick={() => openChild(current.bot.managerSessionId)} disabled={!managerVisible}>Open manager pane</button>
                  <span className="bot-dashboard-scope">{current.bot.projectPath}</span>
                </div>
              </section>
              {error ? <div className="bot-dashboard-error" role="alert">{error}</div> : null}
              <div className="bot-dashboard-columns">
                <main>
                  <div className="bot-dashboard-section-heading"><h2>Task graph</h2><span>{current.tasks.length} tasks</span></div>
                  {current.tasks.length === 0 ? <div className="bot-dashboard-empty small">The Bot has no tasks yet. Send an issue to the manager Session.</div> : (
                    <ul className="bot-dashboard-task-list">
                      {current.tasks.map((task) => {
                        const childSessionId = task.sessionId ?? task.sessionIds[task.sessionIds.length - 1] ?? null;
                        return (
                        <li className="bot-dashboard-task" key={task.taskId}>
                          <div className="bot-dashboard-task-top"><span className={`bot-dashboard-status ${taskTone(task.status)}`}>{taskLabel(task)}</span><strong>{task.title}</strong><span className="bot-dashboard-attempt">attempt {task.attempt}</span></div>
                          <p>{task.acceptanceCriteria || task.prompt}</p>
                          <div className="bot-dashboard-task-meta">
                            <span>{task.agent || current.bot.agent}</span><span>{task.write ? "isolated write" : "read-only"}</span>{task.worktreeId ? <span>worktree {task.worktreeId}</span> : null}
                            {task.dependencies.length > 0 ? <span>after {task.dependencies.join(", ")}</span> : null}
                          </div>
                          {task.error ? <div className="bot-dashboard-task-evidence is-error">{task.error}</div> : null}
                          {task.evidence || task.result ? <div className="bot-dashboard-task-evidence">{task.evidence || task.result}</div> : null}
                          <div className="bot-dashboard-task-actions">
                            <button type="button" className="btn" onClick={() => openChild(childSessionId)} disabled={!childSessionId}>Observe child</button>
                            <button type="button" className="btn" onClick={() => void setControl(current, task)} disabled={busyTask === task.taskId || !task.sessionId}>{task.controlOwner === "user" ? "Return to Bot" : "Take over"}</button>
                            {task.controlOwner === "user" ? <span className="bot-dashboard-lease">User controls this Session</span> : null}
                          </div>
                        </li>
                        );
                      })}
                    </ul>
                  )}
                </main>
                <aside className="bot-dashboard-memory">
                  <div className="bot-dashboard-section-heading"><h2>Project memory</h2><span>{current.memories.filter((memory) => memory.status === "confirmed").length} confirmed</span></div>
                  {current.memories.length === 0 ? <div className="bot-dashboard-empty small">No memory candidates yet.</div> : <ul>{current.memories.map((memory) => <li key={memory.memoryId}><span className={`bot-dashboard-memory-status ${memory.status}`}>{memory.status}</span><strong>{memory.kind}</strong><p>{memory.content}</p><small>{memory.source} · {memory.confidence}</small>{memory.status === "candidate" ? <div className="bot-dashboard-task-actions"><button type="button" className="btn" onClick={() => void confirmMemory(current, memory, "confirm")}>Confirm</button><button type="button" className="btn" onClick={() => void confirmMemory(current, memory, "forget")}>Forget</button></div> : null}</li>)}</ul>}
                </aside>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
