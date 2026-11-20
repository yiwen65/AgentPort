// @vitest-environment jsdom
// Regression: a remote fullscreen TUI must receive wheel reports after the
// desktop replaces its buffer with the Host's authoritative screen snapshot.
//
// `restoreHostScreenSnapshot` (terminals.ts) writes the serialized screen and
// then restores parser state, including the mouse protocol. If that restore
// dropped `mouseProtocol`, xterm would keep the wheel for its own viewport and
// the TUI would never scroll — the reported "wheel does nothing" symptom.
//
// The fixture is a real `agentport-host` snapshot payload: 47x40 easy-pi
// fullscreen with mouse ANY / SGR encoding. jsdom has no layout, so mouse
// coordinates arrive as NaN, but the report itself proves forwarding.
import { afterEach, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { isTerminalSnapshot, restoreSnapshotState } from "./terminalSnapshot";
import fixture from "./fixtures/hostScreenSnapshot.json";

const opened: Array<{ terminal: Terminal; container: HTMLElement }> = [];

afterEach(() => {
  for (const { terminal, container } of opened.splice(0)) {
    terminal.dispose();
    container.remove();
  }
});

function openTerminal(cols: number, rows: number) {
  const terminal = new Terminal({ cols, rows, scrollback: 10_000 });
  const container = document.createElement("div");
  document.body.append(container);
  terminal.open(container);
  // jsdom has no layout engine: supply only cell measurements. Parser, mouse
  // protocol and onData are real xterm 5.5.
  const core = (terminal as unknown as {
    _core: {
      _charSizeService: { width: number; height: number };
      _renderService: { dimensions: { css: {
        cell: { width: number; height: number };
        canvas: { width: number; height: number };
      } } };
    };
  })._core;
  core._charSizeService.width = 10;
  core._charSizeService.height = 20;
  core._renderService.dimensions.css.cell.width = 10;
  core._renderService.dimensions.css.cell.height = 20;
  core._renderService.dimensions.css.canvas.width = cols * 10;
  core._renderService.dimensions.css.canvas.height = rows * 20;
  opened.push({ terminal, container });
  return { terminal, container };
}

/** Mirrors restoreHostScreenSnapshot: serialized content first, then state. */
async function restoreSnapshot(terminal: Terminal, state: unknown) {
  await new Promise<void>((resolve) => {
    terminal.write(fixture.content, () => {
      restoreSnapshotState(terminal, state as never);
      resolve();
    });
  });
}

function wheel(container: HTMLElement) {
  const target = container.querySelector<HTMLElement>(".xterm-screen") ?? container;
  target.dispatchEvent(new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 60,
    deltaY: 120,
    deltaMode: 0,
  }));
}

/** Button 64/65 = wheel up/down in the SGR protocol. jsdom has no layout, so
 * xterm's NaN coordinates are expected here; the report itself is the signal. */
const SGR_WHEEL_REPORT = /^\x1b\[<6[45];/;

describe("wheel forwarding after a Host screen snapshot restore", () => {
  it("accepts the live Host snapshot shape", () => {
    expect(isTerminalSnapshot(fixture)).toBe(true);
  });

  it("carries the mouse protocol the fullscreen TUI enabled", () => {
    expect(fixture.state.mouseProtocol).toBe("ANY");
    expect(fixture.state.mouseEncoding).toBe("SGR");
  });

  it("forwards a wheel event to the Agent instead of scrolling locally", async () => {
    const { terminal, container } = openTerminal(fixture.cols, fixture.rows);
    const sent: string[] = [];
    terminal.onData((chunk) => sent.push(chunk));

    await restoreSnapshot(terminal, fixture.state);
    expect(terminal.modes.mouseTrackingMode).toBe("any");
    // The alternate screen owns its own scrollback; xterm must not scroll it.
    expect(terminal.buffer.active.type).toBe("alternate");

    wheel(container);

    expect(sent.some((chunk) => SGR_WHEEL_REPORT.test(chunk))).toBe(true);
  });
});