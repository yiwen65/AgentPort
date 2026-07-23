import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("keeps HTML5 drag and drop enabled for terminal file references", () => {
  const config = JSON.parse(
    readFileSync(resolve(process.cwd(), "../src-tauri/tauri.conf.json"), "utf8"),
  );

  expect(config.app.windows[0].dragDropEnabled).toBe(false);
});
