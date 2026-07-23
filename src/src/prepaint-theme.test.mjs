import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { expect, it } from "vitest";

it("releases the prepaint foreground after the app theme takes over", () => {
  const indexHtml = readFileSync("index.html", "utf8");
  const prepaintCss = indexHtml.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  expect(prepaintCss).toBeTruthy();

  const dom = new JSDOM(`<!doctype html>
    <html data-theme="light" data-prepaint-theme="light">
      <head>
        <style>${prepaintCss}</style>
        <style>body { color: rgb(17, 18, 23); }</style>
      </head>
      <body><div id="root"><h1>Set up AgentPort</h1></div></body>
    </html>`);

  // Mirrors applyThemeSettings once the full theme stylesheet is active.
  dom.window.document.documentElement.removeAttribute("data-prepaint-theme");

  const heading = dom.window.document.querySelector("h1");
  expect(dom.window.getComputedStyle(heading).color).toBe("rgb(17, 18, 23)");
});
