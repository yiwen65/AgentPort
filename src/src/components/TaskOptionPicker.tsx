import { useEffect, useMemo, useRef, useState } from "react";
import type { TaskOption } from "../types";

type TaskOptionPickerProps = {
  label: string;
  options: TaskOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  multiple?: boolean;
  loading?: boolean;
  error?: string | null;
  placeholder?: string;
};

export function TaskOptionPicker({
  label,
  options,
  selected,
  onChange,
  multiple = true,
  loading = false,
  error = null,
  placeholder = "Choose from repository",
}: TaskOptionPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const selectedOptions = selected.map((id) => options.find((option) => option.id === id) ?? { id, name: id });
  const normalizedQuery = query.trim().toLowerCase();
  const visibleOptions = options.filter((option) => !normalizedQuery || `${option.name} ${option.id}`.toLowerCase().includes(normalizedQuery));

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const toggleOption = (option: TaskOption) => {
    if (multiple) {
      onChange(selectedSet.has(option.id) ? selected.filter((id) => id !== option.id) : [...selected, option.id]);
    } else {
      onChange(selectedSet.has(option.id) ? [] : [option.id]);
      setOpen(false);
    }
  };

  const removeOption = (id: string) => onChange(selected.filter((selectedId) => selectedId !== id));

  return (
    <div ref={rootRef} className="task-option-picker">
      <span className="task-option-picker-label">{label}</span>
      <div
        className={`task-option-picker-control${open ? " is-open" : ""}`}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={label}
        tabIndex={0}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen((value) => !value);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      >
        {selectedOptions.length > 0 ? selectedOptions.map((option) => (
          <span className="task-option-picker-chip" key={option.id}>
            <span>{option.name}</span>
            <button
              type="button"
              aria-label={`Remove ${option.name} from ${label}`}
              onClick={(event) => { event.stopPropagation(); removeOption(option.id); }}
            >×</button>
          </span>
        )) : <span className="task-option-picker-placeholder">{loading ? "Loading repository options…" : placeholder}</span>}
        <span className="task-option-picker-chevron" aria-hidden="true">⌄</span>
      </div>
      {error && options.length === 0 ? <span className="task-option-picker-error">{error}</span> : null}
      {open ? (
        <div className="task-option-picker-menu" role="listbox" aria-label={`${label} options`}>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpen(false);
              if (event.key === "Enter") event.preventDefault();
            }}
            placeholder={`Search ${label.toLowerCase()}`}
            autoFocus
          />
          {loading ? <p className="task-option-picker-empty">Loading repository options…</p> : null}
          {!loading && visibleOptions.length === 0 ? <p className="task-option-picker-empty">{error ? "Options unavailable" : "No matching repository option"}</p> : null}
          {!loading ? visibleOptions.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={selectedSet.has(option.id)}
              className={`task-option-picker-option${selectedSet.has(option.id) ? " is-selected" : ""}`}
              key={option.id}
              onClick={(event) => { event.stopPropagation(); toggleOption(option); }}
            >
              <span className="task-option-picker-check" aria-hidden="true">{selectedSet.has(option.id) ? "✓" : ""}</span>
              <span>{option.name}</span>
              {option.name !== option.id ? <small>{option.id}</small> : null}
            </button>
          )) : null}
        </div>
      ) : null}
    </div>
  );
}
