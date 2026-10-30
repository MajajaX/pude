import { afterEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.clearAllMocks(); });

const startWith = async (activatePythonEnvironment?: boolean) => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  const { invoke } = await import("@tauri-apps/api/core");
  const { startTerminal } = await import("./bridge");
  vi.mocked(invoke).mockResolvedValue("session-1");
  await startTerminal("/work/app", 24, 80, () => undefined, "/work/app/sub", activatePythonEnvironment);
  return vi.mocked(invoke).mock.calls[0][1];
};

it("asks the backend to activate the Python environment only when told to", async () => {
  expect(await startWith(true)).toMatchObject({ workspace: "/work/app", workingDirectory: "/work/app/sub", activatePythonEnvironment: true, rows: 24, cols: 80 });
  vi.resetModules();
  vi.clearAllMocks();
  expect(await startWith()).toMatchObject({ activatePythonEnvironment: false });
});
