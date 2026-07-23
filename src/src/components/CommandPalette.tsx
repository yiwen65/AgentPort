// Command palette (⌘⇧P / Ctrl+Shift+P): fuzzy filter over actions; pure
// keyboard navigation. Projects and individual sessions stay in the sidebar.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Modal from "./Modal";
import {
  ackTimelineFlow,
  copyTextWithToast,
  interruptSessionFlow,
  openNewSessionDialog,
  renameSessionFlow,
  restartSessionFlow,
  stopSessionFlow,
} from "../actions";
import { closeDialog, findSession, openDialog, useStore } from "../store";

interface Item {
  id: string;
  kind: string;
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
  const { t } = useTranslation("runtime");
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
    const gitProjects = s.projects.filter(
      (project) => s.repositoryStatuses[project.id]?.isGitRepository === true,
    );
    const activeGitProject = activeProject &&
      s.repositoryStatuses[activeProject.id]?.isGitRepository === true
      ? activeProject
      : undefined;

    const act = (id: string, title: string, action: () => void, sub?: string) =>
      out.push({ id: `act:${id}`, kind: t("palette.kindAction"), title, action, sub });

    act("new-session", t("palette.newSession"), () => openNewSessionDialog());
    if (activeProject?.gitRootPath || s.projects.some((p) => p.gitRootPath)) {
      act("new-worktree", t("palette.newWorktree"), () =>
        openDialog({
          kind: "newWorktree",
          projectId: activeProject?.id ?? s.projects.find((p) => p.gitRootPath)!.id,
        }),
      );
    }
    if (gitProjects.length) {
      act("manage-branches", t("palette.manageBranches"), () =>
        openDialog({
          kind: "branchPicker",
          projectId: activeGitProject?.id ?? gitProjects[0].id,
        }),
      );
    }
    act("add-project", t("palette.addProject"), () => openDialog({ kind: "addProject" }));
    act("search", t("palette.globalSearch"), () => openDialog({ kind: "search" }));
    act("timeline", t("palette.recoveryTimeline"), () => openDialog({ kind: "timeline" }));
    act("ack", t("palette.markTimelineRead"), () => void ackTimelineFlow());
    act("settings", t("palette.openSettings"), () => openDialog({ kind: "settings" }));
    act("diag", t("palette.openDiagnostics"), () => openDialog({ kind: "diagnostics" }));
    if (activeSes) {
      act("rename", t("palette.renameSession", { title: activeSes.title }), () => void renameSessionFlow(activeSes.id));
      act(
        "copy-id",
        t("palette.copySessionId"),
        () => void copyTextWithToast(activeSes.id, t("palette.sessionIdCopied")),
      );
      act("export-md", t("palette.exportMarkdown"), () =>
        openDialog({ kind: "export", sessionId: activeSes.id, exportKind: "md" }),
      );
      act("export-log", t("palette.exportLog"), () =>
        openDialog({ kind: "export", sessionId: activeSes.id, exportKind: "log" }),
      );
      act("restart", t("palette.restartSession"), () => void restartSessionFlow(activeSes.id));
      if (activeSes.lifecycle === "running") {
        act("interrupt", t("palette.interruptSession"), () => void interruptSessionFlow(activeSes.id));
      }
      act("stop", t("palette.stopSession"), () => void stopSessionFlow(activeSes.id));
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
  }, [q, s.projects, s.activeSessionId, s.repositoryStatuses, t]);

  useEffect(() => setSelected(0), [q]);

  useEffect(() => {
    const el = listRef.current?.querySelectorAll(".palette-item")[selected];
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [selected]);

  const run = (idx: number) => {
    const item = items[idx];
    if (!item) return;
    closeDialog();
    item.action();
  };

  return (
    <Modal title={t("palette.title")} onClose={closeDialog} wide>
      <input
        className="palette-input"
        type="text"
        placeholder={t("palette.filterPlaceholder")}
        aria-label={t("palette.filterAria")}
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
      <div className="palette-list" role="listbox" aria-label={t("palette.listAria")} ref={listRef}>
        {items.length === 0 ? (
          <div className="dim" style={{ padding: 12 }}>
            {t("palette.noMatches")}
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
