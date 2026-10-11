import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import type { HostProfileSummary, RemoteClient } from "../../protocol/remoteClient";
import type { ProjectSummary } from "./types";
import { SessionDashboard } from "./SessionDashboard";

let dialog: {
  host: HostProfileSummary;
  onAdded: (result: { project: ProjectSummary; focusedExisting: boolean }) => Promise<void>;
  onClose: () => void;
};
vi.mock("../projects/AddProjectDialog", () => ({
  AddProjectDialog: (props: typeof dialog) => {
    dialog = props;
    return <section role="dialog" aria-label="Add project panel">{props.host.name}<button onClick={props.onClose}>Close panel</button></section>;
  },
}));

const project: ProjectSummary = { id: "existing", name: "Existing", rootPath: "/repo", pinned: false, sortOrder: 0 };
const added: ProjectSummary = { id: "added", name: "New ordinary directory", rootPath: "/work/new", pinned: false, sortOrder: 0 };
const hosts: HostProfileSummary[] = ["Studio", "Laptop"].map((name, index) => ({
  id: `host-${index + 1}`, name, hostname: "localhost", port: 22, username: "dev", preferredTransport: "ssh",
  connectionState: "connected", lastConnectedAt: null, lastError: null,
}));
function client(empty = false): RemoteClient {
  return {
    listHostProfiles: vi.fn().mockResolvedValue(hosts), connect: vi.fn(), disconnect: vi.fn(),
    request: vi.fn().mockImplementation((_id, method) => {
      if (method === "project.list") return Promise.resolve(empty ? [] : [project]);
      if (method === "session.list" || method === "agent.supported") return Promise.resolve([]);
      if (method === "agent.preferences") return Promise.resolve({ revision: 1, agentOrder: [], agentHidden: [] });
      if (method === "attention.poll") return Promise.resolve({ events: [] });
      return Promise.resolve(undefined);
    }),
    subscribe: vi.fn(), onConnectionState: vi.fn().mockResolvedValue(async () => {}),
  };
}
const open = () => fireEvent.click(screen.getAllByRole("button", { name: "Add project" })[0]);

describe("Dashboard Add Project integration", () => {
  beforeEach(async () => { localStorage.clear(); await i18n.changeLanguage("en-US"); });
  afterEach(() => cleanup());

  it("offers the project toolbar and empty-state entry, never in global activity", async () => {
    render(<SessionDashboard client={client(true)} onOpenSession={vi.fn()} />);
    await screen.findByText(i18n.t("project.empty"));
    expect(screen.getAllByRole("button", { name: "Add project" })).toHaveLength(2);
    open();
    expect(screen.getByRole("dialog")).toHaveTextContent("Studio");
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Show active sessions" }));
    expect(screen.queryByRole("button", { name: "Add project" })).not.toBeInTheDocument();
  });

  it("does not confuse pending or failed project metadata with an empty project list", async () => {
    const remote = client(true);
    const original = vi.mocked(remote.request).getMockImplementation()!;
    let reject!: (error: Error) => void;
    vi.mocked(remote.request).mockImplementation((...args) => args[1] === "project.list"
      ? new Promise((_, fail) => { reject = fail; }) : original(...args));
    render(<SessionDashboard client={remote} onOpenSession={vi.fn()} />);
    await screen.findByRole("option", { name: "Studio" });
    await act(async () => {});
    expect(screen.queryByText(i18n.t("project.empty"))).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Add project" })).toHaveLength(1);
    await act(async () => reject(new Error("Metadata denied")));
    expect(await screen.findByRole("button", { name: "Update failed. Tap to retry" })).toBeInTheDocument();
    expect(screen.queryByText(i18n.t("project.empty"))).not.toBeInTheDocument();
  });

  it("merges, expands and focuses the confirmed project without starting a Session", async () => {
    const remote = client();
    const onOpenSession = vi.fn();
    render(<SessionDashboard client={remote} onOpenSession={onOpenSession} />);
    await screen.findByRole("button", { name: "Existing" });
    fireEvent.click(screen.getByRole("button", { name: "Existing" })); // unrelated expansion is retained
    open();
    const original = vi.mocked(remote.request).getMockImplementation()!;
    vi.mocked(remote.request).mockImplementation((...args) => args[1] === "project.list" ? Promise.resolve([project, added]) : original(...args));
    await act(async () => { await dialog.onAdded({ project: added, focusedExisting: false }); dialog.onClose(); });
    const row = await screen.findByRole("button", { name: added.name });
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(row).toHaveFocus();
    expect(screen.getByRole("button", { name: "Existing" })).toHaveAttribute("aria-expanded", "false");
    expect(JSON.parse(localStorage.getItem("agentport-mobile-v2:workspace:host-1")!).expandedProjects).toContain(added.id);
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(vi.mocked(remote.request).mock.calls.some(([, method]) => method === "session.create")).toBe(false);
  });

  it("keeps the confirmed project visible when list refresh fails and retries only the read", async () => {
    const remote = client();
    render(<SessionDashboard client={remote} onOpenSession={vi.fn()} />);
    await screen.findByRole("button", { name: "Existing" });
    open();
    const request = vi.mocked(remote.request), original = request.getMockImplementation()!;
    request.mockImplementation((...args) => args[1] === "project.list" ? Promise.reject(new Error("Refresh unavailable")) : original(...args));
    await act(async () => { await expect(dialog.onAdded({ project: added, focusedExisting: false })).rejects.toThrow("Refresh unavailable"); });
    expect(screen.getByRole("button", { name: added.name })).toBeInTheDocument();
    request.mockImplementation((...args) => args[1] === "project.list" ? Promise.resolve([project, added]) : original(...args));
    await act(async () => { await dialog.onAdded({ project: added, focusedExisting: false }); dialog.onClose(); });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(request.mock.calls.some(([, method]) => method === "project.add")).toBe(false);
  });

  it("focuses an existing duplicate rather than changing its name or creating a second row", async () => {
    const remote = client();
    render(<SessionDashboard client={remote} onOpenSession={vi.fn()} />);
    await screen.findByRole("button", { name: "Existing" });
    fireEvent.click(screen.getByRole("button", { name: "Existing" }));
    open();
    await act(async () => { await dialog.onAdded({ project, focusedExisting: true }); dialog.onClose(); });
    expect(screen.getAllByRole("button", { name: "Existing" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Existing" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Existing" })).toHaveFocus();
  });

  it("ignores the closed old-device callback even after a new dialog is opened", async () => {
    const remote = client();
    render(<SessionDashboard client={remote} onOpenSession={vi.fn()} />);
    await screen.findByRole("button", { name: "Existing" });
    open();
    const oldDialog = dialog;
    fireEvent.change(screen.getByRole("combobox", { name: "Current device" }), { target: { value: "host-2" } });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await screen.findByRole("button", { name: "Existing" });
    open();
    expect(screen.getByRole("dialog")).toHaveTextContent("Laptop");
    const before = vi.mocked(remote.request).mock.calls.length;
    await act(async () => oldDialog.onAdded({ project: added, focusedExisting: false }));
    expect(screen.queryByRole("button", { name: added.name })).not.toBeInTheDocument();
    expect(vi.mocked(remote.request).mock.calls.length).toBe(before);
  });

  it("discards a late project list response after switching target devices", async () => {
    const remote = client();
    render(<SessionDashboard client={remote} onOpenSession={vi.fn()} />);
    await screen.findByRole("button", { name: "Existing" });
    open();
    const original = vi.mocked(remote.request).getMockImplementation()!;
    let finish!: (value: ProjectSummary[]) => void;
    vi.mocked(remote.request).mockImplementation((...args) => args[0] === "host-1" && args[1] === "project.list"
      ? new Promise(resolve => { finish = resolve; }) : original(...args));
    let addition!: Promise<void>;
    await act(async () => { addition = dialog.onAdded({ project: added, focusedExisting: false }); });
    fireEvent.change(screen.getByRole("combobox", { name: "Current device" }), { target: { value: "host-2" } });
    await screen.findByRole("button", { name: "Existing" });
    await act(async () => { finish([project, added]); await addition; });
    expect(screen.queryByRole("button", { name: added.name })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("disables adding on a disconnected device", async () => {
    const remote = client();
    vi.mocked(remote.listHostProfiles).mockResolvedValue([{ ...hosts[0], connectionState: "disconnected" }]);
    render(<SessionDashboard client={remote} onOpenSession={vi.fn()} />);
    await screen.findByRole("option", { name: "Studio" });
    expect(screen.getByRole("button", { name: "Add project" })).toBeDisabled();
    expect(screen.getByText(content => content.includes(i18n.t("project.offline")))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
