export function installDesktopEventGuards(): () => void {
  const preventNativeContextMenu = (event: Event) => event.preventDefault();
  window.addEventListener("contextmenu", preventNativeContextMenu, true);
  return () => window.removeEventListener("contextmenu", preventNativeContextMenu, true);
}
