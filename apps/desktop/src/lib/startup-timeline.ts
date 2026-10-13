// Startup milestone timeline (MS-01).
//
// Marks are kept in an in-memory ring (capped at 200 entries) and mirrored to
// `performance.mark`. Each mark is also reported to the native side, which
// only writes it to the local app log when the native process runs with
// PUDE_PERF_LOG=1; in normal operation nothing is ever written out.

import { invoke } from "@tauri-apps/api/core";

export interface StartupTimelineEntry {
  name: string;
  at: number;
}

const MAX_ENTRIES = 200;

const entries: StartupTimelineEntry[] = [];

const isTauriRuntime =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function reportEntry(entry: StartupTimelineEntry): void {
  if (!isTauriRuntime) return;
  void invoke("report_startup_event", { name: entry.name, atMs: entry.at }).catch(
    () => {}
  );
}

export function markStartupEvent(name: string): void {
  if (entries.length >= MAX_ENTRIES) return;
  const entry: StartupTimelineEntry = { name, at: performance.now() };
  try {
    performance.mark(name);
  } catch {
    // performance.mark can be unavailable in exotic runtimes; the in-memory
    // entry is the source of truth anyway.
  }
  entries.push(entry);
  reportEntry(entry);
}

export function markFirstFrameShown(): void {
  // A WebView animation callback is an observation, not display-present proof.
  markStartupEvent("frame-after-show");
}

export function drainStartupTimeline(): StartupTimelineEntry[] {
  return entries.splice(0, entries.length);
}
