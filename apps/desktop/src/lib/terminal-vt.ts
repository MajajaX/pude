import type { ITerminalOptions, Terminal } from "@xterm/xterm";

export const TERMINAL_SCROLLBACK = 5_000;
export const TERMINAL_FONT_FAMILY = '"JetBrains Mono Variable", ui-monospace, "SFMono-Regular", Consolas, monospace';

export const DEFAULT_TERMINAL_OPTIONS: ITerminalOptions = {
  cursorBlink: true,
  cursorStyle: "bar",
  fontFamily: TERMINAL_FONT_FAMILY,
  fontSize: 13,
  lineHeight: 1.4,
  scrollback: TERMINAL_SCROLLBACK,
  screenReaderMode: true,
  theme: {
    background: "#0c0e10",
    foreground: "#dce1e6",
    cursor: "#81b5d1",
    selectionBackground: "#42576888",
  },
};

type TerminalEvents = Pick<Terminal, "onData" | "onBinary" | "onResize">;
type TerminalSubscription = { dispose: () => void };

export function bindTerminalToPty(
  terminal: TerminalEvents,
  pty: {
    writeText: (data: string) => void;
    writeBinary: (data: string) => void;
    resize: (rows: number, cols: number) => void;
  },
): () => void {
  const subscriptions: TerminalSubscription[] = [
    terminal.onData(pty.writeText),
    terminal.onBinary(pty.writeBinary),
    terminal.onResize(({ rows, cols }) => pty.resize(rows, cols)),
  ];

  return () => subscriptions.forEach((subscription) => subscription.dispose());
}
