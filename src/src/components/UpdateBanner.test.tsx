// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../i18n";
import type { UpdateSnapshot } from "../api";
import UpdateBanner from "./UpdateBanner";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

let emit: ((snapshot: UpdateSnapshot) => void) | undefined;

function snapshot(phase: UpdateSnapshot["phase"], extra: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    phase,
    currentVersion: "1.2.0",
    version: null,
    notes: null,
    date: null,
    downloaded: 0,
    total: null,
    error: null,
    liveSessions: 0,
    ...extra,
  };
}

beforeEach(async () => {
  vi.resetAllMocks();
  emit = undefined;
  await i18n.changeLanguage("en-US");
  mocks.listen.mockImplementation(async (_event: string, cb: (event: { payload: UpdateSnapshot }) => void) => {
    emit = (next) => cb({ payload: next });
    return () => undefined;
  });
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "update_status") return snapshot("idle");
    if (command === "update_check") return snapshot("available", { version: "1.3.0" });
    if (command === "update_download") return snapshot("ready", { version: "1.3.0" });
    if (command === "update_install") return undefined;
    throw new Error(`Unexpected command ${command}`);
  });
});

afterEach(cleanup);

async function mounted() {
  render(<UpdateBanner />);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("update_status"));
}

it("stays silent while idle, checking, or up to date", async () => {
  await mounted();
  act(() => emit?.(snapshot("checking")));
  expect(screen.queryByRole("status")).toBeNull();
  act(() => emit?.(snapshot("upToDate")));
  expect(screen.queryByRole("status")).toBeNull();
});

it("asks for consent before installing and warns about running sessions", async () => {
  await mounted();
  act(() => emit?.(snapshot("ready", { version: "1.3.0", liveSessions: 2 })));
  expect(screen.getByText("AgentPort 1.3.0 is ready to install")).toBeTruthy();
  expect(
    screen.getByText("Installing stops 2 running session(s); you can restart them afterwards."),
  ).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Quit and update" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("update_install"));
});

it("reports download progress without inventing a percentage", async () => {
  await mounted();
  act(() => emit?.(snapshot("downloading", { version: "1.3.0" })));
  expect(screen.getByText("Downloading AgentPort 1.3.0…")).toBeTruthy();

  act(() =>
    emit?.(
      snapshot("downloading", {
        version: "1.3.0",
        downloaded: 512 * 1024,
        total: 2 * 1024 * 1024,
      }),
    ),
  );
  expect(screen.getByText("Downloading AgentPort 1.3.0… 25% (512 KiB)")).toBeTruthy();
});

it("retries a failed update through the Rust flow", async () => {
  await mounted();
  act(() => emit?.(snapshot("error", { version: "1.3.0", error: "network unreachable" })));
  expect(screen.getByText("Update failed: network unreachable")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("update_check"));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("update_download"));
});

it("lets the user postpone the update until the next release", async () => {
  await mounted();
  act(() => emit?.(snapshot("ready", { version: "1.3.0", liveSessions: 0 })));
  fireEvent.click(screen.getByRole("button", { name: "Later" }));
  expect(screen.queryByRole("status")).toBeNull();

  // Re-emitted progress for the postponed version stays hidden…
  act(() => emit?.(snapshot("ready", { version: "1.3.0", liveSessions: 1 })));
  expect(screen.queryByRole("status")).toBeNull();

  // …while a newer release gets its own prompt.
  act(() => emit?.(snapshot("ready", { version: "1.4.0", liveSessions: 1 })));
  expect(screen.getByText("AgentPort 1.4.0 is ready to install")).toBeTruthy();
});

it("ignores a failed probe that never announced a release", async () => {
  await mounted();
  act(() => emit?.(snapshot("error", { error: "network unreachable" })));
  expect(screen.queryByRole("status")).toBeNull();
});

it("ignores the debug-build disabled phase entirely", async () => {
  mocks.invoke.mockResolvedValue(snapshot("disabled"));
  await mounted();
  expect(screen.queryByRole("status")).toBeNull();
});
