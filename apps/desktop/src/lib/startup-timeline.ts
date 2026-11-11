// Startup milestone timeline (MS-01).
//
// The first 200 milestones become `performance.mark` entries and are reported
// to the native side, which only writes them to the local app log when the
// native process runs with PUDE_PERF_LOG=1; in normal operation nothing is
// ever written out.

import { invoke } from "@tauri-apps/api/core";

export interface StartupTimelineEntry {
  name: string;
  at: number;
}

const MAX_ENTRIES = 200;

let recordedEntries = 0;

const isTauriRuntime = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function reportEntry(entry: StartupTimelineEntry): void {
  if (!isTauriRuntime) return;
  void invoke("report_startup_event", { name: entry.name, atMs: entry.at }).catch(() => {});
}

export function markStartupEvent(name: string): void {
  if (recordedEntries >= MAX_ENTRIES) return;
  recordedEntries += 1;
  const entry: StartupTimelineEntry = { name, at: performance.now() };
  try {
    performance.mark(name);
  } catch {
    // performance.mark can be unavailable in exotic runtimes; the native report
    // still carries the milestone.
  }
  reportEntry(entry);
}

export function markFirstFrameShown(): void {
  // A WebView animation callback is an observation, not display-present proof.
  markStartupEvent("frame-after-show");
}
