// Results of scripts/benchmark/compare-vscode.mjs plus the official download sizes.
// Rerun the script and update these numbers together with the README table.
export type SizeKey = "installerMacos" | "installerWindows" | "sizeOnDisk" | "memory";

export type SizeMetric = { key: SizeKey; pude: number; vscode: number };

/** Seconds from launch until the first window is on screen and until it stops changing. */
export type LaunchTimes = { window: number; ready: number };

export const BENCHMARK = {
  date: "2026-10-15",
  pudeVersion: "0.1.2",
  vscodeVersion: "1.140.0",
  machine: "Apple M5 Max · 64 GB · macOS 27.0.1",
  runs: 7,
  /** Megabytes. */
  sizes: [
    { key: "installerMacos", pude: 5.1, vscode: 317.9 },
    { key: "installerWindows", pude: 3.9, vscode: 244.4 },
    { key: "sizeOnDisk", pude: 10.5, vscode: 911.6 },
    { key: "memory", pude: 102.7, vscode: 1073.6 },
  ] satisfies SizeMetric[],
  launch: {
    pude: { window: 0.357, ready: 0.603 },
    vscode: { window: 0.41, ready: 1.112 },
  } satisfies Record<"pude" | "vscode", LaunchTimes>,
};

/**
 * Installer sizes of a newer pude release, read from its GitHub release assets
 * (decimal megabytes). Launch time, memory and size on disk were not re-measured.
 */
export const LATER_RELEASE = { version: "0.1.7", installerMacos: 5.6, installerWindows: 4.3 };

export function sizeMetric(key: SizeKey): SizeMetric {
  return BENCHMARK.sizes.find((metric) => metric.key === key)!;
}

/** How many times larger VS Code's value is, rounded for display. */
export function formatRatio(pude: number, vscode: number): string {
  const ratio = vscode / pude;
  return ratio >= 10 ? Math.round(ratio).toString() : ratio.toFixed(1);
}

export function formatMegabytes(value: number): string {
  return `${value < 100 ? value.toFixed(1) : Math.round(value).toLocaleString("en-US")} MB`;
}

export function formatSeconds(value: number): string {
  return `${value.toFixed(2)} s`;
}
