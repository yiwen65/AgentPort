import commonEnUS from "./en-US/common.json";
import runtimeEnUS from "./en-US/runtime.json";
import sessionEnUS from "./en-US/session.json";
import settingsEnUS from "./en-US/settings.json";
import shellEnUS from "./en-US/shell.json";
import worktreeEnUS from "./en-US/worktree.json";
import shellExtraEnUS from "./fragments/en-US/shell-extra.json";
import shellExtraZhCN from "./fragments/zh-CN/shell-extra.json";
import sessionExtraEnUS from "./fragments/en-US/session-extra.json";
import sessionExtraZhCN from "./fragments/zh-CN/session-extra.json";
import worktreeExtraEnUS from "./fragments/en-US/worktree-extra.json";
import worktreeExtraZhCN from "./fragments/zh-CN/worktree-extra.json";
import runtimeExtraEnUS from "./fragments/en-US/runtime-extra.json";
import runtimeExtraZhCN from "./fragments/zh-CN/runtime-extra.json";
import sessionUiEnUS from "./fragments/en-US/session-ui.json";
import sessionUiZhCN from "./fragments/zh-CN/session-ui.json";
import settingsUiEnUS from "./fragments/en-US/settings-ui.json";
import settingsUiZhCN from "./fragments/zh-CN/settings-ui.json";
import shellUiEnUS from "./fragments/en-US/shell-ui.json";
import shellUiZhCN from "./fragments/zh-CN/shell-ui.json";
import worktreeUiEnUS from "./fragments/en-US/worktree-ui.json";
import worktreeUiZhCN from "./fragments/zh-CN/worktree-ui.json";
import commonZhCN from "./zh-CN/common.json";
import runtimeZhCN from "./zh-CN/runtime.json";
import sessionZhCN from "./zh-CN/session.json";
import settingsZhCN from "./zh-CN/settings.json";
import shellZhCN from "./zh-CN/shell.json";
import worktreeZhCN from "./zh-CN/worktree.json";

export const namespaces = ["common", "shell", "session", "worktree", "settings", "runtime"] as const;

export const resources = {
  "zh-CN": {
    common: commonZhCN,
    shell: { ...shellZhCN, ...shellExtraZhCN, ...shellUiZhCN },
    session: { ...sessionZhCN, ...sessionExtraZhCN, ...sessionUiZhCN },
    worktree: { ...worktreeZhCN, ...worktreeExtraZhCN, ...worktreeUiZhCN },
    settings: { ...settingsZhCN, ...settingsUiZhCN },
    runtime: { ...runtimeZhCN, ...runtimeExtraZhCN },
  },
  "en-US": {
    common: commonEnUS,
    shell: { ...shellEnUS, ...shellExtraEnUS, ...shellUiEnUS },
    session: { ...sessionEnUS, ...sessionExtraEnUS, ...sessionUiEnUS },
    worktree: { ...worktreeEnUS, ...worktreeExtraEnUS, ...worktreeUiEnUS },
    settings: { ...settingsEnUS, ...settingsUiEnUS },
    runtime: { ...runtimeEnUS, ...runtimeExtraEnUS },
  },
} as const;
