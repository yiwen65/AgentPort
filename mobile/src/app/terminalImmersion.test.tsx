import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTerminalImmersion } from "./terminalImmersion";

const native = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(undefined), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => native);
function Route({ visible }: { visible: boolean }) {
  useTerminalImmersion(visible);
  return null;
}
afterEach(async () => {
  cleanup();
  await act(async () => {});
  vi.clearAllMocks();
});

describe("native terminal immersion", () => {
  it("restores system chrome and rotation on dashboard navigation and unmount, in submission order", async () => {
    let finish!: () => void;
    native.invoke.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const { rerender, unmount } = render(<Route visible />);
    await waitFor(() => expect(native.invoke).toHaveBeenCalledOnce());
    rerender(<Route visible={false} />);
    rerender(<Route visible />);
    expect(native.invoke).toHaveBeenCalledOnce();
    await act(async () => { finish(); });
    expect(native.invoke.mock.calls.map(call => [call[0], call[1]])).toEqual([
      ["mobile_set_terminal_immersive", { immersive: true }],
      ["mobile_set_terminal_rotation", { rotationAllowed: true }],
      // Each transition queues the cleanup and the next effect value.
      ["mobile_set_terminal_immersive", { immersive: false }],
      ["mobile_set_terminal_rotation", { rotationAllowed: false }],
      ["mobile_set_terminal_immersive", { immersive: false }],
      ["mobile_set_terminal_rotation", { rotationAllowed: false }],
      ["mobile_set_terminal_immersive", { immersive: false }],
      ["mobile_set_terminal_rotation", { rotationAllowed: false }],
      ["mobile_set_terminal_immersive", { immersive: true }],
      ["mobile_set_terminal_rotation", { rotationAllowed: true }],
    ]);
    unmount();
    await waitFor(() => expect(native.invoke).toHaveBeenLastCalledWith("mobile_set_terminal_rotation", { rotationAllowed: false }));
    expect(native.invoke.mock.calls[native.invoke.mock.calls.length - 2]).toEqual(["mobile_set_terminal_immersive", { immersive: false }]);
  });

  it("still updates rotation after a native chrome failure without an unhandled rejection", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    native.invoke.mockRejectedValueOnce(new Error("unsupported controller"));
    const { rerender } = render(<Route visible />);
    await waitFor(() => expect(native.invoke).toHaveBeenLastCalledWith("mobile_set_terminal_rotation", { rotationAllowed: true }));
    expect(warning).toHaveBeenCalledOnce();
    rerender(<Route visible={false} />);
    await waitFor(() => expect(native.invoke).toHaveBeenLastCalledWith("mobile_set_terminal_rotation", { rotationAllowed: false }));
    warning.mockRestore();
  });

  it("leaves browser previews usable without native IPC", async () => {
    native.isTauri.mockReturnValue(false);
    render(<Route visible />);
    await act(async () => {});
    expect(native.invoke).not.toHaveBeenCalled();
    cleanup();
    native.isTauri.mockReturnValue(true);
  });
});
