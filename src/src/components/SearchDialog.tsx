// Global search dialog (PRD 3.6): ≥2 chars, debounced, partial-result hint,
// hits grouped by kind; terminal hits jump into the session.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Modal from "./Modal";
import { api, errorText } from "../api";
import { selectSession } from "../actions";
import { closeDialog, useStore } from "../store";
import type { SearchHit, SearchResult } from "../types";

export default function SearchDialog() {
  const { t } = useTranslation("runtime");
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
        .catch((e) => setError(t("search.failed", { detail: errorText(e) })))
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
    <Modal title={t("search.title")} onClose={closeDialog} wide>
      <input
        type="text"
        placeholder={t("search.placeholder")}
        aria-label={t("search.aria")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {!s.settings?.searchIndexEnabled ? (
        <div className="form-hint">{t("search.indexDisabled")}</div>
      ) : null}
      {searching ? (
        <div className="dim">
          <span className="spin" aria-hidden="true" /> {t("search.searching")}
        </div>
      ) : null}
      {error ? <div className="error-bar" role="alert">{error}</div> : null}
      {result?.partial ? (
        <div className="warn-text">{t("search.partial")}</div>
      ) : null}
      {result && result.hits.length === 0 && !searching ? (
        <div className="empty-state">
          <div>{t("search.empty")}</div>
          <button className="btn ghost" onClick={() => setQ("")}>
            {t("search.clear")}
          </button>
        </div>
      ) : null}
      <div role="list" aria-label={t("search.resultsAria")}>
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
              <span className="kind">{t(`search.kind.${h.kind}`)}</span>
              <span className="title">
                {h.title}
                {h.snippet ? <div className="search-snippet">{h.snippet}</div> : null}
              </span>
              {h.rotatedAway ? (
                <span className="sub" data-tip={t("search.rotatedHint")}>
                  {t("search.rotated")}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
