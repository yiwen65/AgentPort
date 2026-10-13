import { afterEach, describe, expect, it, vi } from "vitest";
import { reduceStaticSvgStyles } from "./markdownSvg";

function fixture(css: string, paths = 1): Document {
  return new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg"><style>${css}</style>${'<path d="M0 0"/>'.repeat(paths)}</svg>`, "image/svg+xml");
}
afterEach(() => vi.restoreAllMocks());

describe("static SVG style work quotas", () => {
  it("deduplicates repeated properties before matching many nodes, preserving last valid value", () => {
    const xml = fixture(`path{${"fill:red;".repeat(127)}fill:blue}`, 10_000);
    const writes = vi.spyOn(Element.prototype, "setAttribute");
    const query = vi.spyOn(xml, "querySelectorAll");
    reduceStaticSvgStyles(xml);
    expect(writes).toHaveBeenCalledTimes(10_000);
    expect(writes.mock.calls.every(([name, value]) => name === "fill" && value === "blue")).toBe(true);
    expect(query.mock.calls.filter(([selector]) => selector === "path")).toHaveLength(1);
    expect(xml.querySelector("style")).toBeNull();
  });

  it("rejects duplicate declaration amplification before target queries or attribute mutation", () => {
    const xml = fixture(`path{${"fill:red;".repeat(129)}}`, 10_000);
    const writes = vi.spyOn(Element.prototype, "setAttribute");
    const query = vi.spyOn(xml, "querySelectorAll");
    expect(() => reduceStaticSvgStyles(xml)).toThrow("declaration count limit");
    expect(query).not.toHaveBeenCalledWith("path");
    expect(writes).not.toHaveBeenCalled();
    expect(xml.querySelector("style")).not.toBeNull();
  });

  it("counts declarations globally, including duplicates and unsupported values", () => {
    const xml = fixture(`path{${"unsupported:bad;".repeat(128)}}`.repeat(160));
    const writes = vi.spyOn(Element.prototype, "setAttribute");
    expect(() => reduceStaticSvgStyles(xml)).toThrow("total declaration limit");
    expect(writes).not.toHaveBeenCalled();
  });

  it("rejects prospective total nodes × unique properties before applying even earlier valid rules", () => {
    const properties = "fill:red;stroke:red;color:red;fill-opacity:1;fill-rule:nonzero;stroke-width:1;stroke-opacity:1;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;opacity:1;stop-color:red;stop-opacity:1;clip-path:url(#c);clip-rule:nonzero;font-size:12px;font-family:Arial;font-weight:bold;font-style:normal;text-anchor:start;dominant-baseline:middle";
    const xml = fixture(`path{fill:blue}path{${properties}}`, 10_000);
    const writes = vi.spyOn(Element.prototype, "setAttribute");
    expect(() => reduceStaticSvgStyles(xml)).toThrow("application limit");
    expect(writes).not.toHaveBeenCalled();
    expect(xml.querySelector("path")?.hasAttribute("fill")).toBe(false);
  });

  it("bounds combinator complexity before querySelector work, allowing eight combinators", () => {
    const excessive = Array(10).fill("g").join(" > ");
    const xml = fixture(`${excessive}{fill:red}`);
    const query = vi.spyOn(xml, "querySelectorAll");
    expect(() => reduceStaticSvgStyles(xml)).toThrow("selector complexity limit");
    expect(query).not.toHaveBeenCalledWith(excessive);
    expect(() => reduceStaticSvgStyles(fixture(`${Array(9).fill("g").join(" > ")}{fill:red}`))).not.toThrow();
  });

  it("handles long unterminated rule/comment text with linear delimiter scans", () => {
    const writes = vi.spyOn(Element.prototype, "setAttribute");
    for (const css of ["x".repeat(1_000_000), "/*".repeat(500_000)]) {
      const xml = fixture(css);
      expect(() => reduceStaticSvgStyles(xml)).not.toThrow();
      expect(xml.querySelector("style")).toBeNull();
    }
    expect(writes).not.toHaveBeenCalled();
  });

  it("keeps stylesheet specificity and inline last-wins semantics", () => {
    const xml = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg"><style>.bright{fill:white}path{fill:black}</style><path class="bright" style="fill:red;fill:blue;fill:url(https://evil)"/></svg>', "image/svg+xml");
    reduceStaticSvgStyles(xml);
    expect(xml.querySelector("path")?.getAttribute("fill")).toBe("blue");
    expect(xml.querySelector("path")?.hasAttribute("style")).toBe(false);
  });
});
