// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../i18n";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import DevicePicker from "./DevicePicker";
import {
  registerDeviceSwitchHandler,
  resetDevicesStoreForTests,
  setDevicesInvokerForTests,
} from "../devicesStore";
import { getState, setActiveDevice } from "../store";

const devices = [
  {
    id: "dev_ssh",
    name: "Linux box",
    transport: "ssh",
    hostname: "192.168.1.10",
    port: 22,
    username: "dev",
    lastConnectedAt: "2026-09-23T09:30:00Z",
    lastError: null,
  },
  {
    id: "dev_relay",
    name: "Office PC",
    transport: "relay",
    peer: { relayUrl: "wss://relay.example/v1/relay", publicKey: "pk", hostId: "host-1" },
    lastConnectedAt: null,
    lastError: "auth_failed: nope",
  },
];

beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en-US");
  resetDevicesStoreForTests();
  registerDeviceSwitchHandler(null);
  setActiveDevice({ kind: "local" });
  setDevicesInvokerForTests(undefined);
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "device_list") return structuredClone(devices);
    throw new Error(`Unexpected command ${command}`);
  });
});

afterEach(cleanup);

async function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Device switcher" }));
  await screen.findByText("Linux box");
}

it("shows the active device name and lists devices on open", async () => {
  render(<DevicePicker />);
  expect(
    screen.getByRole("button", { name: "Device switcher" }).textContent,
  ).toContain("This computer");
  expect(mocks.invoke).not.toHaveBeenCalled();
  await openMenu();
  expect(mocks.invoke).toHaveBeenCalledWith("device_list", undefined);
  expect(screen.getByText("Office PC")).toBeTruthy();
  expect(screen.getByText("dev@192.168.1.10")).toBeTruthy();
  expect(screen.getByText("host-1 · wss://relay.example/v1/relay")).toBeTruthy();
});

it("selecting a device invokes the injected switch handler with a remote context", async () => {
  const onSwitchDevice = vi.fn();
  render(<DevicePicker onSwitchDevice={onSwitchDevice} />);
  await openMenu();
  fireEvent.click(screen.getByText("Linux box"));
  expect(onSwitchDevice).toHaveBeenCalledWith({
    kind: "remote",
    deviceId: "dev_ssh",
    deviceName: "Linux box",
    capabilities: [],
  });
});

it("the local row is disabled while local and switchable from a remote device", async () => {
  const onSwitchDevice = vi.fn();
  setActiveDevice({
    kind: "remote",
    deviceId: "dev_ssh",
    deviceName: "Linux box",
    capabilities: [],
  });
  render(<DevicePicker onSwitchDevice={onSwitchDevice} />);
  await openMenu();
  const menu = screen.getByRole("menu");
  const localRow = within(menu).getByText("This computer").closest("button")!;
  const remoteRow = within(menu).getByText("Linux box").closest("button")!;
  expect(localRow.disabled).toBe(false);
  expect(remoteRow.disabled).toBe(true);
  fireEvent.click(localRow);
  expect(onSwitchDevice).toHaveBeenCalledWith({ kind: "local" });
});

it("surfaces switch failures through the default handler", async () => {
  registerDeviceSwitchHandler(() => {
    throw { code: "connect_failed", message: "no route to host" };
  });
  render(<DevicePicker />);
  await openMenu();
  fireEvent.click(screen.getByText("Office PC"));
  await screen.findByText(/Switch failed: no route to host/);
});

it("shows the empty state when no devices are paired", async () => {
  mocks.invoke.mockImplementation(async () => []);
  render(<DevicePicker />);
  fireEvent.click(screen.getByRole("button", { name: "Device switcher" }));
  await screen.findByText("No paired computers yet");
});

it("opens the add-device dialog at the app layer and the settings dialog from footer actions", async () => {
  render(<DevicePicker />);
  await openMenu();
  fireEvent.click(screen.getByText("Add device…"));
  // The PairDevice modal mounts through the app dialog router (never inside
  // the topbar's stacking trap), so the picker only records dialog state.
  expect(getState().dialog).toEqual({ kind: "pairDevice" });
  act(() => setActiveDevice({ kind: "local" }));
  fireEvent.click(screen.getByRole("button", { name: "Device switcher" }));
  fireEvent.click(await screen.findByText("Manage devices…"));
  expect(getState().dialog).toEqual({ kind: "settings" });
  act(() => setActiveDevice({ kind: "local" }));
});

it("portals the menu to document.body, outside the topbar stacking context", async () => {
  render(<DevicePicker />);
  await openMenu();
  const menu = screen.getByRole("menu");
  // Regression for click-through: inside .topbar (isolation + z-index) the
  // menu shared the bar's stacking slot and higher-z pane chrome swallowed
  // clicks. The menu must live at body level (fixed, ctx-menu z-layer).
  expect(menu.closest(".topbar")).toBeNull();
  expect(menu.parentElement).toBe(document.body);
  // Outside-click still closes the portaled menu.
  fireEvent.pointerDown(document.body);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});

it("tracks switching state in the trigger label", async () => {
  let release!: () => void;
  registerDeviceSwitchHandler(() => new Promise<void>((resolve) => { release = resolve; }));
  render(<DevicePicker />);
  await openMenu();
  fireEvent.click(screen.getByText("Linux box"));
  await screen.findByText("Switching…");
  release();
  await waitFor(() => expect(screen.queryByText("Switching…")).toBeNull());
});
