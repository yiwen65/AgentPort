// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mounts: 0,
  unmounts: 0,
  api: {
    boot: vi.fn(() => new Promise(() => undefined)),
    takePendingNotificationSession: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("./api", () => ({
  api: mocks.api,
  errorText: (error: unknown) => String(error),
  onGitStateInvalidated: vi.fn().mockResolvedValue(vi.fn()),
  onNotificationActivated: vi.fn().mockResolvedValue(vi.fn()),
  onProjectsChanged: vi.fn().mockResolvedValue(vi.fn()),
  onRepositoryStateChanged: vi.fn().mockResolvedValue(vi.fn()),
  onSessionAgentId: vi.fn().mockResolvedValue(vi.fn()),
  onSessionExit: vi.fn().mockResolvedValue(vi.fn()),
  onSessionState: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("./actions", () => ({
  applyThemeSettings: vi.fn(),
  isMac: vi.fn().mockReturnValue(true),
  openNewSessionDialog: vi.fn(),
  refreshProjectsSoon: vi.fn(),
  restartSessionFlow: vi.fn(),
  selectSession: vi.fn(),
  switchSessionByIndex: vi.fn(),
  toggleSidebarCollapsed: vi.fn(),
}));

vi.mock("./terminals", () => ({
  applyTerminalLanguage: vi.fn(),
  pruneHandles: vi.fn(),
  scrollToBottom: vi.fn(),
}));

vi.mock("./components/TerminalArea", async () => {
  const React = await import("react");
  return {
    default: () => {
      React.useEffect(() => {
        mocks.mounts += 1;
        return () => {
          mocks.unmounts += 1;
        };
      }, []);
      return (
        <section data-testid="terminal-area">
          <input aria-label="document draft" defaultValue="kept" />
        </section>
      );
    },
  };
});
vi.mock("./components/GitCenter", () => ({
  default: () => <section data-testid="git-center">Git Center</section>,
}));
vi.mock("./components/TopBar", () => ({ default: () => null }));
vi.mock("./components/Sidebar", () => ({ default: () => null }));
vi.mock("./components/Tooltip", () => ({ default: () => null }));
vi.mock("./components/Toasts", () => ({ default: () => null }));
vi.mock("./components/ContextMenu", () => ({ default: () => null }));
vi.mock("./components/Onboarding", () => ({ default: () => null }));
vi.mock("./components/Dialogs", () => ({
  ConfirmDialogHost: () => null,
  PromptDialogHost: () => null,
}));

import App from "./App";
import { emptyGitCenterState, getState, setState } from "./store";

describe("Git Center workspace mounting", () => {
  beforeEach(() => {
    mocks.mounts = 0;
    mocks.unmounts = 0;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    setState({
      ready: true,
      bootError: null,
      showOnboarding: false,
      projects: [],
      activeSessionId: null,
      gitCenter: emptyGitCenterState(),
    });
  });

  afterEach(cleanup);

  it("hides but never unmounts TerminalArea or its document state", async () => {
    render(<App />);
    const terminal = await screen.findByTestId("terminal-area");
    const input = screen.getByRole("textbox", {
      name: "document draft",
    }) as HTMLInputElement;
    input.value = "unsaved document state";
    expect(mocks.mounts).toBe(1);

    act(() => {
      setState({
        gitCenter: {
          ...getState().gitCenter,
          open: true,
        },
      });
    });
    await screen.findByTestId("git-center");
    expect(terminal.isConnected).toBe(true);
    expect(input.value).toBe("unsaved document state");
    expect(mocks.mounts).toBe(1);
    expect(mocks.unmounts).toBe(0);

    act(() => {
      setState({
        gitCenter: {
          ...getState().gitCenter,
          open: false,
        },
      });
    });
    await waitFor(() => expect(screen.queryByTestId("git-center")).toBeNull());
    expect(screen.getByTestId("terminal-area")).toBe(terminal);
    expect(input.value).toBe("unsaved document state");
    expect(mocks.mounts).toBe(1);
    expect(mocks.unmounts).toBe(0);
  });
});
