//! Startup timeline milestones (MS-01), recorded natively.
//!
//! The process start, Builder setup completion, the first IPC command, and
//! the first window reveal are stamped with `Instant`s here. `collect`
//! renders them relative to process start for `get_startup_timing`, and
//! `write_perf_log` emits them to the app log — but only when the native
//! process runs with `PUDE_PERF_LOG=1`.

use serde::Serialize;
use std::sync::OnceLock;
use std::time::Instant;

static PROCESS_START: OnceLock<Instant> = OnceLock::new();
static SETUP_DONE: OnceLock<Instant> = OnceLock::new();
static FIRST_COMMAND: OnceLock<Instant> = OnceLock::new();
static FIRST_WINDOW_SHOWN: OnceLock<Instant> = OnceLock::new();

/// Stamp process start. Called as the first statement of `main`; later calls
/// are ignored, which keeps repeated calls from tests harmless.
pub fn init() {
    let _ = PROCESS_START.set(Instant::now());
}

pub fn mark_setup_done() {
    let _ = SETUP_DONE.set(Instant::now());
}

pub fn record_first_command() {
    let _ = FIRST_COMMAND.set(Instant::now());
}

pub fn record_window_shown() {
    let _ = FIRST_WINDOW_SHOWN.set(Instant::now());
}

fn process_start() -> Instant {
    *PROCESS_START.get_or_init(Instant::now)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupTimingEntry {
    pub name: String,
    pub at_ms: u128,
}

fn entry(name: &str, at: Instant) -> StartupTimingEntry {
    StartupTimingEntry {
        name: name.to_string(),
        at_ms: at.saturating_duration_since(process_start()).as_millis(),
    }
}

/// All native milestones recorded so far, relative to process start in
/// milliseconds. `main-start` is always present and always `0`.
pub fn collect() -> Vec<StartupTimingEntry> {
    let start = process_start();
    let mut entries = vec![entry("main-start", start)];
    if let Some(at) = SETUP_DONE.get() {
        entries.push(entry("setup-done", *at));
    }
    if let Some(at) = FIRST_COMMAND.get() {
        entries.push(entry("first-command", *at));
    }
    if let Some(at) = FIRST_WINDOW_SHOWN.get() {
        entries.push(entry("first-window-shown", *at));
    }
    entries
}

/// Emit the timeline to the app log when `PUDE_PERF_LOG=1`; no output
/// otherwise (MS-01 contract).
pub fn write_perf_log() {
    if !crate::app_log::perf_log_enabled() {
        return;
    }
    for milestone in collect() {
        crate::app_log::perf_log(&format!(
            "startup {} @ {} ms",
            milestone.name, milestone.at_ms
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn collect_always_starts_with_main_start_at_zero() {
        init();
        let entries = collect();
        assert_eq!(entries[0].name, "main-start");
        assert_eq!(entries[0].at_ms, 0);
    }

    #[test]
    fn recorded_milestones_are_relative_and_ordered() {
        init();
        mark_setup_done();
        record_first_command();
        record_window_shown();
        std::thread::sleep(Duration::from_millis(2));
        let entries = collect();
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "main-start",
                "setup-done",
                "first-command",
                "first-window-shown"
            ]
        );
        for index in 1..entries.len() {
            assert!(entries[index].at_ms >= entries[index - 1].at_ms);
        }
    }

    #[test]
    fn write_perf_log_is_a_silent_no_op_without_the_env_flag() {
        // The test harness does not define PUDE_PERF_LOG, so nothing may be
        // written anywhere.
        init();
        mark_setup_done();
        write_perf_log();
    }
}
