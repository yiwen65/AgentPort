import { describe, expect, it } from "vitest";
import { createTaskDeepLink, parseTaskDeepLink } from "./taskDeepLinks";

describe("task deep links", () => {
  it("parses native query links and preserves device/repository identity", () => {
    expect(parseTaskDeepLink("agentport://tasks?profileId=host-1&provider=gitlab&projectId=project%2F42&scope=pulls&itemId=17")).toEqual({
      profileId: "host-1", provider: "gitlab", projectId: "project/42", scope: "pulls", itemId: "17",
    });
  });

  it("parses browser path links and creates a shareable native link", () => {
    const parsed = parseTaskDeepLink("https://agentport.app/tasks/github/project-1/issues/9");
    expect(parsed).toEqual({ provider: "github", projectId: "project-1", scope: "issues", itemId: "9" });
    expect(createTaskDeepLink(parsed!)).toBe("agentport://tasks?provider=github&projectId=project-1&scope=issues&itemId=9");
  });

  it("rejects unsupported providers and scopes", () => {
    expect(parseTaskDeepLink("agentport://tasks?provider=linear&projectId=p&scope=issues")).toBeUndefined();
    expect(parseTaskDeepLink("agentport://tasks?provider=github&projectId=p&scope=boards")).toBeUndefined();
  });
});
