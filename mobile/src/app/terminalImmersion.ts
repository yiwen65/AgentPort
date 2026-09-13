import { useEffect } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

// The terminal stays mounted behind the dashboard. Native chrome follows the
// visible route, not the renderer lifetime: immersive system chrome and the
// orientation lock both track the visible route. Serialize rapid enter/back changes.
let pending = Promise.resolve();
function setImmersive(immersive: boolean) {
  if (!isTauri()) return;
  pending = pending.then(() => invoke<void>("mobile_set_terminal_immersive", { immersive }))
    .catch((error) => console.warn("Unable to update terminal system chrome", error));
  // An independent command so an immersive failure cannot leave the terminal
  // portrait-locked (or the dashboard rotatable).
  pending = pending.then(() => invoke<void>("mobile_set_terminal_rotation", { rotationAllowed: immersive }))
    .catch((error) => console.warn("Unable to update terminal rotation lock", error));
}

export function useTerminalImmersion(visible: boolean) {
  useEffect(() => {
    setImmersive(visible);
    return () => setImmersive(false);
  }, [visible]);
}
