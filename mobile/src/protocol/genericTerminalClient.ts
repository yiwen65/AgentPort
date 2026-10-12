export type TerminalTransport = "ssh" | "mosh";
export interface TerminalRecord {
  id: string;
  profileId: string;
  name: string;
  tmuxSession: string;
  createdAt: string;
}
export interface GenericTerminalError {
  code?: string;
  message?: string;
  fingerprint?: string;
  hostKeyHop?: "direct" | "target" | "jump";
}
/** Credentials and remote tmux identifiers are resolved exclusively by native code. */
export interface GenericTerminalClient {
  list(profileId: string): Promise<TerminalRecord[]>;
  create(request: { profileId: string; name: string }): Promise<TerminalRecord>;
  connect(request: { terminalId: string; transport: TerminalTransport; cols: number; rows: number }): Promise<{ connectionId: string }>;
  input(request: { connectionId: string; data: string }): Promise<void>;
  resize(request: { connectionId: string; cols: number; rows: number }): Promise<void>;
  poll(connectionId: string): Promise<{ data: number[]; running: boolean }>;
  disconnect(connectionId: string): Promise<void>;
  end(terminalId: string): Promise<void>;
}
