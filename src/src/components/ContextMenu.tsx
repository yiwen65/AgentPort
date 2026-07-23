// Lightweight self-drawn context menu (PRD 7.2): mouse + full keyboard
// navigation, Esc closes, click-away closes.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { closeContextMenu, useStore } from "../store";

export default function ContextMenuHost() {
  const { t } = useTranslation("common");
  const menu = useStore((state) => state.contextMenu);
  const ref = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState(0);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    setSelected(0);
  }, [menu]);

  useLayoutEffect(() => {
    if (!menu || !ref.current) {
      setPos(null);
      return;
    }
    const r = ref.current.getBoundingClientRect();
    const x = Math.min(menu.x, window.innerWidth - r.width - 8);
    const y = Math.min(menu.y, window.innerHeight - r.height - 8);
    setPos({ x: Math.max(4, x), y: Math.max(4, y) });
  }, [menu]);

  if (!menu) return null;
  const actionable = menu.items.filter((i) => !i.separator);

  const run = (idx: number) => {
    const item = actionable[idx];
    if (!item || item.disabled) return;
    closeContextMenu();
    item.action?.();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeContextMenu();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, actionable.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      run(selected);
    }
  };

  let actionIdx = -1;

  return (
    <>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 790 }}
        onMouseDown={closeContextMenu}
        onContextMenu={(e) => {
          e.preventDefault();
          closeContextMenu();
        }}
      />
      <div
        className="ctx-menu"
        role="menu"
        aria-label={t("menu.context")}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{
          left: pos?.x ?? menu.x,
          top: pos?.y ?? menu.y,
          visibility: pos ? "visible" : "hidden",
        }}
        ref={(el) => {
          ref.current = el;
          el?.focus();
        }}
      >
        {menu.items.map((item, i) => {
          if (item.separator) return <div key={i} className="ctx-separator" role="separator" />;
          actionIdx += 1;
          const myIdx = actionIdx;
          return (
            <button
              key={i}
              role="menuitem"
              className={
                "ctx-item" +
                (item.danger ? " danger" : "") +
                (myIdx === selected ? " selected" : "")
              }
              disabled={item.disabled}
              data-tip={item.tip}
              onMouseEnter={() => setSelected(myIdx)}
              onClick={() => run(myIdx)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </>
  );
}
