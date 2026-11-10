// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { searchMock, selectSessionMock } = vi.hoisted(() => ({
  searchMock: vi.fn(),
  selectSessionMock: vi.fn(),
}));

vi.mock("../api", () => ({
  api: { search: searchMock },
  errorText: (error: unknown) => String(error),
}));

vi.mock("../actions", () => ({
  selectSession: selectSessionMock,
}));

import { setState } from "../store";
import type { SessionView } from "../types";
import SearchDialog from "./SearchDialog";

const session: SessionView = {
  id: "ses_needle",
  projectId: "prj_1",
  worktreeId: null,
  title: "Fix needle bug",
  adapter: "shell",
  cwd: "/work/other",
  lifecycle: "running",
  agentSessionId: null,
  resumePrecision: "unavailable",
  permissionMode: "native",
  transport: "pty",
  unread: false,
  status: null,
  pinnedAt: null,
  createdAt: "2026-11-10T00:00:00Z",
};

describe("SearchDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    setState({
      projects: [{
        id: "prj_1",
        name: "Project",
        rootPath: "/work/other",
        gitRootPath: null,
        pinned: false,
        sessions: [session],
        worktrees: [],
      }],
      dialog: { kind: "search" },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("searches Session names and opens the selected Session", async () => {
    searchMock.mockResolvedValue({
      partial: false,
      totalHits: 1,
      hits: [{
        kind: "session",
        sessionId: session.id,
        projectId: session.projectId,
        title: session.title,
        snippet: session.cwd,
        logOffset: null,
        rotatedAway: false,
      }],
    });
    render(<SearchDialog />);

    expect(
      screen.getByPlaceholderText("搜索 Session 名称（至少 2 个字符）"),
    ).toBeTruthy();
    fireEvent.change(
      screen.getByPlaceholderText("搜索 Session 名称（至少 2 个字符）"),
      { target: { value: "needle" } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });

    expect(searchMock).toHaveBeenCalledWith("needle", 20);
    const hit = screen.getByText("Fix needle bug");
    fireEvent.click(hit.closest("button")!);
    expect(selectSessionMock).toHaveBeenCalledWith(session.id);
  });
});
