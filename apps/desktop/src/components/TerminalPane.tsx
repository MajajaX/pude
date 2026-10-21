import { For, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Icon } from "./Icons";
import { isTauri, ackTerminalOutput, killTerminal, listenForTerminalExit, resizeTerminal, startTerminal, writeTerminal, type TerminalExitPayload, type TerminalOutputPayload } from "../lib/bridge";
import { errorMessage } from "../lib/core";
import { fitVisibleTerminal } from "../lib/terminal-fit";
import { TerminalLifecycle } from "../lib/terminal-lifecycle";
import { TerminalAckQueue, TerminalAckScheduler, TerminalAckTracker, TERMINAL_ACK_FLUSH_BYTES } from "../lib/terminal-ack";
import { registerActivePluginTerminal } from "../lib/plugin-terminal";
import { bindTerminalToPty, DEFAULT_TERMINAL_OPTIONS } from "../lib/terminal-vt";

type TerminalTab = { id: number; label: string; directory?: string };
export type TerminalOpenRequest = { id: number; directory: string };

type EarlyOutputChunk = { seq: number; generation: number; data: string; bytes: number };

export function TerminalPane(props: { workspace: string; height: number; visible: boolean; openRequest?: TerminalOpenRequest; onHide: () => void; onClose: () => void }) {
  const [tabs, setTabs] = createSignal<TerminalTab[]>([{ id: 1, label: "Terminal 1", directory: props.openRequest?.directory }]);
  const [activeTabId, setActiveTabId] = createSignal(1);
  let lastOpenRequestId = props.openRequest?.id;
  let nextTabId = 2;
  const addTab = (directory?: string) => {
    const id = nextTabId++;
    setTabs((current) => [...current, { id, label: `Terminal ${id}`, directory }]);
    setActiveTabId(id);
  };
  createEffect(() => {
    const request = props.openRequest;
    if (!request || request.id === lastOpenRequestId) return;
    lastOpenRequestId = request.id;
    addTab(request.directory);
  });
  const closeTab = (id: number) => {
    const current = tabs();
    const index = current.findIndex((tab) => tab.id === id);
    const next = current.filter((tab) => tab.id !== id);
    setTabs(next);
    if (activeTabId() === id) setActiveTabId(next[Math.min(index, next.length - 1)]?.id ?? 0);
    if (!next.length) props.onClose();
  };
  const closeAll = () => {
    setTabs([]);
    setActiveTabId(0);
    props.onClose();
  };
  createEffect(on(() => props.visible, (visible) => {
    if (visible && !tabs().length) addTab();
  }, { defer: true }));

  return (
    <section class="terminal-pane" style={{ height: `${props.height}px`, display: props.visible ? undefined : "none" }} aria-hidden={!props.visible}>
      <div class="terminal-toolbar">
        <div class="terminal-tabs" role="tablist" aria-label="Terminal sessions">
          <For each={tabs()}>{(tab) => <div classList={{ "terminal-tab": true, "terminal-tab-active": activeTabId() === tab.id }}>
            <button type="button" role="tab" aria-selected={activeTabId() === tab.id} onClick={() => setActiveTabId(tab.id)}><Icon name="terminal" size={13} />{tab.label}</button>
            <button type="button" class="terminal-tab-close" title={`Kill ${tab.label}`} aria-label={`Kill ${tab.label}`} onClick={() => closeTab(tab.id)}><Icon name="close" size={12} /></button>
          </div>}</For>
          <button class="icon-button terminal-add-tab" type="button" title="New terminal" aria-label="New terminal" onClick={() => addTab()}><Icon name="plus" size={14} /></button>
        </div>
        <div class="terminal-toolbar-actions">
          <button class="icon-button" type="button" title="Hide terminal" aria-label="Hide terminal" onClick={props.onHide}><Icon name="chevron-down" size={14} /></button>
          <button class="icon-button" type="button" title="Close all terminals" aria-label="Close all terminals" onClick={closeAll}><Icon name="close" size={14} /></button>
        </div>
      </div>
      <For each={tabs()}>{(tab) => {
        const visible = createMemo(() => props.visible && activeTabId() === tab.id);
        return <TerminalSession workspace={props.workspace} workingDirectory={tab.directory} visible={visible()} />;
      }}</For>
    </section>
  );
}

function TerminalSession(props: { workspace: string; workingDirectory?: string; visible: boolean }) {
  const sessionWorkspace = createMemo(() => props.workspace);
  const [sessionId, setSessionId] = createSignal<string>();
  const [sessionEnded, setSessionEnded] = createSignal(isTauri);
  let hostRef!: HTMLDivElement;
  let terminal: Terminal | undefined;
  let fitAddon: { fit: () => void } | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let unlistenExit: (() => void) | undefined;
  let disposeTerminalInput: (() => void) | undefined;
  let disposePluginTerminalWriter: (() => void) | undefined;
  let disposed = false;
  let listenersReady = false;
  let paneInitialized = false;
  let shouldRun = true;
  let activeId: string | undefined;
  let outputReady = false;
  let capturingStartupOutput = false;
  let writeQueue = Promise.resolve();
  let browserInput = "";
  let fitFrame = 0;
  let earlyOutput = new Map<string, EarlyOutputChunk[]>();
  let earlyExit = new Map<string, TerminalExitPayload>();
  let sessionGeneration = 0;
  let startupVersion = 0;
  const ackTracker = new TerminalAckTracker();
  const ackQueue = new TerminalAckQueue();
  const ackScheduler = new TerminalAckScheduler(
    (callback) => requestAnimationFrame(callback),
    (handle) => cancelAnimationFrame(handle),
  );
  const lifecycle = new TerminalLifecycle({
    // Every start creates a fresh per-session output channel via
    // `startTerminal`, so a restart automatically rebinds the stream.
    start: (workspace) => startTerminal(workspace, terminal?.rows ?? 24, terminal?.cols ?? 80, handleOutputPayload, props.workingDirectory),
    stop: killTerminal,
  });

  const failOutputAcknowledgment = (id: string, generation: number, error: unknown) => {
    if (disposed || activeId !== id || sessionGeneration !== generation || sessionEnded()) return;
    shouldRun = false;
    activeId = undefined;
    outputReady = false;
    ackTracker.reset();
    ackScheduler.reset();
    disposePluginTerminalWriter?.();
    disposePluginTerminalWriter = undefined;
    setSessionEnded(true);
    setSessionId(undefined);
    if (terminal) terminal.options.disableStdin = true;
    appendStatus(`${errorMessage(error, "Unable to acknowledge terminal output.")} Restart terminal to continue.`);
    void lifecycle.stop().catch((stopError) => {
      if (!disposed && !activeId && sessionGeneration === generation) {
        appendStatus(errorMessage(stopError, "Unable to stop the terminal after its output acknowledgment failed."));
      }
    });
  };

  /**
   * Drains the contiguous completed run into a single
   * acknowledgment. Sending is gated by `ackScheduler` so bursty output
   * collapses into one `terminal_ack_output` per animation frame (or
   * immediately once 32 KiB are pending); the upToSeq/bytes semantics are
   * unchanged.
   */
  const flushAcks = (id: string, generation: number) => {
    const batch = ackTracker.drainBatch();
    if (!batch) return;
    ackQueue.enqueue(
      () => activeId === id && sessionGeneration === generation && !sessionEnded()
        ? ackTerminalOutput(id, generation, batch.upToSeq, batch.bytes)
        : Promise.resolve(),
      (error) => failOutputAcknowledgment(id, generation, error),
    );
    // Completions that arrived out of order behind this run have already run
    // their write callbacks, so only another frame can drain them.
    if (ackTracker.pendingBytes() > 0) ackScheduler.schedule(() => flushAcks(id, generation));
  };

  const writeOutput = (data: string, seq: number, generation: number, bytes: number) => {
    const id = activeId;
    if (!id || sessionEnded() || !ackTracker.beginGeneration(generation)) return;
    sessionGeneration = generation;
    terminal?.write(data, () => {
      if (activeId !== id || sessionGeneration !== generation || sessionEnded()) return;
      ackTracker.recordWritten(seq, bytes, generation);
      if (ackTracker.pendingBytes() >= TERMINAL_ACK_FLUSH_BYTES) {
        ackScheduler.flushNow(() => flushAcks(id, generation));
      } else {
        ackScheduler.schedule(() => flushAcks(id, generation));
      }
    });
  };
  const handleOutputPayload = (payload: TerminalOutputPayload) => {
    if (disposed) return;
    if (payload.sessionId === activeId && outputReady) {
      writeOutput(payload.data, payload.seq, payload.generation, payload.bytes);
    } else if (capturingStartupOutput && !activeId) {
      // The pre-attach buffer is bounded by the reader-side
      // credit window instead of truncating chunks, so no output is
      // dropped mid-escape-sequence before the parser is attached.
      const chunks = earlyOutput.get(payload.sessionId) ?? [];
      chunks.push({ seq: payload.seq, generation: payload.generation, data: payload.data, bytes: payload.bytes });
      earlyOutput.set(payload.sessionId, chunks);
      while (earlyOutput.size > 4) earlyOutput.delete(earlyOutput.keys().next().value as string);
    }
  };

  const appendStatus = (message: string) => terminal?.write(`\r\n${message}\r\n`);
  const fitIfVisible = () => {
    if (!fitAddon || !hostRef) return false;
    const didFit = fitVisibleTerminal(props.visible, hostRef, () => fitAddon?.fit());
    if (!didFit) return false;
    const id = sessionId();
    if (id && !sessionEnded()) void resizeTerminal(id, terminal?.rows ?? 0, terminal?.cols ?? 0).catch(() => undefined);
    return true;
  };

  const scheduleFit = () => {
    if (fitFrame) cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(() => {
      fitFrame = 0;
      fitIfVisible();
    });
  };

  const resizeSession = (id: string, rows: number, cols: number) => {
    void resizeTerminal(id, rows, cols).catch((error) => {
      if (!disposed && id === activeId) appendStatus(errorMessage(error, "Unable to resize terminal."));
    });
  };

  const writePtyInput = (
    id: string,
    data: string,
    binary = false,
    signal?: AbortSignal,
    authorize?: () => Promise<void>,
  ): Promise<void> => {
    if (signal?.aborted) return Promise.reject(new Error("Plugin terminal write was cancelled."));
    if (!isTauri || id !== activeId || sessionEnded()) {
      return Promise.reject(new Error("The terminal session is no longer active."));
    }
    const pendingWrite = writeQueue.then(() => {
      if (signal?.aborted) throw new Error("Plugin terminal write was cancelled.");
      if (id !== activeId || sessionEnded()) throw new Error("The terminal session is no longer active.");
      return Promise.resolve(authorize?.()).then(() => {
        if (signal?.aborted) throw new Error("Plugin terminal write was cancelled.");
        if (id !== activeId || sessionEnded()) throw new Error("The terminal session is no longer active.");
        return writeTerminal(id, data, binary);
      });
    });
    writeQueue = pendingWrite.catch((error) => {
      if (signal?.aborted) return;
      if (disposed || id !== activeId || sessionEnded()) return;
      setSessionEnded(true);
      disposePluginTerminalWriter?.();
      disposePluginTerminalWriter = undefined;
      setSessionId(undefined);
      if (terminal) terminal.options.disableStdin = true;
      appendStatus(errorMessage(error, "Unable to write terminal input."));
    });
    return pendingWrite;
  };

  const activatePluginWriter = (workspace: string, id: string) => {
    disposePluginTerminalWriter?.();
    disposePluginTerminalWriter = registerActivePluginTerminal(
      workspace,
      id,
      (data, binary, signal, authorize) => writePtyInput(id, data, binary, signal, authorize),
    );
  };

  const writeInput = (data: string, binary = false) => {
    const id = sessionId();
    if (!id || !isTauri || sessionEnded()) return;
    void writePtyInput(id, data, binary).catch(() => undefined);
  };

  const runBrowserCommand = (command: string): string[] => {
    const trimmed = command.trim();
    if (!trimmed) return [];
    if (trimmed === "clear") return [];
    if (trimmed === "help") return ["help  clear  pwd  git status"];
    if (trimmed === "pwd") return [props.workingDirectory ?? props.workspace];
    if (trimmed === "git status") return ["On branch main", "Changes not staged for commit: src/main.ts"];
    return [`browser demo: ${trimmed}`];
  };

  const handleBrowserInput = (data: string) => {
    const current = terminal;
    if (!current || data.includes("\u001b")) return;
    for (const character of data) {
      if (character === "\r") {
        current.write("\r\n");
        const result = runBrowserCommand(browserInput);
        if (browserInput.trim() === "clear") current.write("\u001b[2J\u001b[H");
        else result.forEach((line) => current.write(`${line}\r\n`));
        current.write("pude$ ");
        browserInput = "";
      } else if (character === "\u007f") {
        if (browserInput.length > 0) {
          browserInput = Array.from(browserInput).slice(0, -1).join("");
          current.write("\b \b");
        }
      } else if (character === "\u0003") {
        current.write("^C\r\npude$ ");
        browserInput = "";
      } else if (!character.startsWith("\u001b") && character >= " ") {
        browserInput += character;
        current.write(character);
      }
    }
  };

  const finishSession = (payload: TerminalExitPayload) => {
    if (payload.sessionId !== activeId) {
      if (capturingStartupOutput && !activeId) {
        earlyExit.set(payload.sessionId, payload);
        while (earlyExit.size > 4) earlyExit.delete(earlyExit.keys().next().value as string);
      }
      return;
    }
    lifecycle.sessionEnded(payload.sessionId);
    shouldRun = false;
    activeId = undefined;
    disposePluginTerminalWriter?.();
    disposePluginTerminalWriter = undefined;
    outputReady = false;
    setSessionEnded(true);
    setSessionId(undefined);
    if (terminal) terminal.options.disableStdin = true;
    appendStatus(payload.status ? `terminal exited: ${payload.status}` : "terminal exited");
  };

  const startSession = async (workspace: string) => {
    if (!isTauri || disposed || !listenersReady || !shouldRun || activeId || capturingStartupOutput) return;
    const version = ++startupVersion;
    const isCurrentStart = () => !disposed && shouldRun && version === startupVersion && workspace === props.workspace;
    writeQueue = Promise.resolve();
    capturingStartupOutput = true;
    outputReady = false;
    ackQueue.reset();
    ackTracker.reset();
    ackScheduler.reset();
    sessionGeneration = 0;
    setSessionEnded(false);
    setSessionId(undefined);
    try {
      if (terminal) {
        terminal.options.disableStdin = true;
        terminal.reset();
        terminal.write("pude terminal\r\n");
      }
      if (!isCurrentStart()) return;
      const id = await lifecycle.start(workspace);
      if (!id) return;
      if (!isCurrentStart()) return;
      activeId = id;
      if (terminal) terminal.options.disableStdin = false;
      if (props.visible) activatePluginWriter(workspace, id);
      const replay = earlyOutput.get(id);
      earlyOutput.delete(id);
      replay?.forEach((chunk) => writeOutput(chunk.data, chunk.seq, chunk.generation, chunk.bytes));
      outputReady = true;
      setSessionId(id);
      setSessionEnded(false);
      const exitedBeforeAttach = earlyExit.get(id);
      earlyExit.delete(id);
      if (exitedBeforeAttach) {
        finishSession(exitedBeforeAttach);
        return;
      }
      if (terminal) {
        if (props.visible) terminal.focus();
      }
      fitIfVisible();
      if (props.visible && terminal) resizeSession(id, terminal.rows, terminal.cols);
    } catch (error) {
      if (!isCurrentStart()) return;
      shouldRun = false;
      setSessionEnded(true);
      if (terminal) terminal.options.disableStdin = true;
      appendStatus(errorMessage(error, "Unable to start terminal."));
    } finally {
      if (version === startupVersion) capturingStartupOutput = false;
    }
  };

  const restartSession = () => {
    startupVersion += 1;
    shouldRun = true;
    const workspace = props.workspace;
    activeId = undefined;
    outputReady = false;
    void lifecycle.stop().then(() => {
      if (!disposed && shouldRun && workspace === props.workspace) void startSession(workspace);
    }).catch((error) => {
      if (!disposed && workspace === props.workspace) appendStatus(errorMessage(error, "Unable to restart terminal."));
    });
  };

  onMount(() => {
    void (async () => {
      try {
        const [{ Terminal: XtermTerminal }, { FitAddon }] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
        ]);
        if (disposed) return;

        const instance = new XtermTerminal(DEFAULT_TERMINAL_OPTIONS);
        terminal = instance;
        const fit = new FitAddon();
        fitAddon = fit;
        instance.loadAddon(fit);
        instance.open(hostRef);
        instance.write("pude terminal\r\n");
        instance.options.disableStdin = isTauri;

        if (isTauri) {
          disposeTerminalInput = bindTerminalToPty(instance, {
            writeText: (data) => writeInput(data),
            writeBinary: (data) => writeInput(data, true),
            resize: (rows, cols) => {
              const id = sessionId();
              if (id && !sessionEnded()) resizeSession(id, rows, cols);
            },
          });
        } else {
          const subscription = instance.onData(handleBrowserInput);
          disposeTerminalInput = () => subscription.dispose();
          instance.options.disableStdin = false;
          instance.write("browser demo: help, clear, pwd, git status\r\npude$ ");
          if (props.visible) instance.focus();
        }

        resizeObserver = typeof ResizeObserver === "undefined"
          ? undefined
          : new ResizeObserver(() => { if (props.visible) scheduleFit(); });
        resizeObserver?.observe(hostRef);

        unlistenExit = await listenForTerminalExit(finishSession);
        if (disposed) return;

        listenersReady = true;
        paneInitialized = true;
        if (isTauri && props.visible) {
          shouldRun = true;
          await startSession(props.workspace);
        }
        scheduleFit();
      } catch (error) {
        if (disposed) return;
        unlistenExit?.();
        unlistenExit = undefined;
        resizeObserver?.disconnect();
        resizeObserver = undefined;
        disposeTerminalInput?.();
        disposeTerminalInput = undefined;
        setSessionEnded(true);
        if (terminal) terminal.options.disableStdin = true;
        if (terminal) appendStatus(errorMessage(error, "Unable to start terminal."));
        else hostRef.textContent = errorMessage(error, "Unable to load terminal.");
      }
    })();
  });

  createEffect(on(sessionWorkspace, (workspace) => {
    if (!paneInitialized) return;
    startupVersion += 1;
    shouldRun = true;
    outputReady = false;
    capturingStartupOutput = false;
    activeId = undefined;
    ackQueue.reset();
    ackTracker.reset();
    ackScheduler.reset();
    sessionGeneration = 0;
    disposePluginTerminalWriter?.();
    disposePluginTerminalWriter = undefined;
    earlyOutput.clear();
    earlyExit.clear();
    setSessionId(undefined);
    setSessionEnded(!isTauri);
    if (terminal) {
      terminal.reset();
      terminal.write("pude terminal\r\n");
      terminal.options.disableStdin = true;
    }
    if (!isTauri) return;
    void lifecycle.stop().then(() => {
      if (!disposed && workspace === props.workspace && props.visible && shouldRun) void startSession(workspace);
    }).catch((error) => {
      if (!disposed) appendStatus(errorMessage(error, "Unable to stop terminal for workspace switch."));
    });
  }, { defer: true }));

  createEffect(on(() => props.visible, (visible) => {
    if (!visible) {
      disposePluginTerminalWriter?.();
      disposePluginTerminalWriter = undefined;
      return;
    }
    if (activeId) activatePluginWriter(props.workspace, activeId);
    scheduleFit();
    if (isTauri && paneInitialized && shouldRun && !activeId && !capturingStartupOutput) {
      void startSession(props.workspace);
    } else if (terminal) {
      window.requestAnimationFrame(() => {
        if (!disposed && props.visible) terminal?.focus();
      });
    }
  }, { defer: true }));

  onCleanup(() => {
    startupVersion += 1;
    disposed = true;
    shouldRun = false;
    ackScheduler.reset();
    disposePluginTerminalWriter?.();
    disposePluginTerminalWriter = undefined;
    earlyOutput.clear();
    earlyExit.clear();
    if (fitFrame) cancelAnimationFrame(fitFrame);
    fitFrame = 0;
    resizeObserver?.disconnect();
    resizeObserver = undefined;
    disposeTerminalInput?.();
    disposeTerminalInput = undefined;
    unlistenExit?.();
    unlistenExit = undefined;
    void lifecycle.stop().catch(() => undefined);
    terminal?.dispose();
    terminal = undefined;
  });

  return <div class="terminal-session" style={{ display: props.visible ? undefined : "none" }}><div class="terminal-vt-host" ref={hostRef} aria-label={sessionEnded() ? "Terminal session ended" : "Terminal"} /><button class="terminal-restart" style={{ display: sessionEnded() && isTauri ? undefined : "none" }} type="button" onClick={restartSession}><Icon name="play" size={13} /> Restart terminal</button></div>;
}
