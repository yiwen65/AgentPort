// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getGitCommitDetailMock, openExternalUrlMock, copyTextMock } = vi.hoisted(
  () => ({
    getGitCommitDetailMock: vi.fn(),
    openExternalUrlMock: vi.fn(),
    copyTextMock: vi.fn(),
  }),
);

vi.mock("./api", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api")>();
  return {
    ...original,
    api: {
      ...original.api,
      getGitCommitDetail: getGitCommitDetailMock,
      openExternalUrl: openExternalUrlMock,
    },
    copyText: copyTextMock,
  };
});

import GitHistoryPanel from "./components/GitHistoryPanel";
import {
  clearCommitPreviewCache,
  commitWebLink,
} from "./components/GitCommitHoverCard";
import { emptyGitCenterState, setState, type GitCheckoutUiState } from "./store";
import type {
  GitCommitDetail,
  GitCommitSummary,
  GitCheckoutDescriptor,
} from "./types";

const context: GitCheckoutDescriptor = {
  target: { projectId: "project-1", kind: "worktree", worktreeId: "worktree-1" },
  checkoutId: "checkout-1",
  repoKey: "repo-1",
  projectName: "Mock Project",
  projectRoot: "/mock/project",
  checkoutRoot: "/mock/worktree",
  expectedBranch: "feature/mock",
  actualBranch: "feature/mock",
  headOid: "a".repeat(40),
  detached: false,
  unborn: false,
  ongoingOperation: null,
  hasRemote: true,
  remote: "origin",
  remoteUrl: "git@github.com:mock/project.git",
  upstream: "origin/feature/mock",
  ahead: 0,
  behind: 0,
  worktreeHealth: null,
  liveSessionIds: [],
  writable: true,
  blockers: [],
  warnings: [],
};

const commit: GitCommitSummary = {
  oid: "bde2807b9000000000000000000000000000000a",
  shortOid: "bde2807b",
  parentOids: ["c".repeat(40)],
  authorName: "yiwen65",
  authorEmail: "yiwen65@example.com",
  authoredAt: "2026-08-28T20:15:00.000Z",
  committedAt: "2026-08-28T20:15:00.000Z",
  subject: "feat(coding-agent): add v2 read providers",
};

const detail: GitCommitDetail = {
  context,
  commit,
  message: commit.subject,
  selectedParentOid: commit.parentOids[0],
  files: [
    {
      status: "modified",
      pathToken: "p1",
      displayPath: "src/a.ts",
      oldPathToken: null,
      displayOldPath: null,
      additions: 10,
      deletions: 2,
      binary: false,
    },
    {
      status: "added",
      pathToken: "p2",
      displayPath: "src/b.ts",
      oldPathToken: null,
      displayOldPath: null,
      additions: null,
      deletions: null,
      binary: true,
    },
    {
      status: "deleted",
      pathToken: "p3",
      displayPath: "src/c.ts",
      oldPathToken: null,
      displayOldPath: null,
      additions: 0,
      deletions: 0,
      binary: false,
    },
  ],
};

function showHistory() {
  const cache: GitCheckoutUiState = {
    context,
    changes: null,
    changesPhase: "idle",
    changesError: null,
    selectedEntries: {},
    diffSelection: null,
    diff: null,
    diffPhase: "idle",
    diffError: null,
    history: {
      context,
      anchorOid: context.headOid,
      commits: [commit],
      nextCursor: null,
      headChanged: false,
      observedAt: "2026-08-29T07:15:00.000Z",
    },
    historyPhase: "ready",
    historyError: null,
    selectedCommitOid: null,
    commitDetail: null,
    commitPatch: null,
    commitDetailPhase: "idle",
    commitDetailError: null,
    commitDraft: "",
    commitReview: null,
    commitReviewOpen: false,
    commitPhase: "idle",
    commitError: null,
    commitAiPhase: "idle",
    commitAiError: null,
    lastCommitResult: null,
  };
  setState({
    gitCenter: {
      ...emptyGitCenterState(),
      open: true,
      view: "history",
      locator: {
        kind: "worktree",
        projectId: "project-1",
        worktreeId: "worktree-1",
      },
      activeCheckoutId: context.checkoutId,
      resolvePhase: "ready",
      caches: { [context.checkoutId]: cache },
    },
  });
}

describe("commitWebLink", () => {
  it("derives web commit URLs from common remote URL forms", () => {
    expect(commitWebLink("git@github.com:owner/repo.git", "abc")).toEqual({
      url: "https://github.com/owner/repo/commit/abc",
      host: "github.com",
    });
    expect(commitWebLink("https://github.com/owner/repo.git", "abc")?.url).toBe(
      "https://github.com/owner/repo/commit/abc",
    );
    expect(commitWebLink("ssh://git@gitlab.com/owner/repo", "abc")?.url).toBe(
      "https://gitlab.com/owner/repo/commit/abc",
    );
    expect(commitWebLink(null, "abc")).toBeNull();
    expect(commitWebLink("/local/path", "abc")).toBeNull();
  });
});

describe("Git history hover preview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T07:15:00.000Z"));
    getGitCommitDetailMock.mockReset().mockResolvedValue(detail);
    openExternalUrlMock.mockReset().mockResolvedValue(undefined);
    copyTextMock.mockReset().mockResolvedValue(true);
    clearCommitPreviewCache();
    setState({ gitCenter: emptyGitCenterState() });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows a preview card with stats after hovering a commit row", async () => {
    showHistory();
    render(<GitHistoryPanel />);

    const row = screen.getByText(commit.subject).closest("button")!;
    fireEvent.mouseEnter(row);
    await act(async () => {
      vi.advanceTimersByTime(450);
    });

    expect(screen.getByText("yiwen65")).toBeTruthy();
    expect(screen.getByText(/11小时前/)).toBeTruthy();
    expect(screen.getByText("3 个文件变更")).toBeTruthy();
    expect(screen.getByText("10 行新增(+)")).toBeTruthy();
    expect(screen.getByText("2 行删除(-)")).toBeTruthy();
    expect(screen.getByText("在 GitHub 上打开")).toBeTruthy();

    fireEvent.click(screen.getByText("在 GitHub 上打开"));
    expect(openExternalUrlMock).toHaveBeenCalledWith(
      `https://github.com/mock/project/commit/${commit.oid}`,
    );

    fireEvent.click(screen.getByLabelText("复制提交 ID"));
    await act(async () => {});
    expect(copyTextMock).toHaveBeenCalledWith(commit.oid);

    fireEvent.mouseLeave(row);
    fireEvent.mouseLeave(screen.getByRole("tooltip"));
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.queryByText("在 GitHub 上打开")).toBeNull();
  });

  it("does not fetch stats before the hover delay elapses and caches per commit", async () => {
    showHistory();
    render(<GitHistoryPanel />);

    const row = screen.getByText(commit.subject).closest("button")!;
    fireEvent.mouseEnter(row);
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(getGitCommitDetailMock).not.toHaveBeenCalled();
    fireEvent.mouseLeave(row);

    fireEvent.mouseEnter(row);
    await act(async () => {
      vi.advanceTimersByTime(450);
    });
    expect(getGitCommitDetailMock).toHaveBeenCalledTimes(1);

    fireEvent.mouseLeave(row);
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    fireEvent.mouseEnter(row);
    await act(async () => {
      vi.advanceTimersByTime(450);
    });
    expect(getGitCommitDetailMock).toHaveBeenCalledTimes(1);
  });
});
