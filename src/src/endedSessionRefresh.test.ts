import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./actions", () => ({ refreshProjects: vi.fn() }));
import { refreshProjects } from "./actions";
import { watchEndedSessions } from "./endedSessionRefresh";
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
describe("ended session reconciliation", () => {
  it("shares reads across panes, never overlaps, and stops after cleanup", async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    vi.mocked(refreshProjects).mockImplementation(() => new Promise<boolean>(done => { resolve = () => done(true); }));
    const first = watchEndedSessions();
    const second = watchEndedSessions();
    await vi.advanceTimersByTimeAsync(10000);
    expect(refreshProjects).toHaveBeenCalledTimes(1);
    first(); second();
    resolve();
    await vi.advanceTimersByTimeAsync(10000);
    expect(refreshProjects).toHaveBeenCalledTimes(1);
  });
});
