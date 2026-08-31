// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import {
  emptyRuntime,
  getState,
  patchRuntime,
  setState,
  useStore,
} from "./store";

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

it("reuses the aggregate suspension index for unrelated runtime patches", () => {
  setState({
    runtime: {
      active: { ...emptyRuntime(), suspended: false },
      suspended: { ...emptyRuntime(), suspended: true },
    },
  });

  const initial = getState().suspendedSessionIds;
  expect([...initial]).toEqual(["suspended"]);

  patchRuntime("active", { logBytes: 42 });
  expect(getState().suspendedSessionIds).toBe(initial);

  patchRuntime("active", { suspended: true });
  const promoted = getState().suspendedSessionIds;
  expect(promoted).not.toBe(initial);
  expect([...promoted].sort()).toEqual(["active", "suspended"]);

  patchRuntime("active", { logBytes: 43, suspended: true });
  expect(getState().suspendedSessionIds).toBe(promoted);

  patchRuntime("suspended", { suspended: false });
  expect([...getState().suspendedSessionIds]).toEqual(["active"]);
});
