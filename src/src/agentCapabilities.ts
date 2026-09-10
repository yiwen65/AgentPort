import type { AdapterInstall, PermissionStr } from "./types";

export const ADDED_AGENT_IDS = [
  "omp", "opencode", "amp", "gemini", "cline", "kiro_cli", "cursor_agent", "easy_pi", "grok_build",
] as const;

export function isAddedAgent(agent: string): boolean {
  return (ADDED_AGENT_IDS as readonly string[]).includes(agent);
}

/** Keep legacy shortcuts unchanged; newly supported tools never imply bypass. */
export function quickStartPermission(agent: string): PermissionStr {
  return agent === "shell" || agent === "pi" || isAddedAgent(agent) ? "native" : "bypass";
}

/** Only verified adapter flags may expose non-native modes for the new tools. */
export function availablePermissionModes(agent: string, install?: AdapterInstall): PermissionStr[] {
  if (agent === "shell" || agent === "pi" || install?.approvalModel === "no_builtin_prompts") {
    return ["native"];
  }
  if (!isAddedAgent(agent)) return ["native", "auto", "bypass"];
  // Mirror the verified permission_args contracts in extended.rs and
  // pi_family.rs. A similarly named flag in another CLI is not evidence.
  const permissionFlag: Record<string, string> = {
    omp: "approval-mode",
    opencode: "auto",
    gemini: "approval-mode",
    cline: "auto-approve",
    kiro_cli: "trust-all-tools",
    cursor_agent: "force",
    grok_build: "permission-mode",
  };
  const flag = permissionFlag[agent];
  if (!flag || !install?.flags.includes(flag)) return ["native"];
  return agent === "opencode" ? ["native", "auto"] : ["native", "auto", "bypass"];
}
