// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { setState, useStore } from "./store";

afterEach(cleanup);

it("does not re-render a selected slice for unrelated store updates", () => {
  let renders = 0;
  function ThemeSubscriber() {
    useStore((state) => state.themeEffective);
    renders += 1;
    return null;
  }

  setState({ themeEffective: "dark", announcement: "" });
  render(<ThemeSubscriber />);
  for (let i = 0; i < 100; i += 1) {
    act(() => setState({ announcement: `tick-${i}` }));
  }

  expect(renders).toBe(1);
});
