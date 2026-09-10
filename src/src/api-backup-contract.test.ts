import { expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn().mockResolvedValue({}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
import { api } from "./api";

it("passes an agent to both backup commands, never a replacement data root", async () => {
  await api.backupCreate("easy_pi", null);
  await api.backupRestore("/tmp/legacy.zip", "claude");
  expect(invokeMock).toHaveBeenNthCalledWith(1, "backup_create", { agent: "easy_pi", dest: null });
  expect(invokeMock).toHaveBeenNthCalledWith(2, "backup_restore", { path: "/tmp/legacy.zip", agent: "claude" });
});
