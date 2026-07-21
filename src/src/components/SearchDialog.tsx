// Global search dialog (PRD 3.6): ≥2 chars, debounced, partial-result hint,
// hits grouped by kind; terminal hits jump into the session.

import { useEffect, useRef, useState } from "react";
import Modal from "./Modal";
import { api, errorText } from "../api";
import { selectSession } from "../actions";
import { closeDialog, useStore } from "../store";
import type { SearchHit, SearchResult } from "../types";

const KIND_LABEL: Record<SearchHit["kind"], string> = {
  project: "项目",
  session: "会话",
  branch: "分支",
  terminal: "终端",
};

export default function SearchDialog() {
  const s = useStore();
  const [q, setQ] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (q.trim().length < 2) {
      setResult(null);
      setSearching(false);
      setError(null);
      return;
    }
    setSearching(true);
    timer.current = window.setTimeout(() => {
      api
        .search(q.trim(), 20)
        .then((r) => {
          setResult(r);
          setError(null);
        })
        .catch((e) => setError(errorText(e)))
        .finally(() => setSearching(false));
    }, 350);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [q]);

  const openHit = (h: SearchHit) => {
    if (h.sessionId && s.projects.some((p) => p.sessions.some((x) => x.id === h.sessionId))) {
      closeDialog();
      selectSession(h.sessionId);
    }
  };

  return (
    <Modal title="全局搜索" onClose={closeDialog} wide>
      <input
        type="text"
        placeholder="搜索项目、Session、分支或终端文本（至少 2 个字符）"
        aria-label="全局搜索"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {!s.settings?.searchIndexEnabled ? (
        <div className="form-hint">搜索索引已在设置中关闭，结果可能不完整。</div>
      ) : null}
      {searching ? (
        <div className="dim">
          <span className="spin" aria-hidden="true" /> 搜索中…
        </div>
      ) : null}
      {error ? <div className="error-bar" role="alert">{error}</div> : null}
      {result?.partial ? (
        <div className="warn-text">结果可能不完整（部分日志已轮转或索引待重建）。</div>
      ) : null}
      {result && result.hits.length === 0 && !searching ? (
        <div className="empty-state">
          <div>没有匹配的项目、Session、分支或终端文本。</div>
          <button className="btn ghost" onClick={() => setQ("")}>
            清除筛选
          </button>
        </div>
      ) : null}
      <div role="list" aria-label="搜索结果">
        {result?.hits.map((h, i) => {
          const clickable = Boolean(h.sessionId);
          return (
            <button
              key={i}
              className="palette-item"
              role="listitem"
              disabled={!clickable}
              onClick={() => openHit(h)}
            >
              <span className="kind">{KIND_LABEL[h.kind]}</span>
              <span className="title">
                {h.title}
                {h.snippet ? <div className="search-snippet">{h.snippet}</div> : null}
              </span>
              {h.rotatedAway ? (
                <span className="sub" data-tip="对应输出已轮转，仅保留事件元数据">
                  已轮转
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
