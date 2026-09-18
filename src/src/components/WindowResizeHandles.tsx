// Frameless-Linux window resize zones. With native decorations off
// (src-tauri/tauri.linux.conf.json), the WM provides no resize border, so
// thin fixed edge/corner zones forward drags to the native resize grab.
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MouseEvent as ReactMouseEvent } from "react";
import { isLinuxFramelessChrome, useStore } from "../store";

type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

const HANDLES: ReadonlyArray<{ id: string; direction: ResizeDirection }> = [
  { id: "n", direction: "North" },
  { id: "s", direction: "South" },
  { id: "e", direction: "East" },
  { id: "w", direction: "West" },
  { id: "ne", direction: "NorthEast" },
  { id: "nw", direction: "NorthWest" },
  { id: "se", direction: "SouthEast" },
  { id: "sw", direction: "SouthWest" },
];

export default function WindowResizeHandles() {
  const frameless = isLinuxFramelessChrome(useStore((state) => state.platform));
  if (!frameless) return null;

  const startResize =
    (direction: ResizeDirection) => (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      void getCurrentWindow().startResizeDragging(direction).catch(() => undefined);
    };

  return (
    <>
      {HANDLES.map((handle) => (
        <div
          key={handle.id}
          className={`resize-handle resize-handle-${handle.id}`}
          aria-hidden="true"
          onMouseDown={startResize(handle.direction)}
        />
      ))}
    </>
  );
}
