export type TerminalTransport = "ssh" | "mosh";
export type TerminalMode = "shell" | "tmux";
export interface TerminalRecord {
  id: string;
  profileId: string;
  name: string;
  /** Missing only in legacy records, which always used tmux. */
  mode?: TerminalMode;
  tmuxSession: string;
  createdAt: string;
}
export interface GenericTerminalError {
  code?: string;
  message?: string;
  fingerprint?: string;
  hostKeyHop?: "direct" | "target" | "jump";
}
export function getTerminalMode(record: TerminalRecord): TerminalMode { return record.mode ?? "tmux"; }

/** Credentials and remote tmux identifiers are resolved exclusively by native code. */
export interface GenericTerminalClient {
  list(profileId: string): Promise<TerminalRecord[]>;
  create(request: { profileId: string; name: string; mode?: TerminalMode }): Promise<TerminalRecord>;
  connect(request: { terminalId: string; transport: TerminalTransport; cols: number; rows: number }): Promise<{ connectionId: string }>;
  input(request: { connectionId: string; data: string }): Promise<void>;
  resize(request: { connectionId: string; cols: number; rows: number }): Promise<void>;
  poll(connectionId: string): Promise<{ data: number[]; running: boolean }>;
  disconnect(connectionId: string): Promise<void>;
  end(terminalId: string): Promise<void>;
}
