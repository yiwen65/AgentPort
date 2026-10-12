import { beforeEach, expect, it, vi } from "vitest";
import { TauriGenericTerminalClient } from "./tauriGenericTerminalClient";
const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockClear());
it("uses the fixed native IPC contract without sending credentials or remote commands", async () => {
  const client = new TauriGenericTerminalClient();
  await client.list("profile"); await client.create({ profileId: "profile", name: "Name" });
  await client.connect({ terminalId: "record", transport: "mosh", cols: 80, rows: 24 });
  await client.input({ connectionId: "connection", data: "ls\r" });
  await client.resize({ connectionId: "connection", cols: 90, rows: 30 });
  await client.poll("connection"); await client.disconnect("connection"); await client.end("record");
  expect(invoke.mock.calls).toEqual([
    ["mobile_terminal_list", { profileId: "profile" }],
    ["mobile_terminal_create", { request: { profileId: "profile", name: "Name" } }],
    ["mobile_terminal_connect", { request: { terminalId: "record", transport: "mosh", cols: 80, rows: 24 } }],
    ["mobile_terminal_input", { request: { connectionId: "connection", data: "ls\r" } }],
    ["mobile_terminal_resize", { request: { connectionId: "connection", cols: 90, rows: 30 } }],
    ["mobile_terminal_poll", { connectionId: "connection" }],
    ["mobile_terminal_disconnect", { connectionId: "connection" }],
    ["mobile_terminal_end", { terminalId: "record" }],
  ]);
});
