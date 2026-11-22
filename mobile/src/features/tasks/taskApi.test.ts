import { describe, expect, it, vi } from "vitest";
import type { RemoteClient } from "../../protocol/remoteClient";
import { MOBILE_TASK_READ_METHODS, readTaskDetail, readTaskList, taskDetail, taskSummary } from "./taskApi";

function client(response: unknown): RemoteClient {
  return {
    listHostProfiles: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), subscribe: vi.fn(), onConnectionState: vi.fn(),
    request: vi.fn().mockResolvedValue(response),
  };
}

describe("mobile task read adapter", () => {
  it("uses only the read list method and preserves the provider envelope", async () => {
    const remote = client({ provider: "github", scope: "issues", repository: { owner: "acme", name: "app" }, items: [{ number: 7, title: "Fix login", state: "open", labels: [{ name: "bug" }] }], error: null });
    const response = await readTaskList(remote, "host-1", { provider: "github", projectId: "project-1", scope: "issues" });
    expect(remote.request).toHaveBeenCalledWith("host-1", "task.list", { provider: "github", projectId: "project-1", scope: "issues" }, undefined);
    expect(response.items).toHaveLength(1);
    expect(taskSummary(response.items[0])).toMatchObject({ id: "7", number: 7, title: "Fix login", labels: ["bug"] });
    expect(MOBILE_TASK_READ_METHODS).toEqual(["task.list", "task.detail"]);
    expect(MOBILE_TASK_READ_METHODS.some(method => /write|update|merge|comment|mutation/i.test(method))).toBe(false);
  });

  it("reads provider-shaped details without exposing mutation fields", async () => {
    const remote = client({ provider: "gitlab", scope: "pulls", repository: { projectPath: "group/app" }, item: {
      iid: 12, title: "Review API", state: "opened", description: "Details", assignees: [{ username: "sam" }], notes: [{ id: 1, body: "Looks good", author: { username: "lee" } }],
    }, error: null });
    const response = await readTaskDetail(remote, "host-1", { provider: "gitlab", projectId: "project-1", scope: "pulls", itemId: "12" });
    expect(remote.request).toHaveBeenCalledWith("host-1", "task.detail", { provider: "gitlab", projectId: "project-1", scope: "pulls", itemId: "12" }, undefined);
    expect(taskDetail(response.item)).toMatchObject({ id: "12", title: "Review API", body: "Details", assignees: ["sam"] });
    expect(taskDetail(response.item).comments[0]).toMatchObject({ body: "Looks good", author: "lee" });
  });

  it("rejects an envelope for a different provider", async () => {
    await expect(readTaskList(client({ provider: "gitlab", scope: "issues", items: [], error: null }), "host-1", { provider: "github", projectId: "project-1", scope: "issues" })).rejects.toMatchObject({ code: "invalid_response" });
  });
});
