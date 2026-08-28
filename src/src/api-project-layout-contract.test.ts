import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  Channel: class {},
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

import { api } from "./api";

describe("Project layout Tauri contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockResolvedValue([]);
    listenMock.mockResolvedValue(() => undefined);
  });

  it("sends the complete camelCase layout and active Session", async () => {
    const entries = [
      { id: "pinned", pinned: true },
      { id: "normal", pinned: false },
    ];

    await api.setProjectLayout(entries, "session-1");

    expect(invokeMock).toHaveBeenCalledWith("set_project_layout", {
      entries,
      activeSession: "session-1",
    });
  });
});
