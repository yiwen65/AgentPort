// Command palette (⌘⇧P / Ctrl+Shift+P): fuzzy filter over projects,
// sessions and actions; pure keyboard navigation.

import { useEffect, useMemo, useRef, useState } from "react";
import Modal from "./Modal";
import { copyText } from "../api";
import {
  ackTimelineFlow,
  interruptSessionFlow,
  openNewSessionDialog,
  renameSessionFlow,
  restartSessionFlow,
  selectSession,
  stopSessionFlow,
} from "../actions";
import { agentDisplay } from "../format";
import { closeDialog, findSession, openDialog, toast, useStore } from "../store";

interface Item {
  id: string;
  kind: "会话" | "项目" | "操作";
  title: string;
  sub?: string;
  action: () => void;
}

function fuzzyScore(q: string, text: string): number | null {
  if (!q) return 0;
  const t = text.toLowerCase();
  const query = q.toLowerCase();
  let qi = 0;
  let score = 0;
  let last = -2;
  for (let i = 0; i < t.length && qi < query.length; i++) {
    if (t[i] === query[qi]) {
      score += i === last + 1 ? 2 : 1;
      last = i;
      qi++;
    }
  }
  return qi === query.length ? score : null;
}

export default function CommandPalette() {
  const s = useStore();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const activeId = s.activeSessionId;
    const activeSes = findSession(s.projects, activeId);
    const activeProject = s.projects.find((p) =>
      p.sessions.some((x) => x.id === activeId),
    );

    // Sessions first (most frequent target), then actions, then projects.
    for (const p of s.projects) {
      for (const ses of p.sessions) {
        out.push({
          id: `ses:${ses.id}`,
          kind: "会话",
          title: ses.title,
          sub: `${agentDisplay(ses.adapter)} · ${p.name}`,
          action: () => selectSession(ses.id),
        });
      }
    }

    const act = (id: string, title: string, action: () => void, sub?: string) =>
      out.push({ id: `act:${id}`, kind: "操作", title, action, sub });

    act("new-session", "新建 Session…", () => openNewSessionDialog());
    if (activeProject?.gitRootPath || s.projects.some((p) => p.gitRootPath)) {
      act("new-worktree", "新建 Worktree…", () =>
        openDialog({
          kind: "newWorktree",
          projectId: activeProject?.id ?? s.projects.find((p) => p.gitRootPath)!.id,
        }),
      );
    }
    act("add-project", "添加项目…", () => openDialog({ kind: "addProject" }));
    act("search", "全局搜索…", () => openDialog({ kind: "search" }));
    act("timeline", "恢复时间线", () => openDialog({ kind: "timeline" }));
    act("ack", "时间线全部已读", () => void ackTimelineFlow());
    act("settings", "打开设置", () => openDialog({ kind: "settings" }));
    act("diag", "打开诊断中心", () => openDialog({ kind: "diagnostics" }));
    if (activeSes) {
      act("rename", `重命名「${activeSes.title}」…`, () => void renameSessionFlow(activeSes.id));
      act(
        "copy-id",
        "复制当前 Session ID",
        () =>
          void copyText(activeSes.id).then((ok) =>
            toast(ok ? "已复制 Session ID" : "复制失败", ok ? "success" : "error"),
          ),
      );
      act("export-md", "导出当前会话 Markdown…", () =>
        openDialog({ kind: "export", sessionId: activeSes.id, exportKind: "md" }),
      );
      act("export-log", "导出当前会话原始日志…", () =>
        openDialog({ kind: "export", sessionId: activeSes.id, exportKind: "log" }),
      );
      act("restart", "重启并恢复当前 Session…", () => void restartSessionFlow(activeSes.id));
      if (activeSes.lifecycle === "running") {
        act("interrupt", "中断当前 Session（Ctrl-C）", () => void interruptSessionFlow(activeSes.id));
      }
      act("stop", "停止当前 Session…", () => void stopSessionFlow(activeSes.id));
    }

    for (const p of s.projects) {
      out.push({
        id: `prj:${p.id}`,
        kind: "项目",
        title: p.name,
        sub: p.rootPath,
        action: () => {
          const first = p.sessions[0];
          if (first) selectSession(first.id);
          else openNewSessionDialog(p.id);
        },
      });
    }

    if (!q.trim()) return out;
    return out
      .map((item) => {
        const score =
          fuzzyScore(q, item.title) ??
          (item.sub ? fuzzyScore(q, item.sub) : null) ??
          fuzzyScore(q, `${item.kind} ${item.title}`);
        return { item, score };
      })
      .filter((x): x is { item: Item; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
      .map((x) => x.item);
  }, [q, s.projects, s.activeSessionId]);

  useEffect(() => setSelected(0), [q]);

  useEffect(() => {
    const el = listRef.current?.querySelectorAll(".palette-item")[selected];
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const run = (idx: number) => {
    const item = items[idx];
    if (!item) return;
    closeDialog();
    item.action();
  };

  return (
    <Modal title="命令面板" onClose={closeDialog} wide>
      <input
        className="palette-input"
        type="text"
        placeholder="输入以过滤会话、项目与操作…"
        aria-label="命令面板过滤"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelected((x) => Math.min(x + 1, items.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelected((x) => Math.max(x - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            run(selected);
          }
        }}
      />
      <div className="palette-list" role="listbox" aria-label="命令列表" ref={listRef}>
        {items.length === 0 ? (
          <div className="dim" style={{ padding: 12 }}>
            没有匹配项
          </div>
        ) : (
          items.map((item, i) => (
            <button
              key={item.id}
              role="option"
              aria-selected={i === selected}
              className={"palette-item" + (i === selected ? " selected" : "")}
              onMouseEnter={() => setSelected(i)}
              onClick={() => run(i)}
            >
              <span className="kind">{item.kind}</span>
              <span className="title">{item.title}</span>
              {item.sub ? <span className="sub">{item.sub}</span> : null}
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}
