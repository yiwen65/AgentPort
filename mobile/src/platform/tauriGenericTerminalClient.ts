import { invoke } from "@tauri-apps/api/core";
import type { GenericTerminalClient, TerminalRecord } from "../protocol/genericTerminalClient";

export class TauriGenericTerminalClient implements GenericTerminalClient {
  list(profileId: string): Promise<TerminalRecord[]> { return invoke("mobile_terminal_list", { profileId }); }
  create(request: Parameters<GenericTerminalClient["create"]>[0]): Promise<TerminalRecord> { return invoke("mobile_terminal_create", { request }); }
  connect(request: Parameters<GenericTerminalClient["connect"]>[0]): Promise<{ connectionId: string }> { return invoke("mobile_terminal_connect", { request }); }
  input(request: Parameters<GenericTerminalClient["input"]>[0]): Promise<void> { return invoke("mobile_terminal_input", { request }); }
  resize(request: Parameters<GenericTerminalClient["resize"]>[0]): Promise<void> { return invoke("mobile_terminal_resize", { request }); }
  poll(connectionId: string): ReturnType<GenericTerminalClient["poll"]> { return invoke("mobile_terminal_poll", { connectionId }); }
  disconnect(connectionId: string): Promise<void> { return invoke("mobile_terminal_disconnect", { connectionId }); }
  end(terminalId: string): Promise<void> { return invoke("mobile_terminal_end", { terminalId }); }
}
export const genericTerminalClient: GenericTerminalClient = new TauriGenericTerminalClient();
