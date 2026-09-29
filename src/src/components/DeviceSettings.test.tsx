// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../i18n";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import DeviceSettings from "./DeviceSettings";
import { resetDevicesStoreForTests, setDevicesInvokerForTests } from "../devicesStore";
import { getState } from "../store";

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
    lastError: "connect_failed: timeout",
  },
];

beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en-US");
  resetDevicesStoreForTests();
  setDevicesInvokerForTests(undefined);
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "device_list") return structuredClone(devices);
    throw new Error(`Unexpected command ${command}`);
  });
});

afterEach(cleanup);

async function loaded() {
  await screen.findByText("Linux box");
}

it("lists devices with transport, target, and last-connected info", async () => {
  render(<DeviceSettings />);
  await loaded();
  expect(screen.getByText("Office PC")).toBeTruthy();
  expect(screen.getByText("dev@192.168.1.10")).toBeTruthy();
  expect(screen.getByText("Last connection failed")).toBeTruthy();
  expect(mocks.invoke).toHaveBeenCalledWith("device_list", undefined);
});

it("renames a device inline", async () => {
  render(<DeviceSettings />);
  await loaded();
  const renameButtons = screen.getAllByRole("button", { name: "Rename" });
  fireEvent.click(renameButtons[0]);
  const input = screen.getByLabelText("Device name");
  fireEvent.change(input, { target: { value: "Renamed box" } });
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "device_list") return structuredClone(devices);
    if (command === "device_rename") return undefined;
    throw new Error(`Unexpected command ${command}`);
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("device_rename", {
      deviceId: "dev_ssh",
      name: "Renamed box",
    }),
  );
  await screen.findByText("Renamed box");
});

it("delete requires confirmation and threads the credential cascade", async () => {
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "device_list") return structuredClone(devices);
    if (command === "device_remove") return undefined;
    throw new Error(`Unexpected command ${command}`);
  });
  render(<DeviceSettings />);
  await loaded();
  const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
  fireEvent.click(deleteButtons[1]);
  const confirm = screen.getByRole("alert");
  expect(
    within(confirm).getByText(/Remove Office PC\? Running sessions on that device are not stopped\./),
  ).toBeTruthy();
  expect(mocks.invoke).not.toHaveBeenCalledWith(
    "device_remove",
    expect.anything(),
  );
  fireEvent.click(within(confirm).getByLabelText("Also delete saved credentials"));
  fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("device_remove", {
      deviceId: "dev_relay",
      deleteCredentials: false,
    }),
  );
  await waitFor(() => expect(screen.queryByText("Office PC")).toBeNull());
});

it("test-connect reports latency on success and structured errors on failure", async () => {
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "device_list") return structuredClone(devices);
    if (command === "remote_connect") {
      return { deviceName: "Linux box", capabilities: [], protocolVersion: { major: 1, minor: 1 } };
    }
    if (command === "remote_disconnect") return undefined;
    throw new Error(`Unexpected command ${command}`);
  });
  render(<DeviceSettings />);
  await loaded();
  fireEvent.click(screen.getAllByRole("button", { name: "Test connection" })[0]);
  await screen.findByText(/OK · \d+ ms/);
  expect(mocks.invoke).toHaveBeenCalledWith("remote_disconnect", { deviceId: "dev_ssh" });

  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "device_list") return structuredClone(devices);
    if (command === "remote_connect") throw { code: "auth_failed", message: "bad credentials" };
    if (command === "remote_disconnect") return undefined;
    throw new Error(`Unexpected command ${command}`);
  });
  fireEvent.click(screen.getAllByRole("button", { name: "Test connection" })[0]);
  await screen.findByText(/Failed: bad credentials/);
});

it("opens the add-device dialog at the app layer from the section action", async () => {
  render(<DeviceSettings />);
  await loaded();
  fireEvent.click(screen.getByRole("button", { name: "Add device" }));
  // The PairDevice modal mounts through the app dialog router (never nested
  // in this section), so the section only records dialog state.
  expect(getState().dialog).toEqual({ kind: "pairDevice" });
});

it("shows the empty state when no devices exist", async () => {
  mocks.invoke.mockImplementation(async () => []);
  render(<DeviceSettings />);
  await screen.findByText("No paired computers yet.");
});
