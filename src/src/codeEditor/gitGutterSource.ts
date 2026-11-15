// Loads unstaged git line marks for one document. The document panel pins
// reads to a captured device while git commands route to the active device,
// so gutters only appear when both point at the same machine.

import { api } from "../api";
import { deviceKeyForContext } from "../sessionIdentity";
import { getState } from "../store";
import { locatorForExplorerRoot } from "../docTreeGit";
import type { DeviceContext } from "../deviceContext";
import { parseGitPatch, type GitLineMark } from "./gitPatch";

export async function fetchGitLineMarks(input: {
  path: string;
  rootPath?: string | null;
  device?: DeviceContext;
}): Promise<GitLineMark[]> {
  try {
    const state = getState();
    if (
      input.device &&
      deviceKeyForContext(input.device) !== deviceKeyForContext(state.activeDevice)
    ) {
      return [];
    }
    const locator = locatorForExplorerRoot(input.rootPath ?? input.path, state);
    if (!locator) return [];
    const snapshot = await api.getGitChanges(locator, false);
    if (!snapshot.complete) return [];
    const root = snapshot.context.checkoutRoot.replace(/\/+$/, "");
    const target = input.path.replace(/\/+$/, "");
    const entry = snapshot.entries.find((candidate) => {
      if (candidate.kind === "ignored" || candidate.displayPath.endsWith("/")) return false;
      return `${root}/${candidate.displayPath.replace(/^\.\//, "")}` === target;
    });
    if (!entry) return [];
    if (!(entry.unstaged || entry.untracked || entry.conflicted)) return [];
    const diff = await api.getGitDiff(
      locator,
      snapshot.statusToken,
      "unstaged",
      entry.pathToken,
    );
    if (diff.format !== "text" || !diff.patch) return [];
    return parseGitPatch(diff.patch);
  } catch {
    return [];
  }
}
