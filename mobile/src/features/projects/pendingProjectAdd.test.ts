import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginPendingProjectAdd, clearPendingProjectAdd, observePendingProjectAdd,
  readPendingProjectAdd, updatePendingProjectAdd, type PendingProjectAdd,
} from "./pendingProjectAdd";

const record: PendingProjectAdd = { id: "operation-1", path: "/alias", canonicalPath: "/notes", name: null, state: "pending" };
beforeEach(() => localStorage.clear());
describe("host-specific project add journal", () => {
  it("durably blocks a second submission on the same host but not another host", () => {
    expect(beginPendingProjectAdd("a", record)).toBe(true);
    expect(beginPendingProjectAdd("a", { ...record, id: "operation-2" })).toBe(false);
    expect(beginPendingProjectAdd("b", { ...record, id: "operation-2" })).toBe(true);
    expect(readPendingProjectAdd("a")).toEqual(record);
    expect(readPendingProjectAdd("b")?.id).toBe("operation-2");
  });
  it("does not overwrite or clear a newer operation with an old response", () => {
    beginPendingProjectAdd("a", record);
    updatePendingProjectAdd("a", { ...record, id: "old", canonicalPath: "/wrong" });
    clearPendingProjectAdd("a", "old");
    expect(readPendingProjectAdd("a")).toEqual(record);
    clearPendingProjectAdd("a", record.id);
    expect(readPendingProjectAdd("a")).toBeNull();
  });
  it("fails closed on corrupt records rather than treating them as no pending write", () => {
    localStorage.setItem("agentport-mobile-v2:pending-project-add:a", "{broken");
    expect(() => readPendingProjectAdd("a")).toThrow();
    expect(() => beginPendingProjectAdd("a", record)).toThrow();
    localStorage.setItem("agentport-mobile-v2:pending-project-add:a", JSON.stringify({ ...record, state: "confirmed" }));
    expect(() => readPendingProjectAdd("a")).toThrow();
  });
  it("notifies same-host fresh dialogs about late receipts and removes observers on cleanup", () => {
    const observer = vi.fn(), other = vi.fn();
    const stop = observePendingProjectAdd("a", observer), stopOther = observePendingProjectAdd("b", other);
    beginPendingProjectAdd("a", record);
    updatePendingProjectAdd("a", { ...record, state: "confirmed", result: { project: { id: "p", name: "Notes", rootPath: "/notes", pinned: false, sortOrder: 0 }, focusedExisting: false } });
    expect(observer).toHaveBeenCalledTimes(2); expect(other).not.toHaveBeenCalled();
    stop(); stopOther(); clearPendingProjectAdd("a", record.id);
    expect(observer).toHaveBeenCalledTimes(2);
  });
});
