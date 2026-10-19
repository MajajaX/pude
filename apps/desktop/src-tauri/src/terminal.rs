//! Terminal sessions: PTY lifecycle, output flow control, and
//! process-tree cleanup. Extracted from main.rs.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::{BTreeMap, HashMap};
use std::io::{self, Read, Write};
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
#[cfg(windows)]
use std::process::Command;
#[cfg(windows)]
use std::sync::atomic::AtomicU32;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::blocking::BlockingClass;
use crate::python_environment;
use crate::{decode_wire_path, run_blocking, run_blocking_resource, AppState, QuitGateState};

#[derive(Default)]
pub(crate) struct TerminalLifecycle {
    windows: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl TerminalLifecycle {
    fn reserve(&self, owner: &str) -> Result<Arc<AtomicBool>, String> {
        let mut windows = self
            .windows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let cancellation = windows.entry(owner.to_string()).or_default();
        if cancellation.load(Ordering::Acquire) {
            return Err("The terminal window has closed.".to_string());
        }
        Ok(Arc::clone(cancellation))
    }

    fn register_if_open(
        &self,
        terminals: &Mutex<HashMap<String, Arc<TerminalSession>>>,
        id: &str,
        terminal: &Arc<TerminalSession>,
    ) -> bool {
        let windows = self
            .windows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if windows
            .get(&terminal.owner_window)
            .is_some_and(|cancelled| cancelled.load(Ordering::Acquire))
        {
            return false;
        }
        terminals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(id.to_string(), Arc::clone(terminal));
        true
    }

    pub(crate) fn retire_window(
        &self,
        terminals: &Mutex<HashMap<String, Arc<TerminalSession>>>,
        owner: &str,
    ) -> Result<Vec<(String, Arc<TerminalSession>)>, String> {
        let mut windows = self
            .windows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        windows
            .entry(owner.to_string())
            .or_default()
            .store(true, Ordering::Release);
        take_window_terminals(terminals, owner)
    }
}

pub(crate) struct TerminalSession {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    child: Mutex<Option<Box<dyn Child + Send>>>,
    process_tree: Mutex<Option<TerminalProcessTree>>,
    #[cfg(windows)]
    writer_thread_id: AtomicU32,
    reader_thread: Mutex<Option<JoinHandle<()>>>,
    process_watcher: Mutex<Option<JoinHandle<()>>>,
    stop_lock: Mutex<()>,
    stop_requested: AtomicBool,
    reader_finished: Arc<AtomicBool>,
    owner_window: String,
    output_flow: TerminalOutputFlow,
    /// Per-session `terminal-output` stream. Owned by the
    /// session so SB-01 background cleanup drops the channel together with
    /// the rest of the session state (`Channel` is a cheap `Arc` clone).
    output_channel: Channel<TerminalOutputEvent>,
}

/// Bounded in-flight credit window between the PTY reader and the
/// frontend xterm consumer. Once the un-ACKed output reaches
/// `TERMINAL_OUTPUT_CREDIT_LIMIT_BYTES` the reader stops reading the PTY so
/// the OS pipe backpressure reaches the producing process instead of growing
/// an unbounded queue; reading resumes after the consumer ACKs the backlog
/// below `TERMINAL_OUTPUT_CREDIT_RESUME_BYTES`. Tune both values per
/// platform under load and record the final values in the release notes.
const TERMINAL_OUTPUT_CREDIT_LIMIT_BYTES: usize = 256 * 1024;
const TERMINAL_OUTPUT_CREDIT_RESUME_BYTES: usize = 64 * 1024;
const TERMINAL_OUTPUT_CREDIT_WAIT_POLL: Duration = Duration::from_millis(100);

// The reader drains the PTY with a large buffer and the emitter
// aggregates decoded chunks into batches of at most 64 KiB or 4 ms before
// sending them to the owning webview, which cuts the IPC event count
// dramatically during output bursts.
const TERMINAL_READ_BUFFER_BYTES: usize = 64 * 1024;
const TERMINAL_OUTPUT_BATCH_MAX_BYTES: usize = 64 * 1024;
const TERMINAL_OUTPUT_BATCH_WINDOW: Duration = Duration::from_millis(4);

/// Serialized `terminal-output` payload. `bytes` is the UTF-8 byte
/// length of `data` measured on the Rust side so the frontend never has to
/// re-encode the string just to count bytes for the credit window.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalOutputEvent {
    session_id: String,
    seq: u64,
    generation: u64,
    data: String,
    bytes: usize,
}

/// Time/size aggregator: chunks pushed while a batch is open are
/// concatenated; the batch becomes ready once it reaches `max_bytes` or the
/// `window` has elapsed since the first chunk of the batch.
struct TerminalOutputBatcher {
    max_bytes: usize,
    window: Duration,
    batch: String,
    window_start: Instant,
}

impl TerminalOutputBatcher {
    fn new(max_bytes: usize, window: Duration) -> Self {
        TerminalOutputBatcher {
            max_bytes,
            window,
            batch: String::new(),
            window_start: Instant::now(),
        }
    }

    fn push(&mut self, chunk: &str) {
        if self.batch.is_empty() {
            self.window_start = Instant::now();
        }
        self.batch.push_str(chunk);
    }

    fn is_ready(&self, now: Instant) -> bool {
        !self.batch.is_empty()
            && (self.batch.len() >= self.max_bytes
                || now.duration_since(self.window_start) >= self.window)
    }

    /// How long the aggregator may still wait for more chunks; `None` once the
    /// batch is ready to flush.
    fn remaining_window(&self, now: Instant) -> Option<Duration> {
        if self.is_ready(now) {
            return None;
        }
        Some(self.window - now.duration_since(self.window_start))
    }

    fn take(&mut self) -> String {
        std::mem::take(&mut self.batch)
    }
}

/// Splits an oversized batch into pieces of at most `max_bytes`, never cutting
/// a UTF-8 code point.
fn split_terminal_batch(batch: &str, max_bytes: usize) -> Vec<String> {
    let mut pieces = Vec::new();
    let mut rest = batch;
    while !rest.is_empty() {
        let mut take = rest.len().min(max_bytes);
        while take > 0 && !rest.is_char_boundary(take) {
            take -= 1;
        }
        if take == 0 {
            take = rest.chars().next().map(char::len_utf8).unwrap_or(1);
        }
        pieces.push(rest[..take].to_string());
        rest = &rest[take..];
    }
    pieces
}

/// Allocates one sequence per piece and sends it only to the owning
/// window's per-session channel, preserving the ordered, owner-directed
/// delivery the credit window relies on.
fn emit_terminal_batch(
    channel: &Channel<TerminalOutputEvent>,
    session_id: &str,
    generation: u64,
    flow: &TerminalOutputFlow,
    batch: &str,
) {
    for piece in split_terminal_batch(batch, TERMINAL_OUTPUT_BATCH_MAX_BYTES) {
        let seq = flow.alloc(piece.len());
        let _ = channel.send(TerminalOutputEvent {
            session_id: session_id.to_string(),
            seq,
            generation,
            bytes: piece.len(),
            data: piece,
        });
    }
}

/// Emitter thread: receives decoded chunks from the reader, aggregates
/// them for at most `TERMINAL_OUTPUT_BATCH_WINDOW` or
/// `TERMINAL_OUTPUT_BATCH_MAX_BYTES`, then flushes. Returns once the reader
/// disconnects and the final batch has been emitted.
fn terminal_output_emit_loop(
    receiver: Receiver<String>,
    channel: Channel<TerminalOutputEvent>,
    session_id: String,
    generation: u64,
    terminal: Arc<TerminalSession>,
) {
    let mut batcher = TerminalOutputBatcher::new(
        TERMINAL_OUTPUT_BATCH_MAX_BYTES,
        TERMINAL_OUTPUT_BATCH_WINDOW,
    );
    loop {
        match receiver.recv() {
            Ok(chunk) => batcher.push(&chunk),
            Err(_) => return,
        }
        while let Some(remaining) = batcher.remaining_window(Instant::now()) {
            match receiver.recv_timeout(remaining) {
                Ok(chunk) => batcher.push(&chunk),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    let batch = batcher.take();
                    emit_terminal_batch(
                        &channel,
                        &session_id,
                        generation,
                        &terminal.output_flow,
                        &batch,
                    );
                    return;
                }
            }
        }
        let batch = batcher.take();
        emit_terminal_batch(
            &channel,
            &session_id,
            generation,
            &terminal.output_flow,
            &batch,
        );
    }
}

static TERMINAL_SESSION_GENERATION: AtomicU64 = AtomicU64::new(1);

fn next_terminal_generation() -> u64 {
    TERMINAL_SESSION_GENERATION.fetch_add(1, Ordering::Relaxed)
}

struct TerminalOutputFlow {
    generation: u64,
    state: Mutex<TerminalOutputFlowState>,
    credit_available: Condvar,
}

struct TerminalOutputFlowState {
    next_seq: u64,
    unacked: BTreeMap<u64, usize>,
    in_flight_bytes: usize,
    throttled: bool,
    stopped: bool,
}

impl TerminalOutputFlow {
    fn new(generation: u64) -> Self {
        TerminalOutputFlow {
            generation,
            state: Mutex::new(TerminalOutputFlowState {
                next_seq: 1,
                unacked: BTreeMap::new(),
                in_flight_bytes: 0,
                throttled: false,
                stopped: false,
            }),
            credit_available: Condvar::new(),
        }
    }

    fn generation(&self) -> u64 {
        self.generation
    }

    #[cfg(test)]
    fn in_flight_bytes(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .in_flight_bytes
    }

    /// Assigns the next output sequence and records `byte_len` (UTF-8 bytes,
    /// never JavaScript UTF-16 lengths) as un-ACKed credit usage.
    fn alloc(&self, byte_len: usize) -> u64 {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let seq = state.next_seq;
        state.next_seq += 1;
        state.unacked.insert(seq, byte_len);
        state.in_flight_bytes += byte_len;
        seq
    }

    /// Blocks the reader while the consumer owes more than the credit limit.
    /// Once throttled, the reader only resumes after the ACKed backlog drops
    /// below the resume threshold, which avoids read/write oscillation.
    fn wait_for_credit(&self, stop_requested: &AtomicBool) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            if state.stopped || stop_requested.load(Ordering::Acquire) {
                return;
            }
            if state.throttled {
                if state.in_flight_bytes <= TERMINAL_OUTPUT_CREDIT_RESUME_BYTES {
                    state.throttled = false;
                    return;
                }
            } else if state.in_flight_bytes < TERMINAL_OUTPUT_CREDIT_LIMIT_BYTES {
                return;
            } else {
                state.throttled = true;
            }
            let (next, _) = self
                .credit_available
                .wait_timeout(state, TERMINAL_OUTPUT_CREDIT_WAIT_POLL)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state = next;
        }
    }

    /// Credits consumed output. `up_to_seq` acknowledges every emitted
    /// sequence up to and including it; `bytes` must equal the sum of the
    /// actual UTF-8 byte counts recorded for those sequences. Duplicate,
    /// out-of-range, wrong-generation and byte-mismatched acknowledgments
    /// are rejected so a confused consumer cannot corrupt the window.
    fn ack(&self, generation: u64, up_to_seq: u64, bytes: usize) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.stopped {
            return Ok(());
        }
        if generation != self.generation {
            return Err(
                "Terminal output acknowledgment has an unknown session generation.".to_string(),
            );
        }
        if up_to_seq == 0 || up_to_seq >= state.next_seq {
            return Err("Terminal output acknowledgment is out of range.".to_string());
        }
        let credited: usize = state.unacked.range(..=up_to_seq).map(|(_, len)| *len).sum();
        if credited == 0 {
            return Err("Terminal output acknowledgment was already received.".to_string());
        }
        if credited != bytes {
            return Err(
                "Terminal output acknowledgment byte count does not match the emitted output."
                    .to_string(),
            );
        }
        let seqs: Vec<u64> = state
            .unacked
            .range(..=up_to_seq)
            .map(|(seq, _)| *seq)
            .collect();
        for seq in seqs {
            let len = state
                .unacked
                .remove(&seq)
                .expect("sequence was present in the credited range");
            state.in_flight_bytes = state.in_flight_bytes.saturating_sub(len);
        }
        self.credit_available.notify_all();
        Ok(())
    }

    /// Wakes a reader that is waiting for credit during teardown.
    fn request_stop(&self) {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .stopped = true;
        self.credit_available.notify_all();
    }
}

struct TerminalProcessTree {
    #[cfg(all(unix, not(target_os = "linux")))]
    process_group: u32,
    #[cfg(target_os = "linux")]
    linux_session: super::process_group::LinuxTerminalSession,
    #[cfg(windows)]
    job: isize,
    #[cfg(windows)]
    process_id: u32,
    #[cfg(windows)]
    _startup_gate: Option<TerminalBootstrapGate>,
}

#[tauri::command]
pub(crate) async fn terminal_start(
    workspace: String,
    working_directory: Option<String>,
    rows: u16,
    cols: u16,
    events: Channel<TerminalOutputEvent>,
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    quit_gate: State<'_, QuitGateState>,
) -> Result<String, String> {
    let admission = quit_gate.admit_resource_operation(window.label())?;
    let terminals = Arc::clone(&state.terminals);
    let lifecycle = Arc::clone(&state.terminal_lifecycle);
    let cancellation = lifecycle.reserve(window.label())?;
    run_blocking(
        "Unable to start terminal",
        BlockingClass::Terminal,
        move || {
            let _admission = admission;
            terminal_start_sync(
                workspace,
                working_directory,
                rows,
                cols,
                events,
                app,
                window,
                terminals,
                lifecycle,
                cancellation,
            )
        },
    )
    .await
}

fn terminal_start_sync(
    workspace: String,
    working_directory: Option<String>,
    rows: u16,
    cols: u16,
    events: Channel<TerminalOutputEvent>,
    app: AppHandle,
    window: tauri::WebviewWindow,
    terminals: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
    lifecycle: Arc<TerminalLifecycle>,
    cancellation: Arc<AtomicBool>,
) -> Result<String, String> {
    if rows == 0 || cols == 0 {
        return Err("Terminal size must be greater than zero.".to_string());
    }
    let working_directory =
        terminal_working_directory(working_directory.as_deref().unwrap_or(&workspace))?;
    if cancellation.load(Ordering::Acquire) {
        return Err("The terminal window has closed.".to_string());
    }
    let owner_window = window.label().to_string();
    let id = Uuid::new_v4().to_string();
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Unable to create terminal. {error}"))?;
    let shell = if cfg!(windows) {
        std::env::var("ComSpec").unwrap_or_else(|_| "powershell.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    };
    #[cfg(windows)]
    let mut bootstrap_gate = TerminalBootstrapGate::new()
        .map_err(|error| format!("Unable to prepare the terminal startup gate. {error}"))?;
    #[cfg(windows)]
    let mut command = {
        let executable = std::env::current_exe()
            .map_err(|error| {
                format!("Unable to locate the terminal bootstrap executable. {error}")
            })?
            .with_file_name("pude-terminal-bootstrap.exe");
        let mut command = CommandBuilder::new(executable);
        command.arg(bootstrap_gate.name());
        command.arg(shell.as_str());
        command.arg(working_directory.as_os_str());
        command
    };
    // A login shell loads the user's profile and /etc/paths.d, which a GUI-launched app
    // (PATH=/usr/bin:/bin:/usr/sbin:/sbin) otherwise misses; Terminal.app does the same.
    #[cfg(unix)]
    let mut command = {
        let mut command = CommandBuilder::new(shell);
        command.arg("-l");
        if std::env::var_os("LANG").is_none() && std::env::var_os("LC_ALL").is_none() {
            command.env("LANG", "en_US.UTF-8");
        }
        command
    };
    command.cwd(&working_directory);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    let python_environment =
        python_environment::activate_project_environment(&mut command, &working_directory);
    #[cfg(target_os = "linux")]
    super::process_group::LinuxTerminalSession::check_supported()
        .map_err(|error| format!("Unable to prepare terminal process cleanup. {error}"))?;
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Unable to start terminal. {error}"))?;
    #[cfg(windows)]
    let process_tree = match TerminalProcessTree::attach(child.as_ref(), Some(&mut bootstrap_gate))
    {
        Ok(mut process_tree) => {
            process_tree._startup_gate = Some(bootstrap_gate);
            process_tree
        }
        Err(error) => {
            let tree_cleanup = match terminate_untracked_terminal_tree(child.as_ref()) {
                Ok(()) => "Terminal process-tree fallback completed.".to_string(),
                Err(error) => format!("Terminal process-tree fallback failed: {error}"),
            };
            let cleanup = match terminate_terminal_child(child.as_mut()) {
                Ok(status) => format!("Terminal process was stopped: {status}."),
                Err(cleanup) => format!("Terminal process cleanup failed: {cleanup}"),
            };
            return Err(format!(
                "Unable to attach the terminal process to its cleanup scope. {error} {tree_cleanup} {cleanup}"
            ));
        }
    };
    #[cfg(unix)]
    let process_tree = match TerminalProcessTree::attach(child.as_ref()) {
        Ok(process_tree) => process_tree,
        Err(error) => {
            let tree_cleanup = match terminate_untracked_terminal_tree(child.as_ref()) {
                Ok(()) => "Terminal process-tree fallback completed.".to_string(),
                Err(error) => format!("Terminal process-tree fallback failed: {error}"),
            };
            let cleanup = match terminate_terminal_child(child.as_mut()) {
                Ok(status) => format!("Terminal process was stopped: {status}."),
                Err(cleanup) => format!("Terminal process cleanup failed: {cleanup}"),
            };
            return Err(format!(
                "Unable to attach the terminal process to its cleanup scope. {error} {tree_cleanup} {cleanup}"
            ));
        }
    };
    drop(pair.slave);
    let master = pair.master;
    let terminal = Arc::new(TerminalSession {
        master: Mutex::new(Some(master)),
        writer: Mutex::new(None),
        child: Mutex::new(Some(child)),
        process_tree: Mutex::new(Some(process_tree)),
        #[cfg(windows)]
        writer_thread_id: AtomicU32::new(0),
        reader_thread: Mutex::new(None),
        process_watcher: Mutex::new(None),
        stop_lock: Mutex::new(()),
        stop_requested: AtomicBool::new(false),
        reader_finished: Arc::new(AtomicBool::new(false)),
        owner_window,
        output_flow: TerminalOutputFlow::new(next_terminal_generation()),
        output_channel: events,
    });
    let reader = terminal
        .master
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .expect("new terminal master")
        .try_clone_reader();
    let mut reader = match reader {
        Ok(reader) => reader,
        Err(error) => {
            return Err(cleanup_failed_terminal_start(
                &id,
                &terminals,
                &terminal,
                &lifecycle,
                format!("Unable to read terminal. {error}"),
            ));
        }
    };
    let writer = terminal
        .master
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .expect("new terminal master")
        .take_writer();
    match writer {
        Ok(writer) => {
            *terminal
                .writer
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(writer)
        }
        Err(error) => {
            drop(reader);
            return Err(cleanup_failed_terminal_start(
                &id,
                &terminals,
                &terminal,
                &lifecycle,
                format!("Unable to write terminal. {error}"),
            ));
        }
    }
    let session_id = id.clone();
    let reader_finished = Arc::clone(&terminal.reader_finished);
    let reader_terminal = Arc::clone(&terminal);
    let (reader_ready, begin_reading) = sync_channel(0);
    let reader_thread = thread::Builder::new()
        .name(format!("pude-terminal-reader-{}", &session_id[..8]))
        .spawn(move || {
            let _completion = TerminalReaderCompletion(reader_finished);
            if begin_reading.recv().is_err() {
                return;
            }
            let generation = reader_terminal.output_flow.generation();
            // Decoded chunks are handed to a dedicated emitter thread
            // that aggregates them before emitting; the channel holds at most
            // one chunk, so read-ahead beyond the credit window stays bounded
            // by a single read buffer.
            let (chunk_sender, chunk_receiver) = sync_channel::<String>(1);
            let emitter_channel = reader_terminal.output_channel.clone();
            let emitter_session_id = session_id.clone();
            let emitter_terminal = Arc::clone(&reader_terminal);
            let emitter = thread::Builder::new()
                .name(format!("pude-terminal-emit-{}", &session_id[..8]))
                .spawn(move || {
                    terminal_output_emit_loop(
                        chunk_receiver,
                        emitter_channel,
                        emitter_session_id,
                        generation,
                        emitter_terminal,
                    );
                });
            let emitter = match emitter {
                Ok(emitter) => Some(emitter),
                Err(error) => {
                    crate::app_log::log_error(&format!(
                        "Unable to start terminal output emitter. {error}"
                    ));
                    None
                }
            };
            let result = read_terminal_chunks(
                &mut reader,
                &reader_terminal.output_flow,
                &reader_terminal.stop_requested,
                |data| match &emitter {
                    Some(_) => chunk_sender.send(data).is_ok(),
                    None => {
                        emit_terminal_batch(
                            &reader_terminal.output_channel,
                            &session_id,
                            generation,
                            &reader_terminal.output_flow,
                            &data,
                        );
                        true
                    }
                },
            );
            if let Err(error) = result {
                crate::app_log::log_error(&format!(
                    "Terminal PTY reader stopped after an I/O error: {error}"
                ));
            }
            drop(chunk_sender);
            if let Some(emitter) = emitter {
                let _ = emitter.join();
            }
        });
    let reader_thread = match reader_thread {
        Ok(thread) => thread,
        Err(error) => {
            let message = format!("Unable to start terminal reader. {error}");
            return Err(cleanup_failed_terminal_start(
                &id, &terminals, &terminal, &lifecycle, message,
            ));
        }
    };
    *terminal
        .reader_thread
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(reader_thread);

    let watcher_app = app.clone();
    let watcher_session = Arc::clone(&terminal);
    let watcher_session_id = id.clone();
    let (watcher_ready, begin_watching) = sync_channel(0);
    let watcher_thread = match thread::Builder::new()
        .name(format!("pude-terminal-watch-{}", &watcher_session_id[..8]))
        .spawn(move || {
            if begin_watching.recv().is_err() {
                return;
            }
            watch_terminal_process(watcher_app, watcher_session_id, watcher_session);
        }) {
        Ok(thread) => thread,
        Err(error) => {
            let _ = reader_ready.send(());
            let message = format!("Unable to start terminal process monitor. {error}");
            return Err(cleanup_failed_terminal_start(
                &id, &terminals, &terminal, &lifecycle, message,
            ));
        }
    };
    *terminal
        .process_watcher
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(watcher_thread);
    if !lifecycle.register_if_open(&terminals, &id, &terminal) {
        drop(reader_ready);
        drop(watcher_ready);
        return Err(cleanup_failed_terminal_start(
            &id,
            &terminals,
            &terminal,
            &lifecycle,
            "The terminal window closed while its process was starting.".to_string(),
        ));
    }
    if let Err(error) = reader_ready.send(()) {
        drop(watcher_ready);
        let message = format!("Unable to start terminal reader. {error}");
        return Err(cleanup_failed_terminal_start(
            &id, &terminals, &terminal, &lifecycle, message,
        ));
    }
    if let Err(error) = watcher_ready.send(()) {
        let message = format!("Unable to start terminal process monitor. {error}");
        return Err(cleanup_failed_terminal_start(
            &id, &terminals, &terminal, &lifecycle, message,
        ));
    }
    if let Some(environment) = python_environment {
        let label = environment
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        let message = format!("Python environment active: {label}\r\n");
        let seq = terminal.output_flow.alloc(message.len());
        let generation = terminal.output_flow.generation();
        let bytes = message.len();
        let _ = terminal.output_channel.send(TerminalOutputEvent {
            session_id: id.clone(),
            seq,
            generation,
            bytes,
            data: message,
        });
    }
    Ok(id)
}

fn terminal_working_directory(workspace: &str) -> Result<PathBuf, String> {
    let path = decode_wire_path(workspace);
    if path.is_dir() {
        return Ok(path);
    }
    if !workspace.trim().is_empty() {
        return Err("The terminal workspace is no longer available.".to_string());
    }
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .filter(|home| home.is_dir())
        .or_else(|| std::env::current_dir().ok())
        .ok_or_else(|| "Unable to locate a working directory for the terminal.".to_string())
}

#[cfg(all(test, unix))]
fn stop_previous_window_terminals(
    terminals: &Mutex<HashMap<String, Arc<TerminalSession>>>,
    owner_window: &str,
) -> Result<(), String> {
    let previous = take_window_terminals(terminals, owner_window)?;
    for (previous_id, terminal) in previous {
        if let Err(error) = stop_terminal_session(&terminal) {
            if let Ok(mut sessions) = terminals.lock() {
                sessions.insert(previous_id, Arc::clone(&terminal));
            }
            return Err(format!("Unable to replace the previous terminal. {error}"));
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn terminal_write(
    session_id: String,
    data: String,
    binary: bool,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    quit_gate: State<'_, QuitGateState>,
) -> Result<(), String> {
    let admission = quit_gate.admit_resource_operation(window.label())?;
    let data = terminal_input_bytes(&data, binary)?;
    let terminals = Arc::clone(&state.terminals);
    let resource = format!("write:{session_id}");
    run_blocking_resource(
        "Unable to write terminal input",
        BlockingClass::Terminal,
        resource,
        move || {
            let _admission = admission;
            terminal_write_sync(session_id, data, terminals)
        },
    )
    .await
}

fn terminal_write_sync(
    session_id: String,
    data: Vec<u8>,
    terminals: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
) -> Result<(), String> {
    let terminals = terminals
        .lock()
        .map_err(|_| "Unable to lock terminal state.".to_string())?;
    let terminal = terminals
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "Terminal session not found.".to_string())?;
    drop(terminals);
    ensure_terminal_accepts_input(&terminal)?;
    let mut writer = terminal
        .writer
        .lock()
        .map_err(|_| "Unable to lock terminal writer.".to_string())?;
    let writer = writer
        .as_mut()
        .ok_or_else(|| "Terminal session is stopping.".to_string())?;
    ensure_terminal_accepts_input(&terminal)?;
    #[cfg(windows)]
    let _writer_activity = TerminalWriterActivity::begin(&terminal.writer_thread_id);
    writer
        .write_all(&data)
        .map_err(|error| format!("Unable to write terminal input. {error}"))?;
    writer
        .flush()
        .map_err(|error| format!("Unable to flush terminal input. {error}"))?;
    // Linux may accept master writes after the slave has closed. Report the
    // process state too, including exit racing a successful write/flush.
    ensure_terminal_accepts_input(&terminal)
}

fn ensure_terminal_accepts_input(terminal: &TerminalSession) -> Result<(), String> {
    if terminal.stop_requested.load(Ordering::Acquire) {
        return Err("Unable to write terminal input. Terminal session is stopping.".to_string());
    }
    let mut child = terminal
        .child
        .lock()
        .map_err(|_| "Unable to lock terminal process.".to_string())?;
    let Some(child) = child.as_mut() else {
        return Err("Unable to write terminal input. Terminal process has exited.".to_string());
    };
    if terminal_child_has_exited(child.as_mut())
        .map_err(|error| format!("Unable to inspect terminal process before writing. {error}"))?
    {
        return Err("Unable to write terminal input. Terminal process has exited.".to_string());
    }
    Ok(())
}

fn terminal_child_has_exited(child: &mut (dyn Child + Send)) -> io::Result<bool> {
    terminal_child_exit_status(child).map(|status| status.is_some())
}

fn terminal_child_exit_status(
    child: &mut (dyn Child + Send),
) -> io::Result<Option<portable_pty::ExitStatus>> {
    #[cfg(target_os = "linux")]
    {
        // Reaping frees the SID anchor used to safely find job-control groups.
        // Only the cleanup path may consume this child's exit status on Linux.
        let pid = child.process_id().ok_or_else(|| {
            io::Error::other("The PTY backend did not expose its child process ID.")
        })?;
        loop {
            let mut status = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid,
                    &mut status,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result == 0 {
                if unsafe { status.si_pid() } == 0 {
                    return Ok(None);
                }
                let code = unsafe { status.si_status() };
                let exit = if status.si_code == libc::CLD_EXITED {
                    portable_pty::ExitStatus::with_exit_code(code as u32)
                } else {
                    let name = unsafe { libc::strsignal(code) };
                    let signal = if name.is_null() {
                        format!("Signal {code}")
                    } else {
                        unsafe { std::ffi::CStr::from_ptr(name) }
                            .to_string_lossy()
                            .into_owned()
                    };
                    portable_pty::ExitStatus::with_signal(&signal)
                };
                return Ok(Some(exit));
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    child.try_wait()
}

#[cfg(windows)]
struct TerminalWriterActivity<'a>(&'a AtomicU32);

#[cfg(windows)]
impl<'a> TerminalWriterActivity<'a> {
    fn begin(thread_id: &'a AtomicU32) -> Self {
        thread_id.store(unsafe { GetCurrentThreadId() }, Ordering::Release);
        Self(thread_id)
    }
}

#[cfg(windows)]
impl Drop for TerminalWriterActivity<'_> {
    fn drop(&mut self) {
        self.0.store(0, Ordering::Release);
    }
}

fn terminal_input_bytes(data: &str, binary: bool) -> Result<Vec<u8>, String> {
    if !binary {
        return Ok(data.as_bytes().to_vec());
    }

    data.chars()
        .map(|character| {
            u8::try_from(u32::from(character)).map_err(|_| {
                "Terminal binary input contains a character outside the byte range.".to_string()
            })
        })
        .collect()
}

#[cfg(test)]
mod terminal_input_tests {
    use super::{terminal_input_bytes, terminal_working_directory};

    #[test]
    fn terminal_uses_a_real_directory_without_an_open_workspace() {
        assert!(terminal_working_directory("").unwrap().is_dir());
    }

    #[test]
    fn terminal_uses_the_open_workspace_directory() {
        let workspace =
            std::env::temp_dir().join(format!("pude-terminal-workspace-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&workspace).unwrap();
        assert_eq!(
            terminal_working_directory(workspace.to_str().unwrap()).unwrap(),
            workspace
        );
        std::fs::remove_dir(workspace).unwrap();
    }

    #[test]
    fn terminal_text_input_is_encoded_as_utf8() {
        assert_eq!(
            terminal_input_bytes("繁體中文\r", false).unwrap(),
            "繁體中文\r".as_bytes()
        );
    }

    #[test]
    fn terminal_binary_input_preserves_mouse_report_bytes() {
        assert_eq!(
            terminal_input_bytes("\u{1b}[M\u{00ff}\u{0001}", true).unwrap(),
            [0x1b, b'[', b'M', 0xff, 0x01]
        );
    }

    #[test]
    fn terminal_binary_input_rejects_non_byte_characters() {
        assert!(terminal_input_bytes("\u{100}", true).is_err());
    }
}

#[cfg(test)]
mod terminal_output_channel_tests {
    //! `terminal-output` now travels over a per-session
    //! `tauri::ipc::Channel`. These tests drive `emit_terminal_batch` with a
    //! Rust-side recording channel to prove the payload contract
    //! (sessionId/seq/generation/bytes) survives the channel transport.
    use super::{
        emit_terminal_batch, TerminalOutputEvent, TerminalOutputFlow,
        TERMINAL_OUTPUT_BATCH_MAX_BYTES,
    };
    use std::sync::{Arc, Mutex};
    use tauri::ipc::{Channel, InvokeResponseBody};

    fn recording_channel() -> (
        Channel<TerminalOutputEvent>,
        Arc<Mutex<Vec<InvokeResponseBody>>>,
    ) {
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&bodies);
        let channel = Channel::new(move |body| {
            captured
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(body);
            Ok(())
        });
        (channel, bodies)
    }

    fn json_messages(bodies: &Arc<Mutex<Vec<InvokeResponseBody>>>) -> Vec<serde_json::Value> {
        let bodies = bodies
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        bodies
            .iter()
            .map(|body| {
                let InvokeResponseBody::Json(json) = body else {
                    panic!("channel messages should be JSON");
                };
                serde_json::from_str(json).expect("channel message should be valid JSON")
            })
            .collect()
    }

    #[test]
    fn channel_delivery_keeps_aud05_session_seq_and_bytes_fields() {
        let (channel, bodies) = recording_channel();
        let flow = TerminalOutputFlow::new(7);
        emit_terminal_batch(&channel, "session-1", 7, &flow, "hello");
        let messages = json_messages(&bodies);
        assert_eq!(messages.len(), 1);
        let value = &messages[0];
        assert_eq!(value["sessionId"], "session-1");
        assert_eq!(value["generation"], 7);
        assert_eq!(value["seq"], 1);
        assert_eq!(value["bytes"], 5);
        assert_eq!(value["data"], "hello");
        drop(messages);
        assert_eq!(flow.in_flight_bytes(), 5);
    }

    #[test]
    fn channel_delivery_splits_oversized_batches_and_keeps_sequence_order() {
        let (channel, bodies) = recording_channel();
        let flow = TerminalOutputFlow::new(3);
        let big = "a".repeat(TERMINAL_OUTPUT_BATCH_MAX_BYTES + 10);
        emit_terminal_batch(&channel, "session-2", 3, &flow, &big);
        let messages = json_messages(&bodies);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["seq"], 1);
        assert_eq!(messages[1]["seq"], 2);
        assert_eq!(messages[0]["sessionId"], "session-2");
        assert_eq!(messages[1]["sessionId"], "session-2");
        let total_bytes: usize = messages
            .iter()
            .map(|message| message["bytes"].as_u64().unwrap() as usize)
            .sum();
        assert_eq!(total_bytes, big.len());
        drop(messages);
        assert_eq!(flow.in_flight_bytes(), big.len());
    }
}

#[cfg(test)]
mod terminal_output_flow_tests {
    use super::{
        TerminalOutputFlow, TERMINAL_OUTPUT_CREDIT_LIMIT_BYTES, TERMINAL_OUTPUT_CREDIT_RESUME_BYTES,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    fn utf8_bytes(text: &str) -> usize {
        text.len()
    }

    #[test]
    fn alloc_assigns_increasing_sequences_and_records_unacked_bytes() {
        let flow = TerminalOutputFlow::new(7);
        assert_eq!(flow.generation(), 7);
        let first = flow.alloc(utf8_bytes("hello"));
        let second = flow.alloc(utf8_bytes("繁體中文"));
        assert_eq!((first, second), (1, 2));
        assert_eq!(
            flow.in_flight_bytes(),
            utf8_bytes("hello") + utf8_bytes("繁體中文")
        );
    }

    #[test]
    fn ack_credits_the_actual_emitted_utf8_byte_count() {
        let flow = TerminalOutputFlow::new(1);
        let first = flow.alloc(utf8_bytes("ab"));
        let second = flow.alloc(utf8_bytes("繁體"));
        flow.ack(1, second, utf8_bytes("ab") + utf8_bytes("繁體"))
            .expect("batch acknowledgment should credit both sequences");
        assert_eq!(flow.in_flight_bytes(), 0);
        let _ = first;
    }

    #[test]
    fn ack_rejects_an_out_of_range_sequence() {
        let flow = TerminalOutputFlow::new(1);
        let seq = flow.alloc(3);
        assert!(flow.ack(1, seq + 1, 3).is_err());
        assert!(flow.ack(1, 0, 0).is_err());
        assert_eq!(flow.in_flight_bytes(), 3);
    }

    #[test]
    fn ack_rejects_duplicate_acknowledgments() {
        let flow = TerminalOutputFlow::new(1);
        let seq = flow.alloc(3);
        flow.ack(1, seq, 3).expect("first acknowledgment");
        assert!(flow.ack(1, seq, 3).is_err());
        assert_eq!(flow.in_flight_bytes(), 0);
    }

    #[test]
    fn ack_rejects_a_byte_count_that_mismatches_the_emitted_output() {
        let flow = TerminalOutputFlow::new(1);
        let seq = flow.alloc(utf8_bytes("繁體中文"));
        assert!(flow.ack(1, seq, 4).is_err());
        assert_eq!(
            flow.in_flight_bytes(),
            utf8_bytes("繁體中文"),
            "a rejected acknowledgment must not consume credit"
        );
    }

    #[test]
    fn ack_rejects_a_foreign_session_generation() {
        let flow = TerminalOutputFlow::new(9);
        let seq = flow.alloc(2);
        assert!(flow.ack(8, seq, 2).is_err());
        flow.ack(9, seq, 2).expect("matching generation");
    }

    #[test]
    fn ack_after_stop_is_a_noop_so_teardown_races_stay_quiet() {
        let flow = TerminalOutputFlow::new(1);
        let seq = flow.alloc(2);
        flow.request_stop();
        flow.ack(1, seq, 2)
            .expect("stopped flow ignores acknowledgments");
    }

    #[test]
    fn a_full_window_blocks_the_reader_until_acks_drop_below_the_resume_threshold() {
        let flow = Arc::new(TerminalOutputFlow::new(1));
        let first = flow.alloc(TERMINAL_OUTPUT_CREDIT_LIMIT_BYTES);
        let second = flow.alloc(TERMINAL_OUTPUT_CREDIT_RESUME_BYTES * 2);
        let stop = Arc::new(AtomicBool::new(false));
        let (done_sender, done_receiver) = std::sync::mpsc::channel();
        let waiter_stop = Arc::clone(&stop);
        let waiter = {
            let flow = Arc::clone(&flow);
            thread::spawn(move || {
                flow.wait_for_credit(&waiter_stop);
                let _ = done_sender.send(());
            })
        };
        thread::sleep(Duration::from_millis(100));
        assert!(
            done_receiver.try_recv().is_err(),
            "the reader must wait while the window is full"
        );

        flow.ack(1, first, TERMINAL_OUTPUT_CREDIT_LIMIT_BYTES)
            .expect("credit the first chunk");
        thread::sleep(Duration::from_millis(100));
        assert!(
            done_receiver.try_recv().is_err(),
            "a throttled window stays closed until the backlog is at or below the resume threshold"
        );

        flow.ack(1, second, TERMINAL_OUTPUT_CREDIT_RESUME_BYTES * 2)
            .expect("credit the second chunk");
        done_receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("the reader should resume once the backlog drops to the resume threshold");
        waiter.join().expect("waiter thread should exit");
        let _ = stop;
    }

    #[test]
    fn request_stop_wakes_a_reader_waiting_for_credit() {
        let flow = Arc::new(TerminalOutputFlow::new(1));
        let seq = flow.alloc(TERMINAL_OUTPUT_CREDIT_LIMIT_BYTES);
        let stop = Arc::new(AtomicBool::new(false));
        let (done_sender, done_receiver) = std::sync::mpsc::channel();
        let waiter_stop = Arc::clone(&stop);
        let waiter = {
            let flow = Arc::clone(&flow);
            thread::spawn(move || {
                flow.wait_for_credit(&waiter_stop);
                let _ = done_sender.send(());
            })
        };
        thread::sleep(Duration::from_millis(100));
        assert!(done_receiver.try_recv().is_err());

        let started = std::time::Instant::now();
        flow.request_stop();
        done_receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("stop should wake the credit waiter");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the credit waiter should return promptly after stop"
        );
        waiter.join().expect("waiter thread should exit");
        let _ = seq;
    }

    #[test]
    fn wait_for_credit_passes_through_while_under_the_limit() {
        let flow = TerminalOutputFlow::new(1);
        flow.alloc(TERMINAL_OUTPUT_CREDIT_LIMIT_BYTES - 1);
        let stop = AtomicBool::new(false);
        let started = std::time::Instant::now();
        flow.wait_for_credit(&stop);
        assert!(
            started.elapsed() < Duration::from_millis(50),
            "an uncongested window should not block the reader"
        );
        assert!(!stop.load(Ordering::Acquire));
    }
}

#[cfg(test)]
mod terminal_output_batch_tests {
    use super::{
        split_terminal_batch, TerminalOutputBatcher, TERMINAL_OUTPUT_BATCH_MAX_BYTES,
        TERMINAL_OUTPUT_BATCH_WINDOW,
    };
    use std::time::{Duration, Instant};

    #[test]
    fn small_outputs_are_aggregated_until_the_batch_window_ends() {
        let mut batcher = TerminalOutputBatcher::new(1024, Duration::from_millis(50));
        batcher.push("hello");
        batcher.push(" ");
        batcher.push("world");
        // Anchor on the batcher's own window start instead of a timestamp
        // captured before the pushes, so the assertions stay deterministic
        // even when the test thread is descheduled mid-test.
        let window_start = batcher.window_start;
        assert!(
            !batcher.is_ready(window_start),
            "small chunks inside the window must keep aggregating"
        );
        assert!(
            batcher.is_ready(window_start + Duration::from_millis(50)),
            "the batch must flush once the window has elapsed"
        );
        assert_eq!(batcher.take(), "hello world");
        assert!(!batcher.is_ready(window_start + Duration::from_secs(1)));
    }

    #[test]
    fn the_batch_flushes_as_soon_as_it_reaches_the_size_cap() {
        let mut batcher = TerminalOutputBatcher::new(8, Duration::from_secs(60));
        batcher.push("abc");
        assert!(!batcher.is_ready(Instant::now()));
        assert!(
            batcher.remaining_window(Instant::now()).is_some(),
            "a small batch may still wait for more chunks"
        );
        batcher.push("defghij");
        assert!(
            batcher.is_ready(Instant::now()),
            "reaching the size cap must flush immediately"
        );
        assert_eq!(batcher.take().len(), 10);
        assert!(!batcher.is_ready(Instant::now()));
    }

    #[test]
    fn a_chunk_larger_than_the_cap_is_split_at_a_utf8_boundary() {
        let cjk = "繁"; // 3 UTF-8 bytes
        let oversized = cjk.repeat(TERMINAL_OUTPUT_BATCH_MAX_BYTES / 3 + 10);
        let pieces = split_terminal_batch(&oversized, TERMINAL_OUTPUT_BATCH_MAX_BYTES);
        assert!(
            pieces.len() >= 2,
            "an oversized batch must be split into pieces"
        );
        assert!(
            pieces
                .iter()
                .all(|piece| piece.len() <= TERMINAL_OUTPUT_BATCH_MAX_BYTES),
            "no piece may exceed the batch cap"
        );
        assert_eq!(pieces.concat(), oversized, "splitting must not lose data");
    }

    #[test]
    fn the_production_window_is_about_four_milliseconds() {
        assert_eq!(TERMINAL_OUTPUT_BATCH_WINDOW, Duration::from_millis(4));
        assert_eq!(TERMINAL_OUTPUT_BATCH_MAX_BYTES, 64 * 1024);
    }
}

#[cfg(all(test, unix))]
mod terminal_unix_output_tests {
    use super::{
        read_terminal_output, stop_terminal_session, terminal_write_sync, TerminalOutputFlow,
        TerminalProcessTree, TerminalSession, TERMINAL_OUTPUT_CREDIT_LIMIT_BYTES,
        TERMINAL_READ_BUFFER_BYTES,
    };
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::collections::HashMap;
    use std::io::{self, Read};
    use std::sync::atomic::AtomicBool;
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    struct ProcessGroupCleanup(u32);

    impl Drop for ProcessGroupCleanup {
        fn drop(&mut self) {
            unsafe {
                let _ = libc::kill(-(self.0 as i32), libc::SIGKILL);
            }
        }
    }

    #[test]
    fn real_pty_backpressure_preserves_output_sequence_and_the_final_marker() {
        const END_MARKER: &str = "PUDE_N14_ORDERED_END_MARKER";
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("PTY should open");
        let master = pair.master;
        let mut command = CommandBuilder::new("/bin/sh");
        command.args([
            "-c",
            "/usr/bin/yes PUDE_N14_LINE | /usr/bin/head -c 1048576; printf '\\nPUDE_N14_ORDERED_END_MARKER\\n'",
        ]);
        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("PTY producer should start");
        let process_id = child.process_id().expect("shell PID should be available");
        let _cleanup = ProcessGroupCleanup(process_id);
        drop(pair.slave);
        let mut reader = master.try_clone_reader().expect("PTY reader should clone");
        let output_flow = Arc::new(TerminalOutputFlow::new(17));
        let stop_requested = Arc::new(AtomicBool::new(false));
        let (output_sender, output_receiver) = mpsc::channel();
        let reader_flow = Arc::clone(&output_flow);
        let reader_stop = Arc::clone(&stop_requested);
        let reader_thread = thread::spawn(move || {
            read_terminal_output(
                &mut reader,
                &reader_flow,
                &reader_stop,
                |seq, generation, data| {
                    output_sender
                        .send((seq, generation, data))
                        .expect("test consumer should stay connected");
                },
            )
        });

        let mut initial_chunks = Vec::new();
        let mut initial_bytes = 0usize;
        let high_water_deadline = Instant::now() + Duration::from_secs(10);
        while output_flow.in_flight_bytes() < TERMINAL_OUTPUT_CREDIT_LIMIT_BYTES {
            assert!(
                Instant::now() < high_water_deadline,
                "PTY output did not fill the credit window"
            );
            let chunk = output_receiver
                .recv_timeout(Duration::from_millis(100))
                .expect("reader should deliver chunks up to the credit limit");
            initial_bytes += chunk.2.len();
            initial_chunks.push(chunk);
        }
        while initial_bytes < output_flow.in_flight_bytes() {
            assert!(
                Instant::now() < high_water_deadline,
                "a PTY output event was not delivered"
            );
            let chunk = output_receiver
                .recv_timeout(Duration::from_millis(100))
                .expect("the final in-flight chunk should be delivered");
            initial_bytes += chunk.2.len();
            initial_chunks.push(chunk);
        }

        let stalled_bytes = output_flow.in_flight_bytes();
        assert!(
            stalled_bytes < TERMINAL_OUTPUT_CREDIT_LIMIT_BYTES + TERMINAL_READ_BUFFER_BYTES,
            "backpressure must stop within one PTY read of the credit limit: {stalled_bytes} bytes"
        );
        thread::sleep(Duration::from_millis(150));
        assert_eq!(output_flow.in_flight_bytes(), stalled_bytes);
        assert!(
            child
                .try_wait()
                .expect("producer status should be readable")
                .is_none(),
            "the child should be backpressured before its final marker"
        );

        let mut output = String::new();
        let mut expected_seq = 1;
        for (seq, generation, data) in &initial_chunks {
            assert_eq!(*generation, 17);
            assert_eq!(*seq, expected_seq, "PTY events must stay in sequence");
            expected_seq += 1;
            output.push_str(data);
            assert!(!output.contains(END_MARKER));
        }
        let last_initial_seq = initial_chunks
            .last()
            .expect("the real PTY should produce output")
            .0;
        output_flow
            .ack(17, last_initial_seq, initial_bytes)
            .expect("consuming the initial window should resume the reader");

        let full_output_deadline = Instant::now() + Duration::from_secs(20);
        loop {
            match output_receiver.recv_timeout(Duration::from_millis(100)) {
                Ok((seq, generation, data)) => {
                    assert_eq!(generation, 17);
                    assert_eq!(seq, expected_seq, "PTY events must stay in sequence");
                    expected_seq += 1;
                    output.push_str(&data);
                    output_flow
                        .ack(17, seq, data.len())
                        .expect("each consumed chunk should release its exact UTF-8 credit");
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    assert!(
                        Instant::now() < full_output_deadline,
                        "PTY output did not reach EOF"
                    );
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        reader_thread
            .join()
            .expect("PTY output reader should finish")
            .expect("PTY EOF should not be reported as a reader fault");
        let status = child.wait().expect("PTY producer should be reaped");
        assert!(status.success(), "PTY producer failed: {status:?}");
        assert!(output.contains(END_MARKER), "final marker was lost");
        assert!(
            output.ends_with(&format!("{END_MARKER}\r\n"))
                || output.ends_with(&format!("{END_MARKER}\n"))
        );
        assert_eq!(output_flow.in_flight_bytes(), 0);
        drop(master);
    }

    #[test]
    fn unexpected_pty_reader_errors_are_returned_for_diagnostics() {
        struct FailedReader;

        impl Read for FailedReader {
            fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "injected PTY read fault",
                ))
            }
        }

        let mut reader = FailedReader;
        let error = read_terminal_output(
            &mut reader,
            &TerminalOutputFlow::new(1),
            &AtomicBool::new(false),
            |_, _, _| panic!("failed reads must not emit terminal output"),
        )
        .expect_err("an unexpected Unix PTY reader error must be visible to the caller");
        assert!(error.to_string().contains("injected PTY read fault"));
    }

    #[test]
    fn a_real_pty_write_after_shell_exit_returns_a_diagnostic() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("PTY should open");
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "exit 0"]);
        let child = pair
            .slave
            .spawn_command(command)
            .expect("PTY shell should start");
        let process_id = child.process_id().expect("shell PID should be available");
        let _cleanup = ProcessGroupCleanup(process_id);
        let process_tree = TerminalProcessTree::attach(child.as_ref()).expect("process group");
        let writer = pair.master.take_writer().expect("PTY writer should open");
        let session = Arc::new(TerminalSession {
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            child: Mutex::new(Some(child)),
            process_tree: Mutex::new(Some(process_tree)),
            reader_thread: Mutex::new(None),
            process_watcher: Mutex::new(None),
            stop_lock: Mutex::new(()),
            stop_requested: AtomicBool::new(false),
            reader_finished: Arc::new(AtomicBool::new(false)),
            owner_window: "unix-write-fault-test".to_string(),
            output_channel: tauri::ipc::Channel::new(|_| Ok(())),
            output_flow: TerminalOutputFlow::new(1),
        });
        drop(pair.slave);

        let exited_deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let exited = super::terminal_child_has_exited(
                session
                    .child
                    .lock()
                    .unwrap()
                    .as_mut()
                    .expect("shell should remain tracked until cleanup")
                    .as_mut(),
            )
            .expect("shell status should be readable without reaping");
            if exited {
                break;
            }
            assert!(
                Instant::now() < exited_deadline,
                "shell did not exit promptly"
            );
            thread::sleep(Duration::from_millis(10));
        }

        let session_id = "real-pty-write-fault".to_string();
        let terminals = Arc::new(Mutex::new(HashMap::from([(
            session_id.clone(),
            Arc::clone(&session),
        )])));
        let error = terminal_write_sync(session_id, b"late input\n".to_vec(), terminals)
            .expect_err("input after the shell exits should fail even if the PTY accepts it");
        assert!(
            error.contains("Unable to write terminal input")
                || error.contains("Unable to flush terminal input"),
            "unexpected PTY write diagnostic: {error}"
        );
        stop_terminal_session(&session).expect("closed PTY resources should clean up");
    }
}

#[cfg(all(test, windows))]
mod terminal_pty_tests {
    use super::{TerminalBootstrapGate, TerminalProcessTree};
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::fs;
    use std::io::{Read, Write};
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    #[test]
    fn powershell_runs_a_command_through_the_native_pty() {
        run_native_pty_smoke(false);
    }

    #[test]
    fn console_bootstrap_runs_a_command_through_the_native_pty() {
        run_native_pty_smoke(true);
    }

    fn run_native_pty_smoke(use_bootstrap: bool) {
        let workspace = std::env::temp_dir().join(format!(
            "pude-terminal-pty-workspace-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&workspace).unwrap();
        // temp_dir() can be an 8.3 short path while PowerShell prints the long one,
        // so match the unique folder name instead of the whole path.
        let workspace_name = workspace
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_lowercase();
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("ConPTY should open");
        let mut gate = use_bootstrap.then(|| TerminalBootstrapGate::new().expect("startup gate"));
        let mut command = if let Some(gate) = gate.as_ref() {
            let mut command = CommandBuilder::new(env!("PUDE_TERMINAL_BOOTSTRAP_EXE"));
            command.arg(gate.name());
            command.arg("powershell.exe");
            command.arg(&workspace);
            command
        } else {
            CommandBuilder::new("powershell.exe")
        };
        command.args(["-NoLogo", "-NoProfile"]);
        command.cwd(&workspace);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("PowerShell should start");
        let _process_tree = gate.as_mut().map(|gate| {
            TerminalProcessTree::attach(child.as_ref(), Some(gate))
                .expect("attach before releasing startup gate")
        });
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .expect("PTY reader should clone");
        let (output_sender, output_receiver) = mpsc::channel();
        let reader_thread = thread::spawn(move || {
            let mut buffer = [0_u8; 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(size) => {
                        if output_sender.send(buffer[..size].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        let mut writer = pair
            .master
            .take_writer()
            .expect("PTY writer should be available");
        thread::sleep(Duration::from_millis(500));
        writer
            .write_all(b"Write-Output 'PUDE_TERMINAL_SMOKE_OK'; (Get-Location).Path; exit\r\n")
            .expect("PowerShell command should be written");
        writer.flush().expect("PowerShell input should be flushed");

        let deadline = Instant::now() + Duration::from_secs(15);
        let mut output = Vec::new();
        let mut cursor_report_sent = false;
        while Instant::now() < deadline {
            match output_receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(bytes) => output.extend(bytes),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if !cursor_report_sent
                && output
                    .windows(b"\x1b[6n".len())
                    .any(|window| window == b"\x1b[6n")
            {
                writer
                    .write_all(b"\x1b[1;1R")
                    .expect("terminal cursor report should be written");
                writer
                    .flush()
                    .expect("terminal cursor report should be flushed");
                cursor_report_sent = true;
            }
            if output
                .windows(b"PUDE_TERMINAL_SMOKE_OK".len())
                .any(|window| window == b"PUDE_TERMINAL_SMOKE_OK")
                && String::from_utf8_lossy(&output)
                    .to_lowercase()
                    .contains(&workspace_name)
            {
                break;
            }
        }

        let _ = child.kill();
        let _ = child.wait();
        drop(writer);
        drop(pair.master);
        reader_thread.join().expect("PTY reader should stop");
        assert!(
            String::from_utf8_lossy(&output).contains("PUDE_TERMINAL_SMOKE_OK"),
            "PowerShell PTY output did not contain the command result: {}",
            String::from_utf8_lossy(&output)
        );
        assert!(
            String::from_utf8_lossy(&output)
                .to_lowercase()
                .contains(&workspace_name),
            "PowerShell did not start in the selected workspace: {}",
            String::from_utf8_lossy(&output)
        );
        fs::remove_dir(workspace).unwrap();
    }
}

#[cfg(test)]
mod terminal_window_cleanup_tests {
    use super::{cleanup_failed_terminal_start, take_window_terminals, TerminalSession};
    use crate::AppState;
    use std::collections::HashMap;
    use std::sync::atomic::AtomicBool;
    #[cfg(windows)]
    use std::sync::atomic::AtomicU32;
    use std::sync::{Arc, Mutex};

    fn session(owner_window: &str) -> Arc<TerminalSession> {
        Arc::new(TerminalSession {
            master: Mutex::new(None),
            writer: Mutex::new(None),
            child: Mutex::new(None),
            process_tree: Mutex::new(None),
            #[cfg(windows)]
            writer_thread_id: AtomicU32::new(0),
            reader_thread: Mutex::new(None),
            process_watcher: Mutex::new(None),
            stop_lock: Mutex::new(()),
            stop_requested: AtomicBool::new(false),
            reader_finished: Arc::new(AtomicBool::new(false)),
            owner_window: owner_window.to_string(),
            output_flow: super::TerminalOutputFlow::new(1),
            output_channel: tauri::ipc::Channel::new(|_| Ok(())),
        })
    }

    #[test]
    fn window_cleanup_selects_only_sessions_owned_by_that_window() {
        let sessions = Mutex::new(HashMap::new());
        sessions
            .lock()
            .unwrap()
            .insert("main-1".to_string(), session("main"));
        sessions
            .lock()
            .unwrap()
            .insert("main-2".to_string(), session("main"));
        sessions
            .lock()
            .unwrap()
            .insert("other-1".to_string(), session("other"));

        let removed = take_window_terminals(&sessions, "main").unwrap();

        assert_eq!(removed.len(), 2);
        assert!(removed
            .iter()
            .all(|(_, value)| value.owner_window == "main"));
        assert_eq!(sessions.lock().unwrap().len(), 1);
        assert!(sessions.lock().unwrap().contains_key("other-1"));
    }

    #[test]
    fn destroyed_window_stops_its_sessions_and_preserves_other_windows() {
        let state = AppState::default();
        let main_session = session("main");
        let other_session = session("other");
        state
            .terminals
            .lock()
            .unwrap()
            .insert("main-1".to_string(), Arc::clone(&main_session));
        state
            .terminals
            .lock()
            .unwrap()
            .insert("other-1".to_string(), Arc::clone(&other_session));

        crate::cleanup_window_resources(&state, "main")
            .expect("window terminal cleanup should succeed");

        assert!(main_session
            .stop_requested
            .load(std::sync::atomic::Ordering::Acquire));
        assert!(!other_session
            .stop_requested
            .load(std::sync::atomic::Ordering::Acquire));
        let terminals = state.terminals.lock().unwrap();
        assert!(!terminals.contains_key("main-1"));
        assert!(terminals.contains_key("other-1"));
    }

    #[test]
    fn failed_start_rollback_removes_and_stops_the_partial_session() {
        let state = AppState::default();
        let partial_session = session("main");
        state
            .terminals
            .lock()
            .unwrap()
            .insert("partial-start".to_string(), Arc::clone(&partial_session));

        let message = cleanup_failed_terminal_start(
            "partial-start",
            &state.terminals,
            &partial_session,
            &state.terminal_lifecycle,
            "Unable to start terminal reader.".to_string(),
        );

        assert_eq!(message, "Unable to start terminal reader.");
        assert!(partial_session
            .stop_requested
            .load(std::sync::atomic::Ordering::Acquire));
        assert!(state.terminals.lock().unwrap().is_empty());
    }
}

#[cfg(all(test, unix))]
mod terminal_unix_process_tree_tests {
    use super::{
        stop_previous_window_terminals, stop_terminal_session, stop_terminal_sessions,
        TerminalProcessTree, TerminalSession,
    };
    use crate::{cleanup_window_resources, AppState};
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::collections::HashMap;
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::AtomicBool;
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    static TERMINAL_TREE_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn spawn_test_terminal_session(
        command_text: &str,
        pid_path: &Path,
        owner_window: &str,
    ) -> Arc<TerminalSession> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("PTY should open");
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", command_text]);
        command.env("PUDE_TERMINAL_CHILD_PID", pid_path);
        let child = pair
            .slave
            .spawn_command(command)
            .expect("shell should start");
        let process_tree = TerminalProcessTree::attach(child.as_ref())
            .expect("PTY backend should expose the shell process ID");
        let writer = pair.master.take_writer().expect("PTY writer should open");
        Arc::new(TerminalSession {
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            child: Mutex::new(Some(child)),
            process_tree: Mutex::new(Some(process_tree)),
            #[cfg(windows)]
            writer_thread_id: AtomicU32::new(0),
            reader_thread: Mutex::new(None),
            process_watcher: Mutex::new(None),
            stop_lock: Mutex::new(()),
            stop_requested: AtomicBool::new(false),
            reader_finished: Arc::new(AtomicBool::new(false)),
            owner_window: owner_window.to_string(),
            output_flow: super::TerminalOutputFlow::new(1),
            output_channel: tauri::ipc::Channel::new(|_| Ok(())),
        })
    }

    fn wait_for_child_pid(pid_path: &Path) -> i32 {
        let pid_started = Instant::now();
        while !pid_path.exists() && pid_started.elapsed() < Duration::from_secs(2) {
            thread::sleep(Duration::from_millis(10));
        }
        fs::read_to_string(pid_path)
            .expect("shell child PID file")
            .trim()
            .parse()
            .expect("child PID should be numeric")
    }

    fn process_is_alive(pid: i32) -> std::io::Result<bool> {
        if unsafe { libc::kill(pid, 0) } == 0 {
            return Ok(true);
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(false)
        } else {
            Err(error)
        }
    }

    fn process_group_for(pid: i32) -> std::io::Result<i32> {
        let process_group = unsafe { libc::getpgid(pid) };
        if process_group >= 0 {
            Ok(process_group)
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    fn process_group_is_alive(process_group: i32) -> std::io::Result<bool> {
        if unsafe { libc::kill(-process_group, 0) } == 0 {
            return Ok(true);
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(false)
        } else {
            Err(error)
        }
    }

    fn session_process_group(session: &TerminalSession) -> i32 {
        session
            .child
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .expect("PTY shell should be tracked")
            .process_id()
            .expect("PTY shell should expose its PID") as i32
    }

    fn assert_process_tree_exited(child_pid: i32, process_group: i32) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while (process_is_alive(child_pid).expect("child should be inspectable")
            || process_group_is_alive(process_group).expect("process group should be inspectable"))
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            !process_is_alive(child_pid).expect("child should be inspectable after cleanup"),
            "PTY child {child_pid} survived cleanup"
        );
        assert!(
            !process_group_is_alive(process_group)
                .expect("process group should be inspectable after cleanup"),
            "PTY process group {process_group} survived cleanup"
        );
    }

    struct TestProcessGroup(i32);

    impl Drop for TestProcessGroup {
        fn drop(&mut self) {
            if matches!(process_group_is_alive(self.0), Ok(false)) {
                return;
            }
            unsafe {
                let _ = libc::kill(-self.0, libc::SIGKILL);
            }
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline {
                if matches!(process_group_is_alive(self.0), Ok(false)) {
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
    }

    #[test]
    fn kill_removes_a_shell_child_even_after_the_shell_exits() {
        let _test_lock = TERMINAL_TREE_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let root = std::env::temp_dir().join(format!(
            "pude-terminal-child-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).expect("test directory should be created");
        let pid_path = root.join("child-pid");
        let shell_exit_path = root.join("shell-exit");
        std::env::set_var("PUDE_TERMINAL_SHELL_EXIT", &shell_exit_path);
        let session = spawn_test_terminal_session(
            "trap '' HUP; sleep 4 & echo $! > \"$PUDE_TERMINAL_CHILD_PID\"; while [ ! -e \"$PUDE_TERMINAL_SHELL_EXIT\" ]; do sleep 0.01; done; exit 0",
            &pid_path,
            "unix-orphan-test",
        );
        let child_pid = wait_for_child_pid(&pid_path);
        let natural_timeout = Instant::now() + Duration::from_secs(4);
        assert!(
            process_is_alive(child_pid).expect("child should be inspectable while shell owns it"),
            "shell child {child_pid} must be alive before the parent shell exits"
        );
        fs::write(&shell_exit_path, b"exit").expect("shell exit signal should be written");
        let shell_started = Instant::now();
        loop {
            let exited = super::terminal_child_has_exited(
                session
                    .child
                    .lock()
                    .unwrap()
                    .as_mut()
                    .expect("shell child should be tracked")
                    .as_mut(),
            )
            .expect("shell status should be readable without reaping");
            if exited {
                break;
            }
            assert!(shell_started.elapsed() < Duration::from_secs(2));
            thread::sleep(Duration::from_millis(10));
        }
        let alive_before_kill = match process_is_alive(child_pid) {
            Ok(true) => true,
            Ok(false) => panic!("shell child {child_pid} exited before Kill"),
            Err(error) if error.raw_os_error() == Some(libc::EPERM) => {
                eprintln!(
                    "UNVERIFIED orphan PTY cleanup: host cannot inspect shell child {child_pid} after its shell exits ({error})."
                );
                false
            }
            Err(error) => panic!("unable to inspect shell child {child_pid} before Kill: {error}"),
        };
        let cleanup_started = Instant::now();
        let cleanup = stop_terminal_session(&session);
        assert!(cleanup_started.elapsed() < Duration::from_secs(5));

        let mut verified_dead = false;
        match cleanup {
            Ok(_) if alive_before_kill => {
                let dead_before_timeout = Instant::now() + Duration::from_secs(2);
                verified_dead = loop {
                    match process_is_alive(child_pid) {
                        Ok(false) => break true,
                        Ok(true) if Instant::now() < dead_before_timeout => {
                            thread::sleep(Duration::from_millis(10));
                        }
                        Ok(true) => panic!("shell child {child_pid} survived Kill"),
                        Err(error) if error.raw_os_error() == Some(libc::EPERM) => {
                            eprintln!(
                                "UNVERIFIED orphan PTY cleanup: host cannot probe shell child {child_pid} after Kill ({error})."
                            );
                            break false;
                        }
                        Err(error) => panic!("unable to inspect shell child {child_pid}: {error}"),
                    }
                };
            }
            Ok(_) => {
                eprintln!(
                    "UNVERIFIED orphan PTY cleanup: child {child_pid} could not be inspected after its shell exited."
                );
            }
            Err(error) if error.contains("Operation not permitted") => {
                eprintln!(
                    "UNVERIFIED orphan PTY cleanup: host denied signaling the reparented session; cleanup reported: {error}"
                );
            }
            Err(error) => panic!("terminal tree cleanup failed: {error}"),
        }
        if !verified_dead {
            let remaining = natural_timeout.saturating_duration_since(Instant::now());
            if !remaining.is_zero() {
                thread::sleep(remaining + Duration::from_millis(100));
            }
        }
        std::env::remove_var("PUDE_TERMINAL_CHILD_PID");
        std::env::remove_var("PUDE_TERMINAL_SHELL_EXIT");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn kill_reaps_a_shell_child_while_the_shell_is_alive() {
        let _test_lock = TERMINAL_TREE_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let root = std::env::temp_dir().join(format!(
            "pude-terminal-live-child-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).expect("test directory should be created");
        let pid_path = root.join("child-pid");
        let session = spawn_test_terminal_session(
            "sleep 30 & echo $! > \"$PUDE_TERMINAL_CHILD_PID\"; wait",
            &pid_path,
            "unix-live-child-test",
        );
        let process_group = session_process_group(&session);
        let _process_group_cleanup = TestProcessGroup(process_group);
        let child_pid = wait_for_child_pid(&pid_path);
        assert_eq!(
            process_group_for(child_pid).expect("child process group"),
            process_group
        );
        assert!(process_is_alive(child_pid).expect("child should be inspectable before Kill"));
        assert!(process_group_is_alive(process_group).expect("group should exist before Kill"));

        let cleanup_started = Instant::now();
        stop_terminal_session(&session).expect("live PTY process group should be terminated");
        assert!(cleanup_started.elapsed() < Duration::from_secs(5));
        assert_process_tree_exited(child_pid, process_group);
        std::env::remove_var("PUDE_TERMINAL_CHILD_PID");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn workspace_replacement_terminates_the_previous_pty_process_tree() {
        let _test_lock = TERMINAL_TREE_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let root = std::env::temp_dir().join(format!(
            "pude-terminal-replacement-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).expect("test directory should be created");
        let pid_path = root.join("child-pid");
        let owner_window = "unix-workspace-replacement-test";
        let session = spawn_test_terminal_session(
            "sleep 30 & echo $! > \"$PUDE_TERMINAL_CHILD_PID\"; wait",
            &pid_path,
            owner_window,
        );
        let process_group = session_process_group(&session);
        let _process_group_cleanup = TestProcessGroup(process_group);
        let child_pid = wait_for_child_pid(&pid_path);
        assert_eq!(
            process_group_for(child_pid).expect("child process group"),
            process_group
        );
        assert!(
            process_is_alive(child_pid).expect("child should be inspectable before replacement")
        );

        let terminals = Mutex::new(HashMap::from([(
            "previous-session".to_string(),
            Arc::clone(&session),
        )]));
        let started = Instant::now();
        stop_previous_window_terminals(&terminals, owner_window)
            .expect("workspace replacement should stop the previous PTY");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_process_tree_exited(child_pid, process_group);
        assert!(terminals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_empty());
        assert!(session
            .child
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_none());

        std::env::remove_var("PUDE_TERMINAL_CHILD_PID");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn window_close_terminates_the_owned_pty_process_tree() {
        let _test_lock = TERMINAL_TREE_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let root = std::env::temp_dir().join(format!(
            "pude-terminal-window-close-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).expect("test directory should be created");
        let pid_path = root.join("child-pid");
        let owner_window = "unix-window-close-test";
        let session = spawn_test_terminal_session(
            "sleep 30 & echo $! > \"$PUDE_TERMINAL_CHILD_PID\"; wait",
            &pid_path,
            owner_window,
        );
        let process_group = session_process_group(&session);
        let _process_group_cleanup = TestProcessGroup(process_group);
        let child_pid = wait_for_child_pid(&pid_path);
        assert_eq!(
            process_group_for(child_pid).expect("child process group"),
            process_group
        );
        assert!(
            process_is_alive(child_pid).expect("child should be inspectable before window close")
        );

        let state = AppState::default();
        state
            .terminals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert("window-session".to_string(), Arc::clone(&session));
        let started = Instant::now();
        cleanup_window_resources(&state, owner_window)
            .expect("window terminal cleanup should succeed");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_process_tree_exited(child_pid, process_group);
        assert!(state
            .terminals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_empty());
        assert!(session
            .child
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_none());

        std::env::remove_var("PUDE_TERMINAL_CHILD_PID");
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(target_os = "linux")]
    fn spawn_interactive_job_session(pid_path: &Path, owner: &str) -> Arc<TerminalSession> {
        use std::io::{Read, Write};
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("/bin/bash");
        command.args(["--noprofile", "--norc", "-il"]);
        command.env("PUDE_TERMINAL_CHILD_PID", pid_path);
        let child = pair.slave.spawn_command(command).unwrap();
        let process_tree = TerminalProcessTree::attach(child.as_ref()).unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = pair.master.take_writer().unwrap();
        drop(pair.slave);
        let session = Arc::new(TerminalSession {
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            child: Mutex::new(Some(child)),
            process_tree: Mutex::new(Some(process_tree)),
            reader_thread: Mutex::new(None),
            process_watcher: Mutex::new(None),
            stop_lock: Mutex::new(()),
            stop_requested: AtomicBool::new(false),
            reader_finished: Arc::new(AtomicBool::new(false)),
            owner_window: owner.to_string(),
            output_flow: super::TerminalOutputFlow::new(1),
            output_channel: tauri::ipc::Channel::new(|_| Ok(())),
        });
        let finished = Arc::clone(&session.reader_finished);
        *session.reader_thread.lock().unwrap() = Some(thread::spawn(move || {
            let _completion = super::TerminalReaderCompletion(finished);
            let mut output = Vec::new();
            reader
                .read_to_end(&mut output)
                .expect("PTY reader should drain and exit");
        }));
        session
            .writer
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .write_all(
                b"trap '' HUP; sleep 300 & printf '%s\\n' \"$!\" > \"$PUDE_TERMINAL_CHILD_PID\"\n",
            )
            .unwrap();
        session
    }

    #[cfg(target_os = "linux")]
    fn check_interactive_job_cleanup(window_close: bool) {
        let root = std::env::temp_dir().join(format!(
            "pude-terminal-job-control-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).unwrap();
        let owner = "interactive-close";
        let session = spawn_interactive_job_session(&root.join("owned-pid"), owner);
        let other = spawn_interactive_job_session(&root.join("other-pid"), "other-window");
        struct Cleanup(Arc<TerminalSession>);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = stop_terminal_session(&self.0);
            }
        }
        let _session_cleanup = Cleanup(Arc::clone(&session));
        let _other_cleanup = Cleanup(Arc::clone(&other));
        let job_pid = wait_for_child_pid(&root.join("owned-pid"));
        let other_job = wait_for_child_pid(&root.join("other-pid"));
        let shell_pid = session_process_group(&session);
        let job_group = process_group_for(job_pid).unwrap();
        let _job_cleanup = TestProcessGroup(job_group);
        let _other_job_cleanup = TestProcessGroup(process_group_for(other_job).unwrap());
        assert_ne!(
            job_group, shell_pid,
            "interactive job control must use a different PGID"
        );
        assert_eq!(
            unsafe { libc::getsid(job_pid) },
            shell_pid,
            "job must belong to the owned SID"
        );
        let started = Instant::now();
        if window_close {
            let state = AppState::default();
            state.terminals.lock().unwrap().extend([
                ("owned-session".to_string(), Arc::clone(&session)),
                ("other-session".to_string(), Arc::clone(&other)),
            ]);
            cleanup_window_resources(&state, owner).expect("interactive window cleanup");
            let terminals = state.terminals.lock().unwrap();
            assert!(!terminals.contains_key("owned-session"));
            assert!(terminals.contains_key("other-session"));
        } else {
            stop_terminal_session(&session).expect("interactive terminal cleanup");
        }
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_process_tree_exited(job_pid, job_group);
        assert!(session.child.lock().unwrap().is_none());
        assert!(
            session.reader_thread.lock().unwrap().is_none(),
            "reader must finish without timeout"
        );
        assert!(session
            .reader_finished
            .load(std::sync::atomic::Ordering::Acquire));
        assert!(
            process_is_alive(other_job).unwrap(),
            "another terminal's job must survive"
        );
        assert!(!super::terminal_child_has_exited(
            other.child.lock().unwrap().as_mut().unwrap().as_mut()
        )
        .unwrap());
        stop_terminal_session(&other).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn terminal_close_terminates_interactive_job_control_groups_only_in_its_session() {
        check_interactive_job_cleanup(false);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn window_close_terminates_interactive_job_control_groups_only_in_its_session() {
        check_interactive_job_cleanup(true);
    }

    #[test]
    fn window_terminal_batch_attempts_every_session_and_retains_failures() {
        let _test_lock = TERMINAL_TREE_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let root = std::env::temp_dir().join(format!(
            "pude-terminal-batch-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).expect("test directory should be created");
        let blocked_pid_path = root.join("blocked-child-pid");
        let healthy_pid_path = root.join("healthy-child-pid");
        let blocked = spawn_test_terminal_session(
            "sleep 30 & echo $! > \"$PUDE_TERMINAL_CHILD_PID\"; wait",
            &blocked_pid_path,
            "batch-cleanup-test",
        );
        let healthy = spawn_test_terminal_session(
            "sleep 30 & echo $! > \"$PUDE_TERMINAL_CHILD_PID\"; wait",
            &healthy_pid_path,
            "batch-cleanup-test",
        );
        let blocked_group = session_process_group(&blocked);
        let healthy_group = session_process_group(&healthy);
        let _blocked_process_group_cleanup = TestProcessGroup(blocked_group);
        let _healthy_process_group_cleanup = TestProcessGroup(healthy_group);
        let blocked_child = wait_for_child_pid(&blocked_pid_path);
        let healthy_child = wait_for_child_pid(&healthy_pid_path);

        let (writer_locked_sender, writer_locked_receiver) = mpsc::channel();
        let (release_writer_sender, release_writer_receiver) = mpsc::channel();
        let blocked_writer_session = Arc::clone(&blocked);
        let writer_holder = thread::spawn(move || {
            let _writer = blocked_writer_session
                .writer
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            writer_locked_sender
                .send(())
                .expect("test should observe the blocked writer lock");
            release_writer_receiver
                .recv_timeout(Duration::from_secs(5))
                .expect("test should release the blocked writer lock");
        });
        writer_locked_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("writer lock should be held before batch cleanup");

        let started = Instant::now();
        let (failed, result) = stop_terminal_sessions(vec![
            ("blocked-writer".to_string(), Arc::clone(&blocked)),
            ("healthy-terminal".to_string(), Arc::clone(&healthy)),
        ]);
        assert!(started.elapsed() < Duration::from_secs(5));
        let error = result.expect_err("the blocked writer should fail the aggregate cleanup");
        assert!(
            error.contains("blocked-writer"),
            "missing failing ID: {error}"
        );
        assert_eq!(
            failed.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec!["blocked-writer"]
        );

        assert_process_tree_exited(blocked_child, blocked_group);
        assert_process_tree_exited(healthy_child, healthy_group);
        assert!(healthy.child.lock().unwrap().is_none());

        release_writer_sender
            .send(())
            .expect("blocked writer should be released for retry");
        writer_holder
            .join()
            .expect("writer holder should exit after release");
        stop_terminal_session(&blocked).expect("retained session should clean up on retry");
        let _ = fs::remove_dir_all(root);
    }
}

#[cfg(test)]
mod terminal_write_lifecycle_tests {
    use super::{
        stop_terminal_session, terminal_child_has_exited, terminal_write_sync,
        test_terminal_session, TerminalSession,
    };
    use std::collections::HashMap;
    use std::io::{self, Write};
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, Weak};
    use std::time::{Duration, Instant};

    fn running_session() -> Arc<TerminalSession> {
        #[cfg(unix)]
        let mut command = {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", "read -r line"]);
            command
        };
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("cmd.exe");
            command.args(["/D", "/Q", "/C", "set /p line="]);
            command
        };
        let child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let session = test_terminal_session("write-lifecycle");
        *session.child.lock().unwrap() = Some(Box::new(child));
        session
    }

    fn exit_process(session: &TerminalSession) {
        let mut child = session.child.lock().unwrap();
        let child = child.as_mut().unwrap();
        // EOF lets the real shell exit without portable-pty's Unix kill helper,
        // which also reaps children while waiting for SIGHUP to take effect.
        drop(
            child
                .as_mut()
                .as_any_mut()
                .downcast_mut::<std::process::Child>()
                .unwrap()
                .stdin
                .take(),
        );
        let deadline = Instant::now() + Duration::from_secs(2);
        while !terminal_child_has_exited(child.as_mut()).unwrap() {
            assert!(Instant::now() < deadline, "child should exit promptly");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn write_input(session: &Arc<TerminalSession>) -> Result<(), String> {
        terminal_write_sync(
            "test".to_string(),
            b"input".to_vec(),
            Arc::new(Mutex::new(HashMap::from([(
                "test".to_string(),
                Arc::clone(session),
            )]))),
        )
    }

    struct AcceptingWriter(Arc<AtomicUsize>);
    impl Write for AcceptingWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.fetch_add(bytes.len(), Ordering::SeqCst);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn post_exit_input_is_rejected_before_an_accepting_writer_is_called() {
        let session = running_session();
        let bytes = Arc::new(AtomicUsize::new(0));
        *session.writer.lock().unwrap() = Some(Box::new(AcceptingWriter(Arc::clone(&bytes))));
        exit_process(&session);
        let result = write_input(&session);
        stop_terminal_session(&session).unwrap();
        assert!(result.unwrap_err().contains("Terminal process has exited"));
        assert_eq!(bytes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn input_racing_process_exit_is_rejected_even_when_write_and_flush_succeed() {
        struct ExitOnFlush(Weak<TerminalSession>);
        impl Write for ExitOnFlush {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                exit_process(&self.0.upgrade().unwrap());
                Ok(())
            }
        }
        let session = running_session();
        *session.writer.lock().unwrap() = Some(Box::new(ExitOnFlush(Arc::downgrade(&session))));
        let result = write_input(&session);
        stop_terminal_session(&session).unwrap();
        assert!(result.unwrap_err().contains("Terminal process has exited"));
    }

    #[test]
    fn live_input_succeeds_and_stopping_input_is_rejected() {
        let session = running_session();
        let bytes = Arc::new(AtomicUsize::new(0));
        *session.writer.lock().unwrap() = Some(Box::new(AcceptingWriter(Arc::clone(&bytes))));
        write_input(&session).unwrap();
        session.stop_requested.store(true, Ordering::Release);
        let result = write_input(&session);
        stop_terminal_session(&session).unwrap();
        assert!(result.unwrap_err().contains("Terminal session is stopping"));
        assert_eq!(bytes.load(Ordering::SeqCst), 5);
    }
}

#[cfg(test)]
mod terminal_blocked_writer_tests {
    use super::{stop_terminal_session, TerminalSession};
    use std::io::{self, Write};
    use std::sync::atomic::AtomicBool;
    #[cfg(windows)]
    use std::sync::atomic::AtomicU32;
    use std::sync::mpsc::{self, Receiver, SyncSender};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    struct BlockingWriter {
        entered: Option<SyncSender<()>>,
        release: Receiver<()>,
    }

    impl Write for BlockingWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if let Some(entered) = self.entered.take() {
                let _ = entered.send(());
            }
            self.release
                .recv()
                .map_err(|error| io::Error::new(io::ErrorKind::BrokenPipe, error))?;
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn terminal_kill_returns_a_bounded_diagnostic_when_a_writer_is_blocked() {
        let (entered_sender, entered_receiver) = mpsc::sync_channel(0);
        let (release_sender, release_receiver) = mpsc::channel();
        let session = Arc::new(TerminalSession {
            master: Mutex::new(None),
            writer: Mutex::new(Some(Box::new(BlockingWriter {
                entered: Some(entered_sender),
                release: release_receiver,
            }))),
            child: Mutex::new(None),
            process_tree: Mutex::new(None),
            #[cfg(windows)]
            writer_thread_id: AtomicU32::new(0),
            reader_thread: Mutex::new(None),
            process_watcher: Mutex::new(None),
            stop_lock: Mutex::new(()),
            stop_requested: AtomicBool::new(false),
            reader_finished: Arc::new(AtomicBool::new(false)),
            owner_window: "writer-test".to_string(),
            output_flow: super::TerminalOutputFlow::new(1),
            output_channel: tauri::ipc::Channel::new(|_| Ok(())),
        });
        let writing_session = Arc::clone(&session);
        let writer_thread = thread::spawn(move || {
            let mut writer = writing_session.writer.lock().unwrap();
            let _ = writer
                .as_mut()
                .expect("writer should exist")
                .write_all(b"blocked");
        });
        entered_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("writer should block inside the PTY write");

        let started = Instant::now();
        let error =
            stop_terminal_session(&session).expect_err("blocked writer should be diagnosed");
        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(
            error.contains("Terminal writer did not stop"),
            "unexpected cleanup diagnostic: {error}"
        );

        release_sender.send(()).expect("release blocked writer");
        writer_thread
            .join()
            .expect("writer thread should exit after release");
        stop_terminal_session(&session).expect("retry should close the released writer");
    }
}

#[cfg(all(test, windows))]
mod terminal_lifecycle_tests {
    use super::{
        monitor_terminal_process, stop_terminal_session, TerminalProcessTree, TerminalSession,
    };
    use crate::{cleanup_window_resources, AppState};
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::fs;
    use std::io::{Read, Write};
    use std::sync::atomic::{AtomicBool, AtomicU32};
    use std::sync::mpsc::{self, Receiver};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    fn powershell(
        args: &[&str],
        on_exit: impl FnOnce(&TerminalSession) + Send + 'static,
    ) -> (Arc<TerminalSession>, Receiver<()>, Receiver<()>) {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("ConPTY should open");
        let mut command = CommandBuilder::new("powershell.exe");
        command.args(["-NoLogo", "-NoProfile"]);
        command.args(args.iter().copied());
        let child = pair
            .slave
            .spawn_command(command)
            .expect("PowerShell should start");
        let process_tree = TerminalProcessTree::attach(child.as_ref(), None)
            .expect("ConPTY process should attach to a Job Object");
        drop(pair.slave);
        let mut reader = pair
            .master
            .try_clone_reader()
            .expect("PTY reader should clone");
        let writer = pair
            .master
            .take_writer()
            .expect("PTY writer should be available");
        let reader_finished = Arc::new(AtomicBool::new(false));
        let session = Arc::new(TerminalSession {
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            child: Mutex::new(Some(child)),
            process_tree: Mutex::new(Some(process_tree)),
            #[cfg(windows)]
            writer_thread_id: AtomicU32::new(0),
            reader_thread: Mutex::new(None),
            process_watcher: Mutex::new(None),
            stop_lock: Mutex::new(()),
            stop_requested: AtomicBool::new(false),
            reader_finished,
            owner_window: "test-window".to_string(),
            output_flow: super::TerminalOutputFlow::new(1),
            output_channel: tauri::ipc::Channel::new(|_| Ok(())),
        });
        let (done_sender, done_receiver) = mpsc::channel();
        let (prompt_sender, prompt_receiver) = mpsc::channel();
        let reader_session = Arc::clone(&session);
        let reader_thread = thread::Builder::new()
            .name("pude-test-terminal-reader".to_string())
            .spawn(move || {
                let _completion =
                    super::TerminalReaderCompletion(Arc::clone(&reader_session.reader_finished));
                let mut buffer = [0_u8; 1024];
                let mut pending = Vec::new();
                let mut recent_output = Vec::new();
                while let Ok(size) = reader.read(&mut buffer) {
                    if size == 0 {
                        break;
                    }
                    recent_output.extend_from_slice(&buffer[..size]);
                    if recent_output
                        .windows(b"PUDE_INPUT_WAIT".len())
                        .any(|window| window == b"PUDE_INPUT_WAIT")
                    {
                        let _ = prompt_sender.send(());
                        recent_output.clear();
                    } else if recent_output.len() > 512 {
                        let retain_from = recent_output.len() - 512;
                        recent_output.drain(..retain_from);
                    }
                    pending.extend_from_slice(&buffer[..size]);
                    if pending.windows(4).any(|window| window == b"\x1b[6n") {
                        if let Ok(mut writer) = reader_session.writer.lock() {
                            if let Some(writer) = writer.as_mut() {
                                let _ = writer.write_all(b"\x1b[1;1R");
                                let _ = writer.flush();
                            }
                        }
                        pending.clear();
                    } else if pending.len() > 3 {
                        let retain_from = pending.len() - 3;
                        pending.drain(..retain_from);
                    }
                }
                let _ = done_sender.send(());
            })
            .expect("terminal reader should start");
        *session.reader_thread.lock().unwrap() = Some(reader_thread);
        let (monitor_ready, start_monitor) = mpsc::sync_channel(0);
        let monitor_session = Arc::clone(&session);
        let monitor = thread::Builder::new()
            .name("pude-test-terminal-monitor".to_string())
            .spawn(move || {
                if start_monitor.recv().is_ok() {
                    monitor_terminal_process(&monitor_session, on_exit)
                        .expect("terminal monitor should finish cleanly");
                }
            })
            .expect("terminal monitor should start");
        *session.process_watcher.lock().unwrap() = Some(monitor);
        monitor_ready.send(()).expect("monitor should be ready");
        (session, done_receiver, prompt_receiver)
    }

    #[test]
    fn kill_stops_a_shell_waiting_for_input_and_reaps_its_reader_within_the_bound() {
        let (session, reader_done, prompt_seen) =
            powershell(&["-Command", "Read-Host -Prompt 'PUDE_INPUT_WAIT'"], |_| {});
        prompt_seen
            .recv_timeout(Duration::from_secs(10))
            .expect("PowerShell should be waiting for terminal input");
        assert!(
            reader_done.try_recv().is_err(),
            "the PTY reader should still be blocked"
        );

        let started = Instant::now();
        let status = stop_terminal_session(&session).expect("terminal cleanup should succeed");

        assert!(status.is_some());
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(reader_done.recv_timeout(Duration::from_millis(100)).is_ok());
        assert!(session.reader_thread.lock().unwrap().is_none());
        assert!(session.child.lock().unwrap().is_none());
        assert!(session.master.lock().unwrap().is_none());
        assert!(session.writer.lock().unwrap().is_none());
    }

    #[test]
    fn natural_child_exit_is_waited_and_cleanup_is_idempotent() {
        let (exit_sender, exit_receiver) = mpsc::channel();
        let (session, reader_done, _) = powershell(&["-Command", "exit 7"], move |_| {
            let _ = exit_sender.send(());
        });
        exit_receiver
            .recv_timeout(Duration::from_secs(10))
            .expect("the process monitor should observe the natural shell exit");

        let status = stop_terminal_session(&session).expect("natural exit should clean up");
        assert!(status.is_some());
        assert!(reader_done.recv_timeout(Duration::from_millis(100)).is_ok());
        assert!(session.reader_thread.lock().unwrap().is_none());
        assert!(session.process_watcher.lock().unwrap().is_none());
        assert!(stop_terminal_session(&session).unwrap().is_none());
    }

    #[test]
    fn natural_exit_monitor_can_cleanup_without_joining_itself() {
        let (cleanup_sender, cleanup_receiver) = mpsc::channel();
        let (session, reader_done, _) = powershell(&["-Command", "exit 0"], move |session| {
            let _ = cleanup_sender.send(stop_terminal_session(session));
        });

        let status = cleanup_receiver
            .recv_timeout(Duration::from_secs(10))
            .expect("monitor cleanup should return")
            .expect("monitor cleanup should succeed");
        assert!(status.is_some());
        assert!(reader_done.recv_timeout(Duration::from_millis(100)).is_ok());
        stop_terminal_session(&session).expect("the finished monitor handle should join");
        assert!(session.process_watcher.lock().unwrap().is_none());
    }

    #[test]
    fn concurrent_kill_and_window_close_cleanup_are_serialized() {
        let (session, reader_done, _) =
            powershell(&["-Command", "Start-Sleep -Seconds 30"], |_| {});
        thread::sleep(Duration::from_millis(200));
        let started = Instant::now();
        let first = Arc::clone(&session);
        let second = Arc::clone(&session);
        let kill = thread::spawn(move || stop_terminal_session(&first));
        let close = thread::spawn(move || stop_terminal_session(&second));

        assert!(kill.join().unwrap().is_ok());
        assert!(close.join().unwrap().is_ok());
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(reader_done.recv_timeout(Duration::from_millis(100)).is_ok());
    }

    #[test]
    fn destroying_a_window_kills_the_child_and_joins_terminal_workers() {
        let (session, reader_done, _) =
            powershell(&["-Command", "Start-Sleep -Seconds 30"], |_| {});
        let state = AppState::default();
        state
            .terminals
            .lock()
            .unwrap()
            .insert("window-session".to_string(), Arc::clone(&session));
        thread::sleep(Duration::from_millis(200));

        let started = Instant::now();
        cleanup_window_resources(&state, "test-window")
            .expect("window terminal cleanup should succeed");

        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(reader_done.recv_timeout(Duration::from_millis(100)).is_ok());
        assert!(state.terminals.lock().unwrap().is_empty());
        assert!(session.reader_thread.lock().unwrap().is_none());
        assert!(session.process_watcher.lock().unwrap().is_none());
        assert!(session.child.lock().unwrap().is_none());
        assert!(session.master.lock().unwrap().is_none());
        assert!(session.writer.lock().unwrap().is_none());
    }

    #[test]
    #[ignore = "subprocess fixture for the bootstrap gate test"]
    fn bootstrap_child_fixture() {
        let Some(pid_path) = std::env::var_os("PUDE_TERMINAL_CHILD_PID") else {
            return;
        };
        fs::write(pid_path, std::process::id().to_string()).expect("write fixture PID");
        thread::sleep(Duration::from_secs(30));
    }

    #[test]
    fn bootstrap_gate_releases_the_shell_only_after_job_assignment() {
        let pid_path = std::env::temp_dir().join(format!(
            "pude-terminal-job-child-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let mut gate = super::TerminalBootstrapGate::new().expect("startup event should open");
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("ConPTY should open");
        let mut command = CommandBuilder::new(env!("PUDE_TERMINAL_BOOTSTRAP_EXE"));
        command.arg(gate.name());
        command.arg(std::env::current_exe().expect("test executable should exist"));
        command.arg(std::env::temp_dir());
        command.args([
            "--exact",
            "terminal::terminal_lifecycle_tests::bootstrap_child_fixture",
            "--ignored",
            "--nocapture",
        ]);
        command.env("PUDE_TERMINAL_CHILD_PID", &pid_path);
        let child = pair
            .slave
            .spawn_command(command)
            .expect("bootstrap shell should start");
        drop(pair.slave);
        thread::sleep(Duration::from_millis(100));
        assert!(
            !pid_path.exists(),
            "shell child started before the startup gate was released"
        );

        let process_tree = TerminalProcessTree::attach(child.as_ref(), Some(&mut gate))
            .expect("Job assignment should release the bootstrap gate");
        let mut reader = pair.master.try_clone_reader().unwrap();
        let (output_sender, output_receiver) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let mut buffer = [0_u8; 1024];
            while let Ok(size) = reader.read(&mut buffer) {
                if size == 0 || output_sender.send(buffer[..size].to_vec()).is_err() {
                    break;
                }
            }
        });
        let writer = pair
            .master
            .take_writer()
            .expect("PTY writer should be available");
        let session = Arc::new(TerminalSession {
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            child: Mutex::new(Some(child)),
            process_tree: Mutex::new(Some(process_tree)),
            writer_thread_id: AtomicU32::new(0),
            reader_thread: Mutex::new(None),
            process_watcher: Mutex::new(None),
            stop_lock: Mutex::new(()),
            stop_requested: AtomicBool::new(false),
            reader_finished: Arc::new(AtomicBool::new(false)),
            owner_window: "job-test".to_string(),
            output_flow: super::TerminalOutputFlow::new(1),
            output_channel: tauri::ipc::Channel::new(|_| Ok(())),
        });
        let mut output = Vec::new();
        let mut pending = Vec::new();
        let child_started = Instant::now();
        while !pid_path.exists() && child_started.elapsed() < Duration::from_secs(10) {
            if let Ok(bytes) = output_receiver.recv_timeout(Duration::from_millis(50)) {
                pending.extend_from_slice(&bytes);
                output.extend(bytes);
            }
            while let Some(query) = pending.windows(4).position(|window| window == b"\x1b[6n") {
                let mut writer = session.writer.lock().unwrap();
                let writer = writer.as_mut().unwrap();
                writer.write_all(b"\x1b[1;1R").unwrap();
                writer.flush().unwrap();
                pending.drain(..query + 4);
            }
            if pending.len() > 3 {
                pending.drain(..pending.len() - 3);
            }
        }
        if !pid_path.exists() {
            let _ = stop_terminal_session(&session);
            while let Ok(bytes) = output_receiver.recv_timeout(Duration::from_millis(100)) {
                output.extend(bytes);
            }
            panic!(
                "shell child did not start after Job assignment: {}",
                String::from_utf8_lossy(&output)
            );
        }
        let child_pid = fs::read_to_string(&pid_path)
            .expect("shell child should start after Job assignment")
            .trim()
            .parse::<u32>()
            .expect("child PID should be numeric");

        let started = Instant::now();
        stop_terminal_session(&session).expect("Job Object should stop the shell tree");
        assert!(started.elapsed() < Duration::from_secs(5));
        let deadline = Instant::now() + Duration::from_secs(2);
        while process_is_alive(child_pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            !process_is_alive(child_pid),
            "Job Object left shell child {child_pid} alive"
        );
        let _ = fs::remove_file(pid_path);
    }

    fn process_is_alive(process_id: u32) -> bool {
        let process_id = process_id.to_string();
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {process_id}")])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&process_id))
            .unwrap_or(false)
    }
}

#[tauri::command]
pub(crate) async fn terminal_kill(
    session_id: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    quit_gate: State<'_, QuitGateState>,
) -> Result<(), String> {
    let admission = quit_gate.admit_resource_operation(window.label())?;
    let terminals = Arc::clone(&state.terminals);
    let lifecycle = Arc::clone(&state.terminal_lifecycle);
    let resource = format!("control:{session_id}");
    run_blocking_resource(
        "Unable to stop terminal",
        BlockingClass::Terminal,
        resource,
        move || {
            let _admission = admission;
            terminal_kill_sync(session_id, terminals, lifecycle)
        },
    )
    .await
}

fn terminal_kill_sync(
    session_id: String,
    terminals: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
    lifecycle: Arc<TerminalLifecycle>,
) -> Result<(), String> {
    let terminal = terminals
        .lock()
        .map_err(|_| "Unable to lock terminal state.".to_string())?
        .remove(&session_id);
    if let Some(terminal) = terminal {
        if let Err(error) = stop_terminal_session(&terminal) {
            lifecycle.register_if_open(&terminals, &session_id, &terminal);
            return Err(error);
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn terminal_ack_output(
    session_id: String,
    generation: u64,
    up_to_seq: u64,
    bytes: usize,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    quit_gate: State<'_, QuitGateState>,
) -> Result<(), String> {
    let _admission = quit_gate.admit_resource_operation(window.label())?;
    let terminal = state
        .terminals
        .lock()
        .map_err(|_| "Unable to lock terminal state.".to_string())?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "Terminal session not found.".to_string())?;
    if terminal.owner_window != window.label() {
        return Err("Terminal output acknowledgment does not belong to this window.".to_string());
    }
    terminal.output_flow.ack(generation, up_to_seq, bytes)
}

#[tauri::command]
pub(crate) async fn terminal_resize(
    session_id: String,
    rows: u16,
    cols: u16,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    quit_gate: State<'_, QuitGateState>,
) -> Result<(), String> {
    let admission = quit_gate.admit_resource_operation(window.label())?;
    let terminals = Arc::clone(&state.terminals);
    let resource = format!("control:{session_id}");
    run_blocking_resource(
        "Unable to resize terminal",
        BlockingClass::Terminal,
        resource,
        move || {
            let _admission = admission;
            terminal_resize_sync(session_id, rows, cols, terminals)
        },
    )
    .await
}

fn terminal_resize_sync(
    session_id: String,
    rows: u16,
    cols: u16,
    terminals: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
) -> Result<(), String> {
    if rows == 0 || cols == 0 {
        return Err("Terminal size must be greater than zero.".to_string());
    }
    let terminals = terminals
        .lock()
        .map_err(|_| "Unable to lock terminal state.".to_string())?;
    let terminal = terminals
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "Terminal session not found.".to_string())?;
    drop(terminals);
    let master = terminal
        .master
        .lock()
        .map_err(|_| "Unable to lock terminal master.".to_string())?;
    master
        .as_ref()
        .ok_or_else(|| "Terminal session is stopping.".to_string())?
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Unable to resize terminal. {error}"))
}

fn decode_terminal_bytes(pending: &mut Vec<u8>, bytes: &[u8]) -> String {
    pending.extend_from_slice(bytes);
    let mut output = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(text) => {
                output.push_str(text);
                pending.clear();
                break;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                if valid > 0 {
                    output.push_str(
                        std::str::from_utf8(&pending[..valid])
                            .expect("valid UTF-8 prefix should decode"),
                    );
                }
                if error.error_len().is_none() {
                    *pending = pending[valid..].to_vec();
                    break;
                }
                output.push('\u{FFFD}');
                let invalid_length = error.error_len().expect("invalid UTF-8 has a length");
                *pending = pending[valid + invalid_length..].to_vec();
            }
        }
    }
    output
}

fn read_terminal_chunks(
    reader: &mut impl Read,
    output_flow: &TerminalOutputFlow,
    stop_requested: &AtomicBool,
    mut emit: impl FnMut(String) -> bool,
) -> io::Result<()> {
    let mut buffer = [0_u8; TERMINAL_READ_BUFFER_BYTES];
    let mut pending_utf8 = Vec::new();
    let mut read_error = None;
    loop {
        output_flow.wait_for_credit(stop_requested);
        if stop_requested.load(Ordering::Acquire) {
            break;
        }
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if terminal_pty_read_error_is_eof(&error) => break,
            Err(error) => {
                read_error = Some(error);
                break;
            }
            Ok(size) => {
                let data = decode_terminal_bytes(&mut pending_utf8, &buffer[..size]);
                if !data.is_empty() && !emit(data) {
                    break;
                }
            }
        }
    }
    if !pending_utf8.is_empty() {
        let data = String::from_utf8_lossy(&pending_utf8).to_string();
        if !data.is_empty() {
            emit(data);
        }
    }
    match read_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[cfg(test)]
fn read_terminal_output(
    reader: &mut impl Read,
    output_flow: &TerminalOutputFlow,
    stop_requested: &AtomicBool,
    mut emit: impl FnMut(u64, u64, String),
) -> io::Result<()> {
    read_terminal_chunks(reader, output_flow, stop_requested, |data| {
        let seq = output_flow.alloc(data.len());
        emit(seq, output_flow.generation(), data);
        true
    })
}

fn terminal_pty_read_error_is_eof(error: &io::Error) -> bool {
    #[cfg(unix)]
    {
        // macOS reports EIO from the PTY master after the last slave closes;
        // that is the Unix PTY EOF signal, not a reader fault.
        error.raw_os_error() == Some(libc::EIO)
    }
    #[cfg(not(unix))]
    {
        // Preserve the existing ConPTY behavior where a closed pipe is EOF.
        let _ = error;
        true
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitDetails {
    exit_code: Option<u32>,
    signal: Option<String>,
    reason: &'static str,
}

fn terminal_exit_details(status: Option<&portable_pty::ExitStatus>) -> TerminalExitDetails {
    let exit_code = status.map(|status| status.exit_code());
    let signal = status.and_then(|status| status.signal()).map(str::to_owned);
    #[cfg(unix)]
    let interrupted_signal = signal.as_ref().is_some_and(|signal| unsafe {
        let name = libc::strsignal(libc::SIGINT);
        !name.is_null() && std::ffi::CStr::from_ptr(name).to_string_lossy() == signal.as_str()
    });
    #[cfg(not(unix))]
    let interrupted_signal = false;
    let reason = if interrupted_signal || matches!(exit_code, Some(130 | 0xc000013a)) {
        "interrupted"
    } else if status.is_some_and(|status| status.success()) {
        "normal"
    } else {
        "error"
    };
    TerminalExitDetails {
        exit_code,
        signal,
        reason,
    }
}

#[cfg(test)]
mod interrupt_tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn interrupt_status_keeps_the_linux_session_anchor_unreaped() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "kill -INT $$"]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let deadline = Instant::now() + Duration::from_secs(5);
        let status = loop {
            if let Some(status) = terminal_child_exit_status(child.as_mut()).unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(terminal_exit_details(Some(&status)).reason, "interrupted");
        let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
        assert_eq!(
            unsafe {
                libc::waitid(
                    libc::P_PID,
                    child.process_id().unwrap(),
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            },
            0
        );
        assert_eq!(unsafe { info.si_pid() } as u32, child.process_id().unwrap());
        child.wait().unwrap();
    }

    #[test]
    fn exit_details_distinguish_interrupts_normal_exits_and_errors() {
        for (code, reason) in [
            (0, "normal"),
            (1, "error"),
            (130, "interrupted"),
            (0xc000013a, "interrupted"),
        ] {
            let status = portable_pty::ExitStatus::with_exit_code(code);
            let details = terminal_exit_details(Some(&status));
            assert_eq!(details.reason, reason);
            assert_eq!(details.exit_code, Some(code));
        }
        assert_eq!(terminal_exit_details(None).reason, "error");
    }

    #[cfg(unix)]
    #[test]
    fn real_pty_ctrl_c_returns_to_an_interactive_shell() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.arg("-i");
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut writer = pair.master.take_writer().unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let worker = thread::spawn(move || {
            let mut buffer = [0; 4096];
            while let Ok(count) = reader.read(&mut buffer) {
                if count == 0
                    || sender
                        .send(String::from_utf8_lossy(&buffer[..count]).into_owned())
                        .is_err()
                {
                    break;
                }
            }
        });
        let until = |marker: &str| {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut output = String::new();
            while !output.contains(marker) {
                output.push_str(
                    &receiver
                        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                        .expect("PTY should produce the expected marker"),
                );
            }
            output
        };
        writer
            .write_all(b"stty -echo; printf '\\nPUDE_READY\\n'\r")
            .unwrap();
        writer.flush().unwrap();
        until("\r\nPUDE_READY\r\n");
        writer.write_all(b"sleep 30\r").unwrap();
        writer.flush().unwrap();
        let shell_pid = child.process_id().unwrap() as libc::pid_t;
        let descriptor = pair.master.as_raw_fd().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while unsafe { libc::tcgetpgrp(descriptor) } == shell_pid {
            assert!(
                Instant::now() < deadline,
                "sleep should own the foreground process group"
            );
            thread::sleep(Duration::from_millis(10));
        }
        writer.write_all(b"\x03").unwrap();
        writer.flush().unwrap();
        while unsafe { libc::tcgetpgrp(descriptor) } != shell_pid {
            assert!(
                Instant::now() < deadline,
                "Ctrl+C should return control to the shell"
            );
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            child.try_wait().unwrap().is_none(),
            "interrupting sleep must leave the shell alive"
        );
        writer
            .write_all(b"printf '\\nPUDE_INPUT_WORKS\\n'\r")
            .unwrap();
        writer.flush().unwrap();
        until("\r\nPUDE_INPUT_WORKS\r\n");
        writer.write_all(b"exit 0\r").unwrap();
        writer.flush().unwrap();
        let status = wait_for_terminal_child(child.as_mut(), Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert_eq!(terminal_exit_details(Some(&status)).reason, "normal");
        drop(writer);
        drop(pair.master);
        worker.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn real_pty_shell_interrupt_has_structured_exit_details() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "kill -INT $$"]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let status = wait_for_terminal_child(child.as_mut(), Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert_eq!(terminal_exit_details(Some(&status)).reason, "interrupted");
        assert!(terminal_exit_details(Some(&status)).signal.is_some());
    }
}

fn finish_terminal_session(app: &AppHandle, session_id: &str) {
    let session = app
        .state::<AppState>()
        .terminals
        .lock()
        .ok()
        .and_then(|mut terminals| terminals.remove(session_id));
    let Some(session) = session else { return };
    let natural_status = session.child.lock().ok().and_then(|mut child| {
        child.as_mut().and_then(|child| {
            let deadline = Instant::now() + TERMINAL_READER_JOIN_TIMEOUT;
            loop {
                match terminal_child_exit_status(child.as_mut()) {
                    Ok(None) if Instant::now() < deadline => {
                        thread::sleep(Duration::from_millis(10))
                    }
                    Ok(status) => break status,
                    Err(_) => break None,
                }
            }
        })
    });
    let mut details = terminal_exit_details(natural_status.as_ref());
    let status = match stop_terminal_session(&session) {
        Ok(status) => status,
        Err(error) => {
            details.reason = "error";
            crate::app_log::log_error(&format!(
                "Unable to clean up terminal {session_id}: {error}"
            ));
            let state = app.state::<AppState>();
            state
                .terminal_lifecycle
                .register_if_open(&state.terminals, session_id, &session);
            None
        }
    };
    let _ = app.emit_to(
        &session.owner_window,
        "terminal-exit",
        serde_json::json!({ "sessionId": session_id, "status": status,
            "exitCode": details.exit_code, "signal": details.signal, "reason": details.reason }),
    );
}

fn watch_terminal_process(app: AppHandle, session_id: String, session: Arc<TerminalSession>) {
    let on_exit = |_: &TerminalSession| {
        finish_terminal_session(&app, &session_id);
    };
    if let Err(error) = monitor_terminal_process(&session, on_exit) {
        crate::app_log::log_error(&format!(
            "Unable to monitor terminal process {session_id}: {error}"
        ));
        finish_terminal_session(&app, &session_id);
    }
}

#[cfg(windows)]
struct TerminalBootstrapGate {
    handle: isize,
    name: String,
}

#[cfg(windows)]
impl TerminalBootstrapGate {
    fn new() -> io::Result<Self> {
        let name = format!("Local\\pude-terminal-{}", Uuid::new_v4());
        let wide_name = std::ffi::OsStr::new(&name)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let handle = unsafe { CreateEventW(std::ptr::null_mut(), 1, 0, wide_name.as_ptr()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            handle: handle as isize,
            name,
        })
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn release(&mut self) -> io::Result<()> {
        let handle = self.handle as *mut std::ffi::c_void;
        if unsafe { SetEvent(handle) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for TerminalBootstrapGate {
    fn drop(&mut self) {
        if self.handle != 0 {
            unsafe {
                let _ = CloseHandle(self.handle as *mut std::ffi::c_void);
            }
        }
    }
}

impl TerminalProcessTree {
    fn attach(
        child: &dyn Child,
        #[cfg(windows)] mut bootstrap_gate: Option<&mut TerminalBootstrapGate>,
    ) -> Result<Self, String> {
        let process_id = child
            .process_id()
            .ok_or_else(|| "The PTY backend did not expose its child process ID.".to_string())?;
        #[cfg(target_os = "linux")]
        {
            Ok(Self {
                linux_session: super::process_group::LinuxTerminalSession::attach(process_id)
                    .map_err(|error| format!("Unable to track the terminal session. {error}"))?,
            })
        }
        #[cfg(all(unix, not(target_os = "linux")))]
        {
            // portable-pty starts Unix PTY children with setsid(), so the shell
            // process ID is also the process-group ID inherited by its children.
            Ok(Self {
                process_group: process_id,
            })
        }
        #[cfg(windows)]
        {
            let process = child.as_raw_handle().ok_or_else(|| {
                "The ConPTY backend did not expose its process handle.".to_string()
            })? as *mut std::ffi::c_void;
            let job = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
            if job.is_null() {
                return Err(format!(
                    "Unable to create the terminal Job Object. {}",
                    io::Error::last_os_error()
                ));
            }

            let mut limits = TerminalJobObjectExtendedLimitInformation::default();
            limits.basic.limit_flags = TERMINAL_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    job,
                    TERMINAL_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                    (&mut limits as *mut TerminalJobObjectExtendedLimitInformation).cast(),
                    std::mem::size_of::<TerminalJobObjectExtendedLimitInformation>() as u32,
                )
            } != 0;
            let assigned = configured && unsafe { AssignProcessToJobObject(job, process) != 0 };
            if !assigned {
                let error = io::Error::last_os_error();
                unsafe {
                    let _ = CloseHandle(job);
                }
                return Err(format!(
                    "Unable to assign the ConPTY process to its Job Object. {error}"
                ));
            }
            if let Some(gate) = bootstrap_gate.as_deref_mut() {
                if let Err(error) = gate.release() {
                    unsafe {
                        let _ = TerminateJobObject(job, 1);
                        let _ = WaitForSingleObject(
                            job,
                            TERMINAL_READER_JOIN_TIMEOUT.as_millis() as u32,
                        );
                        let _ = CloseHandle(job);
                    }
                    return Err(format!(
                        "Unable to release the terminal shell startup gate after Job Object assignment. {error}"
                    ));
                }
            }
            Ok(Self {
                job: job as isize,
                process_id,
                _startup_gate: None,
            })
        }
    }

    fn terminate(&self) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        {
            self.linux_session
                .terminate(Instant::now() + TERMINAL_READER_JOIN_TIMEOUT)
                .map_err(|error| format!("Unable to terminate terminal session jobs. {error}"))
        }
        #[cfg(all(unix, not(target_os = "linux")))]
        {
            let result = unsafe { libc::kill(-(self.process_group as i32), libc::SIGKILL) };
            if result == 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if super::process_group::is_group_gone(&error) {
                Ok(())
            } else {
                Err(format!(
                    "Unable to terminate terminal process group. {error}"
                ))
            }
        }
        #[cfg(windows)]
        {
            let job = self.job as *mut std::ffi::c_void;
            match unsafe { WaitForSingleObject(job, 0) } {
                TERMINAL_WAIT_OBJECT_0 => return Ok(()),
                TERMINAL_WAIT_TIMEOUT => {}
                TERMINAL_WAIT_FAILED => {
                    return Err(format!(
                        "Unable to inspect terminal Job Object. {}",
                        io::Error::last_os_error()
                    ));
                }
                result => return Err(format!("Unexpected terminal Job Object result: {result}.")),
            }
            if unsafe { TerminateJobObject(job, 1) } != 0 {
                return Ok(());
            }
            let job_error = io::Error::last_os_error();
            if unsafe { WaitForSingleObject(job, 0) } == TERMINAL_WAIT_OBJECT_0 {
                Ok(())
            } else if terminate_untracked_terminal_tree_by_id(self.process_id).is_ok() {
                Ok(())
            } else {
                Err(format!(
                    "Unable to terminate terminal process tree for PID {} with its Job Object ({job_error}) or taskkill.",
                    self.process_id
                ))
            }
        }
    }

    fn wait_until_empty(&self, deadline: Instant) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        {
            let _ = deadline;
            if self.linux_session.is_empty() {
                Ok(())
            } else {
                Err("Terminal session cleanup has not completed.".to_string())
            }
        }
        #[cfg(all(unix, not(target_os = "linux")))]
        {
            loop {
                let result = unsafe { libc::kill(-(self.process_group as i32), 0) };
                if result != 0 {
                    let error = io::Error::last_os_error();
                    if super::process_group::is_group_gone(&error) {
                        return Ok(());
                    }
                    return Err(format!("Unable to inspect terminal process group. {error}"));
                }
                if Instant::now() >= deadline {
                    return Err(
                        "Terminal child processes did not exit before the cleanup deadline."
                            .to_string(),
                    );
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
        #[cfg(windows)]
        {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let timeout = remaining.as_millis().min(u32::MAX as u128) as u32;
            match unsafe { WaitForSingleObject(self.job as *mut std::ffi::c_void, timeout) } {
                TERMINAL_WAIT_OBJECT_0 => Ok(()),
                TERMINAL_WAIT_TIMEOUT => Err(
                    "Terminal child processes did not leave the Job Object before the cleanup deadline."
                        .to_string(),
                ),
                TERMINAL_WAIT_FAILED => Err(format!(
                    "Unable to wait for terminal Job Object cleanup. {}",
                    io::Error::last_os_error()
                )),
                result => Err(format!("Unexpected terminal Job Object cleanup result: {result}.")),
            }
        }
    }
}

#[cfg(windows)]
impl Drop for TerminalProcessTree {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.job as *mut std::ffi::c_void);
        }
    }
}

fn terminate_untracked_terminal_tree(child: &dyn Child) -> Result<(), String> {
    #[cfg(windows)]
    {
        let process_id = child
            .process_id()
            .ok_or_else(|| "ConPTY did not expose a PID for tree cleanup.".to_string())?;
        terminate_untracked_terminal_tree_by_id(process_id)
    }
    #[cfg(not(windows))]
    {
        let _ = child;
        Ok(())
    }
}

#[cfg(windows)]
fn terminate_untracked_terminal_tree_by_id(process_id: u32) -> Result<(), String> {
    let mut taskkill = Command::new("taskkill")
        .args(["/PID", &process_id.to_string(), "/T", "/F"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| {
            format!("Unable to start taskkill for terminal PID {process_id}. {error}")
        })?;
    let deadline = Instant::now() + Duration::from_millis(250);
    loop {
        match taskkill.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => {
                return Err(format!(
                    "taskkill failed for terminal PID {process_id}: {status:?}."
                ));
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = taskkill.kill();
                return Err(format!("taskkill timed out for terminal PID {process_id}."));
            }
            Err(error) => {
                let _ = taskkill.kill();
                return Err(format!(
                    "Unable to wait for taskkill for terminal PID {process_id}. {error}"
                ));
            }
        }
    }
}

#[cfg(windows)]
type TerminalWindowsHandle = *mut std::ffi::c_void;

#[cfg(windows)]
const TERMINAL_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: u32 = 9;
#[cfg(windows)]
const TERMINAL_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
#[cfg(windows)]
const TERMINAL_WAIT_OBJECT_0: u32 = 0;
#[cfg(windows)]
const TERMINAL_WAIT_TIMEOUT: u32 = 258;
#[cfg(windows)]
const TERMINAL_WAIT_FAILED: u32 = u32::MAX;
#[cfg(windows)]
const TERMINAL_THREAD_TERMINATE: u32 = 0x0001;

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct TerminalJobObjectBasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct TerminalWindowsIoCounters {
    read_operations: u64,
    write_operations: u64,
    other_operations: u64,
    read_bytes: u64,
    write_bytes: u64,
    other_bytes: u64,
}

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct TerminalJobObjectExtendedLimitInformation {
    basic: TerminalJobObjectBasicLimitInformation,
    io_info: TerminalWindowsIoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn AssignProcessToJobObject(job: TerminalWindowsHandle, process: TerminalWindowsHandle) -> i32;
    fn CloseHandle(handle: TerminalWindowsHandle) -> i32;
    fn CreateJobObjectW(
        attributes: *mut std::ffi::c_void,
        name: *const u16,
    ) -> TerminalWindowsHandle;
    fn CreateEventW(
        attributes: *mut std::ffi::c_void,
        manual_reset: i32,
        initial_state: i32,
        name: *const u16,
    ) -> TerminalWindowsHandle;
    fn SetEvent(event: TerminalWindowsHandle) -> i32;
    fn SetInformationJobObject(
        job: TerminalWindowsHandle,
        information_class: u32,
        information: *mut std::ffi::c_void,
        information_length: u32,
    ) -> i32;
    fn TerminateJobObject(job: TerminalWindowsHandle, exit_code: u32) -> i32;
    fn WaitForSingleObject(handle: TerminalWindowsHandle, milliseconds: u32) -> u32;
    fn CancelSynchronousIo(thread: TerminalWindowsHandle) -> i32;
    fn GetCurrentThreadId() -> u32;
    fn OpenThread(access: u32, inherit: i32, thread_id: u32) -> TerminalWindowsHandle;
}

struct TerminalReaderCompletion(Arc<AtomicBool>);

impl Drop for TerminalReaderCompletion {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

fn monitor_terminal_process(
    session: &TerminalSession,
    on_exit: impl FnOnce(&TerminalSession),
) -> Result<(), String> {
    loop {
        if session.stop_requested.load(Ordering::Acquire) {
            return Ok(());
        }
        let exited = {
            let mut child = session
                .child
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match child.as_mut() {
                Some(child) => match terminal_child_has_exited(child.as_mut()) {
                    Ok(exited) => exited,
                    Err(error) => {
                        return Err(format!("Unable to inspect terminal process. {error}"));
                    }
                },
                None => return Ok(()),
            }
        };
        if exited {
            on_exit(session);
            return Ok(());
        }
        if session.reader_finished.load(Ordering::Acquire) {
            on_exit(session);
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
}

const TERMINAL_READER_JOIN_TIMEOUT: Duration = Duration::from_secs(2);
const TERMINAL_STOP_LOCK_TIMEOUT: Duration = Duration::from_secs(2);
const TERMINAL_BATCH_CLEANUP_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) fn stop_terminal_session(session: &TerminalSession) -> Result<Option<String>, String> {
    session.stop_requested.store(true, Ordering::Release);
    session.output_flow.request_stop();
    let _stop = lock_terminal_stop(&session.stop_lock)?;

    let mut process_status = None;
    let mut errors = Vec::new();
    let mut process_tree = session
        .process_tree
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Keep Linux's nonreaping process checks out while the anchored session is
    // enumerated, killed, and finally reaped. No writer lock is held here.
    let mut child = session
        .child
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(process_tree) = process_tree.as_ref() {
        if let Err(error) = process_tree.terminate() {
            errors.push(error);
        }
    }
    cancel_blocking_terminal_writer(session);
    // A failed Linux scan must retain its SID anchor for a safe cleanup retry.
    let may_reap = !cfg!(target_os = "linux") || errors.is_empty();
    if let Some(process) = child.as_mut().filter(|_| may_reap) {
        match terminate_terminal_child(process.as_mut()) {
            Ok(status) => {
                process_status = Some(status);
                *child = None;
            }
            Err(error) => errors.push(error),
        }
    }
    drop(child);
    if let Some(process_tree) = process_tree.as_ref() {
        if let Err(error) =
            process_tree.wait_until_empty(Instant::now() + TERMINAL_READER_JOIN_TIMEOUT)
        {
            errors.push(error);
        }
    }
    if errors.is_empty() {
        process_tree.take();
    }
    drop(process_tree);

    let master = session
        .master
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    drop(master);
    if let Err(error) = close_terminal_writer(session) {
        errors.push(error);
    }

    join_terminal_worker(&session.reader_thread, "reader", true, &mut errors);
    join_terminal_worker(
        &session.process_watcher,
        "process monitor",
        false,
        &mut errors,
    );
    terminal_stop_result(process_status, errors)
}

/// Stops every terminal in a window concurrently, with one deadline for the
/// whole batch. Failed or timed-out sessions are returned so the caller can
/// keep them registered and prevent the owning window from being destroyed.
pub(crate) fn stop_terminal_sessions(
    sessions: Vec<(String, Arc<TerminalSession>)>,
) -> (Vec<(String, Arc<TerminalSession>)>, Result<(), String>) {
    let deadline = Instant::now() + TERMINAL_BATCH_CLEANUP_TIMEOUT;
    let (result_sender, result_receiver) = std::sync::mpsc::channel();
    let mut pending = HashMap::new();
    let mut failed = Vec::new();
    let mut errors = Vec::new();

    for (session_id, session) in sessions {
        let worker_session = Arc::clone(&session);
        let worker_sender = result_sender.clone();
        let worker_session_id = session_id.clone();
        let thread_name = format!(
            "pude-terminal-stop-{}",
            session_id.chars().take(8).collect::<String>()
        );
        match thread::Builder::new().name(thread_name).spawn(move || {
            let result = stop_terminal_session(&worker_session).map(|_| ());
            let _ = worker_sender.send((worker_session_id, result));
        }) {
            Ok(worker) => {
                pending.insert(session_id, (session, worker));
            }
            Err(error) => {
                errors.push(format!(
                    "{session_id}: unable to start cleanup worker: {error}"
                ));
                failed.push((session_id, session));
            }
        }
    }
    drop(result_sender);

    let mut timed_out = false;
    while !pending.is_empty() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            timed_out = true;
            break;
        }
        match result_receiver.recv_timeout(remaining) {
            Ok((session_id, result)) => {
                let Some((session, worker)) = pending.remove(&session_id) else {
                    continue;
                };
                drop(worker);
                if let Err(error) = result {
                    errors.push(format!("{session_id}: {error}"));
                    failed.push((session_id, session));
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                timed_out = true;
                break;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    if !pending.is_empty() {
        let reason = if timed_out {
            format!(
                "cleanup did not finish within {} seconds",
                TERMINAL_BATCH_CLEANUP_TIMEOUT.as_secs()
            )
        } else {
            "cleanup worker ended without reporting a result".to_string()
        };
        for (session_id, (session, worker)) in pending.drain() {
            drop(worker);
            errors.push(format!("{session_id}: {reason}"));
            failed.push((session_id, session));
        }
    }

    failed.sort_by(|left, right| left.0.cmp(&right.0));
    errors.sort();
    let result = if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Unable to clean up terminal sessions: {}",
            errors.join("; ")
        ))
    };
    (failed, result)
}

fn lock_terminal_stop(stop_lock: &Mutex<()>) -> Result<std::sync::MutexGuard<'_, ()>, String> {
    let deadline = Instant::now() + TERMINAL_STOP_LOCK_TIMEOUT;
    loop {
        match stop_lock.try_lock() {
            Ok(lock) => return Ok(lock),
            Err(std::sync::TryLockError::Poisoned(error)) => return Ok(error.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                return Err(
                    "Terminal cleanup could not acquire its stop lock before the deadline."
                        .to_string(),
                );
            }
        }
    }
}

fn cleanup_failed_terminal_start(
    session_id: &str,
    terminals: &Mutex<HashMap<String, Arc<TerminalSession>>>,
    session: &Arc<TerminalSession>,
    lifecycle: &TerminalLifecycle,
    message: String,
) -> String {
    let mut sessions = terminals
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if sessions
        .get(session_id)
        .is_some_and(|stored| Arc::ptr_eq(stored, session))
    {
        sessions.remove(session_id);
    }
    drop(sessions);

    match stop_terminal_session(session) {
        Ok(_) => message,
        Err(error) => {
            lifecycle.register_if_open(terminals, session_id, session);
            format!("{message}; cleanup failed: {error}")
        }
    }
}

fn join_terminal_worker(
    worker_slot: &Mutex<Option<JoinHandle<()>>>,
    worker_name: &str,
    interrupt_blocking_read: bool,
    errors: &mut Vec<String>,
) {
    let mut worker_slot = worker_slot
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(worker) = worker_slot.as_ref() else {
        return;
    };
    if worker.thread().id() == thread::current().id() {
        // The reader or monitor can own the cleanup call after reaching EOF or
        // observing child exit. Its handle drops as this thread returns.
        return;
    }
    if !wait_for_terminal_reader(worker, TERMINAL_READER_JOIN_TIMEOUT) && interrupt_blocking_read {
        cancel_blocking_terminal_read(worker);
    }
    if !wait_for_terminal_reader(worker, TERMINAL_READER_JOIN_TIMEOUT) {
        errors.push(format!(
            "Terminal {worker_name} did not stop within {} seconds.",
            TERMINAL_READER_JOIN_TIMEOUT.as_secs() * 2
        ));
        return;
    }
    let worker = worker_slot.take().expect("worker handle was present");
    drop(worker_slot);
    if worker.join().is_err() {
        errors.push(format!(
            "Terminal {worker_name} thread panicked during shutdown."
        ));
    }
}

fn terminate_terminal_child(child: &mut (dyn Child + Send)) -> Result<String, String> {
    match child.try_wait() {
        Ok(Some(status)) => return Ok(format!("{status:?}")),
        Ok(None) => {
            let _ = child.kill();
        }
        Err(error) => {
            let _ = child.kill();
            let status = wait_for_terminal_child(child, TERMINAL_READER_JOIN_TIMEOUT)?;
            return status
                .ok_or_else(|| {
                    format!(
                        "Unable to inspect terminal process ({error}); it did not exit after Kill."
                    )
                })
                .map(|status| format!("{status:?}"));
        }
    }
    wait_for_terminal_child(child, TERMINAL_READER_JOIN_TIMEOUT)?
        .map(|status| format!("{status:?}"))
        .ok_or_else(|| "Terminal child did not exit within 2 seconds after Kill.".to_string())
}

fn wait_for_terminal_child(
    child: &mut (dyn Child + Send),
    timeout: Duration,
) -> Result<Option<portable_pty::ExitStatus>, String> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(Some(status)),
            Ok(None) => {}
            Err(error) => {
                return Err(format!(
                    "Unable to inspect terminal process while waiting. {error}"
                ))
            }
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn close_terminal_writer(session: &TerminalSession) -> Result<(), String> {
    let deadline = Instant::now() + TERMINAL_READER_JOIN_TIMEOUT;
    loop {
        match session.writer.try_lock() {
            Ok(mut writer) => {
                drop(writer.take());
                return Ok(());
            }
            Err(std::sync::TryLockError::Poisoned(error)) => {
                drop(error.into_inner().take());
                return Ok(());
            }
            Err(std::sync::TryLockError::WouldBlock) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                return Err(
                    "Terminal writer did not stop within 2 seconds after the PTY closed."
                        .to_string(),
                );
            }
        }
    }
}

#[cfg(windows)]
fn cancel_blocking_terminal_writer(session: &TerminalSession) {
    let thread_id = session.writer_thread_id.load(Ordering::Acquire);
    if thread_id == 0 {
        return;
    }
    let thread = unsafe { OpenThread(TERMINAL_THREAD_TERMINATE, 0, thread_id) };
    if thread.is_null() {
        return;
    }
    unsafe {
        let _ = CancelSynchronousIo(thread);
        let _ = CloseHandle(thread);
    }
}

#[cfg(not(windows))]
fn cancel_blocking_terminal_writer(_session: &TerminalSession) {}

fn terminal_stop_result(
    status: Option<String>,
    errors: Vec<String>,
) -> Result<Option<String>, String> {
    if errors.is_empty() {
        Ok(status)
    } else {
        Err(errors.join(" "))
    }
}

fn wait_for_terminal_reader(reader: &JoinHandle<()>, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while !reader.is_finished() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    reader.is_finished()
}

#[cfg(windows)]
fn cancel_blocking_terminal_read(reader: &JoinHandle<()>) {
    use std::os::windows::io::AsRawHandle;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CancelSynchronousIo(thread_handle: *mut std::ffi::c_void) -> i32;
    }

    unsafe {
        let _ = CancelSynchronousIo(reader.as_raw_handle() as *mut std::ffi::c_void);
    }
}

#[cfg(not(windows))]
fn cancel_blocking_terminal_read(_reader: &JoinHandle<()>) {}

pub(crate) fn take_window_terminals(
    terminals: &Mutex<HashMap<String, Arc<TerminalSession>>>,
    window_label: &str,
) -> Result<Vec<(String, Arc<TerminalSession>)>, String> {
    let mut terminals = terminals
        .lock()
        .map_err(|_| "Unable to lock terminal state.".to_string())?;
    let session_ids: Vec<String> = terminals
        .iter()
        .filter(|(_, session)| session.owner_window == window_label)
        .map(|(id, _)| id.clone())
        .collect();
    Ok(session_ids
        .into_iter()
        .filter_map(|id| terminals.remove(&id).map(|session| (id, session)))
        .collect())
}

#[cfg(test)]
pub(crate) fn test_terminal_session(owner_window: &str) -> Arc<TerminalSession> {
    Arc::new(TerminalSession {
        master: Mutex::new(None),
        writer: Mutex::new(None),
        child: Mutex::new(None),
        process_tree: Mutex::new(None),
        #[cfg(windows)]
        writer_thread_id: AtomicU32::new(0),
        reader_thread: Mutex::new(None),
        process_watcher: Mutex::new(None),
        stop_lock: Mutex::new(()),
        stop_requested: AtomicBool::new(false),
        reader_finished: Arc::new(AtomicBool::new(false)),
        owner_window: owner_window.to_string(),
        output_flow: TerminalOutputFlow::new(1),
        output_channel: tauri::ipc::Channel::new(|_| Ok(())),
    })
}

#[cfg(test)]
mod lifecycle_reservation_tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn late_start_and_cleanup_retry_cannot_revive_a_destroyed_window() {
        let lifecycle = TerminalLifecycle::default();
        let terminals = Mutex::new(HashMap::new());
        let reservation = lifecycle.reserve("closed").unwrap();
        let other = test_terminal_session("other");
        assert!(lifecycle.register_if_open(&terminals, "other-session", &other));
        assert!(lifecycle
            .retire_window(&terminals, "closed")
            .unwrap()
            .is_empty());
        assert!(reservation.load(Ordering::Acquire));
        assert!(lifecycle.reserve("closed").is_err());
        let late = test_terminal_session("closed");
        assert!(!lifecycle.register_if_open(&terminals, "late-start", &late));
        assert!(!lifecycle.register_if_open(&terminals, "cleanup-retry", &late));
        assert_eq!(terminals.lock().unwrap().len(), 1);
    }

    #[test]
    fn slow_start_does_not_hold_the_window_cleanup_lock() {
        let lifecycle = Arc::new(TerminalLifecycle::default());
        let terminals = Arc::new(Mutex::new(HashMap::new()));
        for index in 0..4 {
            lifecycle.register_if_open(
                &terminals,
                &index.to_string(),
                &test_terminal_session("closing"),
            );
        }
        let cancellation = lifecycle.reserve("starting").unwrap();
        let (release, wait) = mpsc::channel();
        let worker_lifecycle = Arc::clone(&lifecycle);
        let worker_terminals = Arc::clone(&terminals);
        let worker = thread::spawn(move || {
            wait.recv_timeout(Duration::from_secs(2)).unwrap();
            assert!(cancellation.load(Ordering::Acquire));
            assert!(!worker_lifecycle.register_if_open(
                &worker_terminals,
                "late",
                &test_terminal_session("starting")
            ));
        });
        let started = Instant::now();
        let removed = lifecycle.retire_window(&terminals, "closing").unwrap();
        lifecycle.retire_window(&terminals, "starting").unwrap();
        assert_eq!(removed.len(), 4);
        assert!(started.elapsed() < Duration::from_millis(100));
        release.send(()).unwrap();
        worker.join().unwrap();
        assert!(terminals.lock().unwrap().is_empty());
    }

    #[test]
    fn slow_stop_of_one_window_does_not_block_another_windows_cleanup() {
        let lifecycle = Arc::new(TerminalLifecycle::default());
        let terminals = Arc::new(Mutex::new(HashMap::new()));
        let slow = test_terminal_session("slow");
        lifecycle.register_if_open(&terminals, "slow", &slow);
        lifecycle.register_if_open(&terminals, "closing", &test_terminal_session("closing"));
        let native_stop = slow.stop_lock.lock().unwrap();
        let worker_terminals = Arc::clone(&terminals);
        let worker_lifecycle = Arc::clone(&lifecycle);
        let worker = thread::spawn(move || {
            terminal_kill_sync("slow".to_string(), worker_terminals, worker_lifecycle)
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while terminals.lock().unwrap().contains_key("slow") {
            assert!(Instant::now() < deadline);
            thread::yield_now();
        }
        let started = Instant::now();
        assert_eq!(
            lifecycle
                .retire_window(&terminals, "closing")
                .unwrap()
                .len(),
            1
        );
        assert!(started.elapsed() < Duration::from_millis(100));
        lifecycle.retire_window(&terminals, "slow").unwrap();
        drop(native_stop);
        worker.join().unwrap().unwrap();
        assert!(terminals.lock().unwrap().is_empty());
    }
}

#[cfg(test)]
impl TerminalSession {
    pub(crate) fn is_stop_requested(&self) -> bool {
        self.stop_requested.load(Ordering::Acquire)
    }
}
