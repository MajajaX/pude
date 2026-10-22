import { Terminal } from "@xterm/headless";
import { afterEach, describe, expect, it } from "vitest";
import type { Terminal as BrowserTerminal } from "@xterm/xterm";
import { bindTerminalToPty, DEFAULT_TERMINAL_OPTIONS } from "./terminal-vt";

const terminals: Terminal[] = [];

function createTerminal(options: ConstructorParameters<typeof Terminal>[0] = {}) {
  const terminal = new Terminal({
    ...DEFAULT_TERMINAL_OPTIONS,
    allowProposedApi: true,
    cols: 20,
    rows: 5,
    ...options,
  });
  terminals.push(terminal);
  return terminal;
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

afterEach(() => {
  terminals.splice(0).forEach((terminal) => terminal.dispose());
});

describe("xterm VT terminal", () => {
  it("parses ANSI colors and cursor movement", async () => {
    const terminal = createTerminal();
    await write(terminal, "\u001b[31mred\u001b[0m\u001b[1;2HX");

    const firstLine = terminal.buffer.active.getLine(0)!;
    expect(firstLine.translateToString(true)).toBe("rXd");
    expect(firstLine.getCell(0)?.getFgColor()).toBe(1);
    expect(firstLine.getCell(0)?.isFgPalette()).toBe(true);
    expect(terminal.buffer.active.cursorX).toBe(2);
    expect(terminal.buffer.active.cursorY).toBe(0);
  });

  it("switches to and restores the alternate screen", async () => {
    const terminal = createTerminal();
    await write(terminal, "normal\u001b[?1049h\u001b[Hfull-screen");

    expect(terminal.buffer.active.type).toBe("alternate");
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("full-screen");

    await write(terminal, "\u001b[?1049l");
    expect(terminal.buffer.active.type).toBe("normal");
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("normal");
  });

  it("tracks common mouse reporting modes", async () => {
    const terminal = createTerminal();
    await write(terminal, "\u001b[?1000h\u001b[?1006h");
    expect(terminal.modes.mouseTrackingMode).toBe("vt200");

    await write(terminal, "\u001b[?1002h");
    expect(terminal.modes.mouseTrackingMode).toBe("drag");
  });

  it("keeps CJK characters at two terminal cells and forwards Unicode input", async () => {
    const terminal = createTerminal();
    const received: string[] = [];
    terminal.onData((data) => received.push(data));

    await write(terminal, "繁體中文");
    terminal.input("輸入文字");

    expect(terminal.buffer.active.getLine(0)?.getCell(0)?.getChars()).toBe("繁");
    expect(terminal.buffer.active.getLine(0)?.getCell(0)?.getWidth()).toBe(2);
    expect(received).toEqual(["輸入文字"]);
  });

  it("does not echo typed password text until the PTY returns it", () => {
    const terminal = createTerminal();
    const sent: string[] = [];
    const dispose = bindTerminalToPty(terminal, {
      writeText: (data) => sent.push(data),
      writeBinary: () => undefined,
      resize: () => undefined,
    });

    terminal.input("secret-from-password-prompt");

    expect(sent).toEqual(["secret-from-password-prompt"]);
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("");
    dispose();
  });

  it("applies production screen reader and scrollback options", async () => {
    expect(DEFAULT_TERMINAL_OPTIONS.scrollback).toBe(5_000);
    expect(DEFAULT_TERMINAL_OPTIONS.screenReaderMode).toBe(true);
    const terminal = createTerminal({ rows: 2, scrollback: 2 });
    expect(terminal.options.screenReaderMode).toBe(true);
    await write(terminal, Array.from({ length: 12 }, (_, index) => `line-${index}\r\n`).join(""));

    expect(terminal.buffer.normal.baseY).toBe(2);
    expect(terminal.buffer.normal.length).toBe(4);
    expect(terminal.buffer.normal.getLine(2)?.translateToString(true)).toBe("line-11");
  });

});

describe("terminal to PTY wiring", () => {
  it("forwards text, binary mouse bytes and fitted rows/columns", () => {
    let dataHandler: ((data: string) => void) | undefined;
    let binaryHandler: ((data: string) => void) | undefined;
    let resizeHandler: ((size: { rows: number; cols: number }) => void) | undefined;
    const disposed: string[] = [];
    const terminalEvents = {
      onData(handler: (data: string) => void) {
        dataHandler = handler;
        return { dispose: () => disposed.push("data") };
      },
      onBinary(handler: (data: string) => void) {
        binaryHandler = handler;
        return { dispose: () => disposed.push("binary") };
      },
      onResize(handler: (size: { rows: number; cols: number }) => void) {
        resizeHandler = handler;
        return { dispose: () => disposed.push("resize") };
      },
    } as unknown as BrowserTerminal;
    const textWrites: string[] = [];
    const binaryWrites: string[] = [];
    const sizes: Array<{ rows: number; cols: number }> = [];
    const dispose = bindTerminalToPty(terminalEvents, {
      writeText: (data) => textWrites.push(data),
      writeBinary: (data) => binaryWrites.push(data),
      resize: (rows, cols) => sizes.push({ rows, cols }),
    });

    dataHandler?.("Get-ChildItem\r");
    binaryHandler?.("\u001b[M\u0080\u0001");
    resizeHandler?.({ rows: 32, cols: 110 });
    dispose();

    expect(textWrites).toEqual(["Get-ChildItem\r"]);
    expect(binaryWrites).toEqual(["\u001b[M\u0080\u0001"]);
    expect(sizes).toEqual([{ rows: 32, cols: 110 }]);
    expect(disposed).toEqual(["data", "binary", "resize"]);
  });
});
