import { describe, expect, it } from "vitest";
import { taskCacheKey, taskRepositoryKey } from "./taskTypes";

describe("task identity", () => {
  it("isolates provider, host and repository", () => {
    expect(taskRepositoryKey({ provider: "github", host: "GitHub.com", owner: "O", name: "R" }))
      .toBe("github\0github.com\0o\0r\0");
    expect(taskCacheKey({ provider: "gitlab", host: "git.example", repository: "a/b", scope: "issues", device: "dev-1" }))
      .toBe("dev-1\0gitlab\0git.example\0a/b\0issues\0");
  });
});
