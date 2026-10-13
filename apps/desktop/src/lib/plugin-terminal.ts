type TerminalWriteGuard = () => Promise<void>;
type TerminalWriter = (
  data: string,
  binary: boolean,
  signal?: AbortSignal,
  authorize?: TerminalWriteGuard,
) => Promise<void>;

type ActiveTerminalWriter = {
  workspace: string;
  sessionId: string;
  write: TerminalWriter;
};

let activeTerminalWriter: ActiveTerminalWriter | undefined;

export function registerActivePluginTerminal(
  workspace: string,
  sessionId: string,
  write: TerminalWriter,
): () => void {
  const registration = { workspace, sessionId, write };
  activeTerminalWriter = registration;
  return () => {
    if (activeTerminalWriter === registration) activeTerminalWriter = undefined;
  };
}

export async function writeToActivePluginTerminal(
  workspace: string,
  data: string,
  binary = false,
  signal?: AbortSignal,
  authorize?: TerminalWriteGuard,
): Promise<void> {
  if (signal?.aborted) throw new Error("Plugin terminal write was cancelled.");
  const registration = activeTerminalWriter;
  if (!registration || registration.workspace !== workspace) {
    throw new Error("No active user-opened terminal is available for this workspace.");
  }
  await registration.write(data, binary, signal, authorize);
}
