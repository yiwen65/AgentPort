// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../i18n";
import type { UpdateSnapshot } from "../api";
import UpdateSection from "./UpdateSection";

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
    throw new Error(`Unexpected command ${command}`);
  });
});

afterEach(cleanup);

it("shows the running version and reports an idle state", async () => {
  render(<UpdateSection />);
  expect(await screen.findByText("AgentPort 1.2.0")).toBeTruthy();
  expect(screen.getByText("Updates are checked when AgentPort starts.")).toBeTruthy();
});

it("checks and downloads on demand, then points at the consent prompt", async () => {
  render(<UpdateSection />);
  await screen.findByText("AgentPort 1.2.0");

  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("update_check"));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("update_download"));

  act(() => emit?.(snapshot("ready", { version: "1.3.0", downloaded: 1024, total: 2048 })));
  expect(
    screen.getByText("AgentPort 1.3.0 is downloaded. Use “Quit and update” in the prompt at the bottom left."),
  ).toBeTruthy();
});

it("keeps the button inert while an update is disabled or in flight", async () => {
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "update_status") return snapshot("disabled", { currentVersion: "1.2.0" });
    throw new Error(`Unexpected command ${command}`);
  });
  render(<UpdateSection />);
  expect(
    await screen.findByText("This build never checks for updates (development build or updates disabled)."),
  ).toBeTruthy();
  expect((screen.getByRole("button", { name: "Check for updates" }) as HTMLButtonElement).disabled).toBe(true);
});

it("surfaces a failed check", async () => {
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "update_status") return snapshot("idle");
    if (command === "update_check") throw new Error("offline");
    throw new Error(`Unexpected command ${command}`);
  });
  render(<UpdateSection />);
  await screen.findByText("AgentPort 1.2.0");
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
});
