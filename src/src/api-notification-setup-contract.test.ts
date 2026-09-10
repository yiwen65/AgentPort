import { beforeEach, describe, expect, it, vi } from "vitest";
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock, Channel: class {} }));
import { api } from "./api";

beforeEach(() => { vi.clearAllMocks(); invokeMock.mockResolvedValue([]); });
describe("Notification setup Tauri contract", () => {
  it("reads status without initiating a probe or installation", async () => {
    await api.notificationSetups();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("notification_setups");
  });
  it("rolls back only the explicitly selected Agent", async () => {
    await api.rollbackNotificationSetup("easy_pi");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("rollback_notification_setup", { agent: "easy_pi" });
  });
});
