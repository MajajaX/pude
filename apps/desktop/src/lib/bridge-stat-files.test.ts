import { afterEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.clearAllMocks(); });

it("sends one native stat request with the Rust request envelope for 100 files", async () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  const { invoke } = await import("@tauri-apps/api/core");
  const { statFiles } = await import("./bridge");
  const paths = Array.from({ length: 100 }, (_, index) => `C:/workspace/${index}.txt`);
  const entries = paths.map((path) => ({ path, exists: true, modifiedAt: 1, size: 2, identity: "a:b" }));
  vi.mocked(invoke).mockResolvedValue({ entries });
  expect(await statFiles(paths)).toEqual(entries);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("stat_files", { request: { paths } });
});
