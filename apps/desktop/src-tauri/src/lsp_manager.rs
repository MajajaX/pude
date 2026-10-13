use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin};
#[cfg(not(windows))]
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TryRecvError};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub const MAX_LSP_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_LSP_HEADER_BYTES: usize = 8 * 1024;
const MAX_LSP_ARGS: usize = 128;
pub const MAX_LSP_SERVERS: usize = 32;
const MAX_LSP_ARG_BYTES: usize = 8 * 1024;
const MAX_LSP_ARGS_BYTES: usize = 64 * 1024;
const MAX_RESTARTS_PER_WINDOW: usize = 3;
const RESTART_WINDOW: Duration = Duration::from_secs(60);
const CONTROL_CHANNEL_CAPACITY: usize = 64;
const IO_CHANNEL_CAPACITY: usize = 32;
const STDERR_CHUNK_BYTES: usize = 4 * 1024;
const MAX_SUPERVISOR_BATCH_EVENTS: usize = 64;
const MAX_SUPERVISOR_BATCH_TIME: Duration = Duration::from_millis(4);
const LSP_CLEANUP_BATCH_TIMEOUT: Duration = Duration::from_secs(15);
const LSP_PROCESS_GROUP_CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
/// Total wall-clock bound for one Windows LSP bootstrap attempt (pipe
/// connect plus payload delivery). Overruns cancel the pending overlapped
/// I/O, terminate the job tree, and reap the handles before reporting a
/// recognizable error.
#[cfg(windows)]
const LSP_STARTUP_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LspServerDeclaration {
    pub server_id: String,
    pub language: String,
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspApprovalGrant {
    pub plugin_id: String,
    pub plugin_version: String,
    pub workspace_root: String,
    pub server: LspServerDeclaration,
    pub expected_executable_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspResolveRequest {
    pub workspace_root: String,
    pub server: LspServerDeclaration,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspResolvedServer {
    pub workspace_root: String,
    pub server_id: String,
    pub language: String,
    pub executable_path: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerRequest {
    pub plugin_id: String,
    pub plugin_version: String,
    pub workspace_root: String,
    pub server: LspServerDeclaration,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspMessageRequest {
    pub plugin_id: String,
    pub plugin_version: String,
    pub workspace_root: String,
    pub language: String,
    pub message: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCancelRequest {
    pub plugin_id: String,
    pub plugin_version: String,
    pub workspace_root: String,
    pub language: String,
    pub request_id: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum LspEvent {
    State {
        plugin_id: String,
        plugin_version: String,
        workspace_root: String,
        language: String,
        server_id: String,
        state: String,
        restart_count: usize,
        message: Option<String>,
    },
    Message {
        plugin_id: String,
        plugin_version: String,
        workspace_root: String,
        language: String,
        server_id: String,
        message: Value,
    },
    Stderr {
        plugin_id: String,
        plugin_version: String,
        workspace_root: String,
        language: String,
        server_id: String,
        text: String,
    },
}

pub type LspEventSink = Arc<dyn Fn(LspEvent) + Send + Sync + 'static>;

#[derive(Default)]
pub struct LspState {
    pub manager: LspManager,
}

#[derive(Clone, Default)]
pub struct LspManager {
    inner: Arc<Mutex<ManagerState>>,
}

#[derive(Default)]
struct ManagerState {
    approvals: HashMap<ApprovalKey, ApprovedServer>,
    sessions: HashMap<SessionKey, SessionHandle>,
    /// Start attempts reserved under the lock and launched after it is
    /// released, keyed by the same session key with a monotonically
    /// increasing generation (`id`) so late completions can be told apart
    /// from the currently valid reservation.
    starting: HashMap<SessionKey, StartingEntry>,
    /// Injectable bootstrap launcher. Production runs the app
    /// executable (which embeds the bootstrap branch); tests inject a helper
    /// binary that speaks the same protocol because the test harness binary
    /// has no bootstrap branch.
    #[cfg(windows)]
    bootstrap_launcher: Option<PathBuf>,
}

struct StartingEntry {
    id: u64,
    approved: ApprovedServer,
    owners: HashSet<String>,
    cancel: StartCancel,
    completion: Arc<StartCompletion>,
    #[cfg(unix)]
    pending_process_group: Option<i32>,
}

struct StartCompletion {
    completed: Mutex<Option<Result<(), String>>>,
    ready: std::sync::Condvar,
}

impl StartCompletion {
    fn new() -> Self {
        Self {
            completed: Mutex::new(None),
            ready: std::sync::Condvar::new(),
        }
    }

    fn complete(&self, result: Result<(), String>) {
        let mut completed = self
            .completed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if completed.is_none() {
            *completed = Some(result);
        }
        self.ready.notify_all();
    }

    fn wait_until(&self, deadline: Instant) -> Option<Result<(), String>> {
        let mut completed = self
            .completed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while completed.is_none() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return None;
            }
            let (next, timeout) = self
                .ready
                .wait_timeout(completed, remaining)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            completed = next;
            if timeout.timed_out() && completed.is_none() {
                return None;
            }
        }
        completed.clone()
    }
}

/// Cancellation token for an in-flight start. Windows additionally signals
/// an event so a blocked overlapped pipe wait wakes immediately; other
/// platforms only record the flag, which the completion path checks when it
/// re-acquires the manager lock.
#[derive(Clone)]
struct StartCancel {
    canceled: Arc<AtomicBool>,
    #[cfg(windows)]
    event: Arc<windows_bootstrap::CancelEvent>,
}

impl StartCancel {
    fn new() -> Result<Self, String> {
        Ok(Self {
            canceled: Arc::new(AtomicBool::new(false)),
            #[cfg(windows)]
            event: Arc::new(windows_bootstrap::CancelEvent::new()?),
        })
    }

    fn cancel(&self) {
        self.canceled.store(true, Ordering::Release);
        #[cfg(windows)]
        self.event.set();
    }

    fn is_canceled(&self) -> bool {
        self.canceled.load(Ordering::Acquire)
    }

    #[cfg(windows)]
    fn event_handle(&self) -> *mut std::ffi::c_void {
        self.event.raw()
    }
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct ApprovalKey {
    plugin_id: String,
    plugin_version: String,
    workspace_root: PathBuf,
    server_id: String,
    language: String,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct SessionKey {
    owner_window: String,
    workspace_root: PathBuf,
    language: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ApprovedServer {
    key: ApprovalKey,
    executable: PathBuf,
    args: Vec<String>,
}

#[derive(Clone)]
struct SessionHandle {
    id: u64,
    approved: ApprovedServer,
    owners: HashSet<String>,
    control: SyncSender<ControlMessage>,
    wakeup: Arc<SupervisorWakeup>,
    stop_lock: Arc<Mutex<()>>,
    stopping: Arc<AtomicBool>,
    stop_requested: Arc<AtomicBool>,
    cleanup_worker_active: Arc<AtomicBool>,
    process_group: Arc<AtomicI32>,
}

enum ControlMessage {
    Send(Value),
    Cancel(Value),
    Stop(SyncSender<Result<(), String>>),
}

enum ProcessIoMessage {
    Message(Value),
    Stderr(Vec<u8>),
    Closed,
    Failed(String),
}

struct ChildRuntime {
    child: Child,
    stdin: ChildStdin,
    io: Receiver<ProcessIoMessage>,
    wakeup: Arc<SupervisorWakeup>,
    io_thread: JoinHandle<()>,
    stderr_thread: JoinHandle<()>,
    #[cfg(windows)]
    job: windows_job::JobObject,
}

/// Wakes the supervisor when either its control queue or child IO queue gets
/// work. The queues stay independently bounded; the generation counter makes
/// the idle wait race-free when a producer notifies between the queue checks
/// and the Condvar wait.
#[derive(Default)]
struct SupervisorWakeup {
    generation: Mutex<u64>,
    changed: Condvar,
}

impl SupervisorWakeup {
    fn generation(&self) -> u64 {
        *self
            .generation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn notify(&self) {
        let mut generation = self
            .generation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *generation = generation.wrapping_add(1);
        self.changed.notify_one();
    }

    fn wait_if_unchanged(&self, observed_generation: u64) {
        let mut generation = self
            .generation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while *generation == observed_generation {
            generation = self
                .changed
                .wait(generation)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    fn wait_if_unchanged_for(&self, observed_generation: u64, timeout: Duration) -> bool {
        let mut generation = self
            .generation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if *generation != observed_generation {
            return true;
        }
        let (generation, result) = self
            .changed
            .wait_timeout_while(generation, timeout, |generation| {
                *generation == observed_generation
            })
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *generation != observed_generation || !result.timed_out()
    }
}

enum SupervisorExit {
    Stopped(Option<SyncSender<Result<(), String>>>),
    Unexpected,
}

impl LspManager {
    /// Records an exact executable and argument tuple after the host has accepted
    /// the scoped `process.spawn:lsp` grant. Starting still requires the same
    /// manifest declaration and canonical workspace to match this record.
    pub fn approve(&self, grant: LspApprovalGrant) -> Result<(), String> {
        let approved = canonicalize_server(
            &grant.plugin_id,
            &grant.plugin_version,
            &grant.workspace_root,
            &grant.server,
        )?;
        if Path::new(&grant.expected_executable_path) != approved.executable {
            return Err("LSP executable changed after it was reviewed.".to_string());
        }
        let (stale_sessions, stale_starting) = {
            let mut state = self
                .inner
                .lock()
                .map_err(|_| "Unable to lock LSP approvals.".to_string())?;
            state.approvals.retain(|key, _| {
                key.plugin_id != approved.key.plugin_id
                    || key.plugin_version == approved.key.plugin_version
            });
            state
                .approvals
                .insert(approved.key.clone(), approved.clone());
            let stale_keys = state
                .sessions
                .iter()
                .filter(|(_, session)| {
                    session.approved.key.plugin_id == approved.key.plugin_id
                        && (session.approved.key.plugin_version != approved.key.plugin_version
                            || (session.approved.key == approved.key
                                && session.approved != approved))
                })
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>();
            let stale_sessions = stale_keys
                .into_iter()
                .filter_map(|key| state.sessions.remove(&key))
                .collect::<Vec<_>>();
            // An approval change must also cancel in-flight starts,
            // otherwise a late completion would revive a session whose
            // approval no longer matches.
            let stale_starting_keys = state
                .starting
                .iter()
                .filter(|(_, entry)| {
                    entry.approved.key.plugin_id == approved.key.plugin_id
                        && (entry.approved.key.plugin_version != approved.key.plugin_version
                            || (entry.approved.key == approved.key && entry.approved != approved))
                })
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>();
            let stale_starting = stale_starting_keys
                .into_iter()
                .filter_map(|key| state.starting.remove(&key))
                .collect::<Vec<_>>();
            (stale_sessions, stale_starting)
        };
        cancel_starting(stale_starting);
        stop_sessions(stale_sessions)
    }

    pub fn revoke(
        &self,
        plugin_id: &str,
        plugin_version: &str,
        workspace_root: &str,
        server_id: &str,
        language: &str,
    ) -> Result<(), String> {
        let workspace_root = canonical_workspace(workspace_root)?;
        let key = ApprovalKey {
            plugin_id: plugin_id.to_string(),
            plugin_version: plugin_version.to_string(),
            workspace_root: workspace_root.clone(),
            server_id: server_id.to_string(),
            language: language.to_string(),
        };
        let (sessions, starting) = {
            let mut state = self
                .inner
                .lock()
                .map_err(|_| "Unable to lock LSP state.".to_string())?;
            state.approvals.remove(&key);
            let session_keys = state
                .sessions
                .iter()
                .filter(|(_, session)| session.approved.key == key)
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>();
            let sessions = session_keys
                .into_iter()
                .filter_map(|key| state.sessions.remove(&key))
                .collect::<Vec<_>>();
            let starting_keys = state
                .starting
                .iter()
                .filter(|(_, entry)| entry.approved.key == key)
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>();
            let starting = starting_keys
                .into_iter()
                .filter_map(|key| state.starting.remove(&key))
                .collect::<Vec<_>>();
            (sessions, starting)
        };
        cancel_starting(starting);
        stop_sessions(sessions)
    }

    /// Starts an approved LSP server. Validation and a generation-tagged
    /// `starting` reservation happen under the lock; the blocking process
    /// spawn then runs on a dedicated worker thread so the caller —
    /// including the Tauri command path — never blocks on pipe I/O. The
    /// result is delivered through the event sink: `started` once the
    /// session is registered, `startFailed` with a stage-tagged diagnostic
    /// when the bootstrap fails, or `stopped` when the start was canceled
    /// before completion. A late completion never revives a revoked or
    /// superseded start, and a failed start removes its reservation so the
    /// next call can retry.
    pub fn start(
        &self,
        request: LspServerRequest,
        owner_window: &str,
        event_sink: LspEventSink,
    ) -> Result<(), String> {
        if owner_window.is_empty() {
            return Err("LSP owner window is required.".to_string());
        }
        let requested = canonicalize_server(
            &request.plugin_id,
            &request.plugin_version,
            &request.workspace_root,
            &request.server,
        )?;
        let session_key = SessionKey {
            owner_window: owner_window.to_string(),
            workspace_root: requested.key.workspace_root.clone(),
            language: requested.key.language.clone(),
        };

        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Unable to lock LSP state.".to_string())?;
        let approved = state.approvals.get(&requested.key).ok_or_else(|| {
            "No exact process.spawn:lsp approval exists for this server.".to_string()
        })?;
        if approved != &requested {
            return Err("LSP executable or arguments differ from the approved server.".to_string());
        }
        if let Some(session) = state.sessions.get_mut(&session_key) {
            if session.approved != requested {
                return Err(
                    "A different LSP server is already running for this workspace and language."
                        .to_string(),
                );
            }
            if session.stopping.load(Ordering::Acquire) {
                return Err(
                    "The previous LSP session is still cleaning up for this workspace and language."
                        .to_string(),
                );
            }
            return Err(
                "An LSP server is already running for this window and language.".to_string(),
            );
        }
        if let Some(starting) = state.starting.get_mut(&session_key) {
            if starting.approved != requested {
                return Err(
                    "A different LSP server is already starting for this workspace and language."
                        .to_string(),
                );
            }
            if starting.cancel.is_canceled() {
                return Err(
                    "The previous LSP start is still cleaning up for this workspace and language."
                        .to_string(),
                );
            }
            return Err(
                "An LSP server is already starting for this window and language.".to_string(),
            );
        }
        #[cfg(windows)]
        let launcher = state.bootstrap_launcher.clone();
        #[cfg(not(windows))]
        let launcher: Option<PathBuf> = None;
        let id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
        let cancel = StartCancel::new()?;
        let completion = Arc::new(StartCompletion::new());
        state.starting.insert(
            session_key.clone(),
            StartingEntry {
                id,
                approved: requested.clone(),
                owners: HashSet::from([owner_window.to_string()]),
                cancel: cancel.clone(),
                completion: Arc::clone(&completion),
                #[cfg(unix)]
                pending_process_group: None,
            },
        );
        drop(state);

        let weak_inner = Arc::downgrade(&self.inner);
        let thread_session_key = session_key.clone();
        let worker_completion = Arc::clone(&completion);
        let wakeup = Arc::new(SupervisorWakeup::default());
        let worker = thread::Builder::new()
            .name("pude-lsp-startup".to_string())
            .spawn(move || {
                let spawned =
                    spawn_child_with_wakeup(&requested, launcher.as_deref(), &cancel, wakeup);
                match spawned {
                    Ok(runtime) => complete_start(
                        weak_inner,
                        thread_session_key,
                        id,
                        requested,
                        runtime,
                        event_sink,
                        launcher,
                        worker_completion,
                    ),
                    Err(error) => {
                        fail_start(
                            weak_inner,
                            thread_session_key,
                            id,
                            requested,
                            error,
                            event_sink,
                            cancel,
                        );
                        worker_completion.complete(Ok(()));
                    }
                }
            });
        if let Err(error) = worker {
            completion.complete(Ok(()));
            let error = format!("Unable to start LSP startup worker. {error}");
            if let Ok(mut state) = self.inner.lock() {
                if state
                    .starting
                    .get(&session_key)
                    .is_some_and(|entry| entry.id == id)
                {
                    state.starting.remove(&session_key);
                }
            }
            return Err(error);
        }
        Ok(())
    }

    #[cfg(all(test, windows))]
    fn set_bootstrap_launcher(&self, launcher: Option<PathBuf>) {
        if let Ok(mut state) = self.inner.lock() {
            state.bootstrap_launcher = launcher;
        }
    }

    pub fn send(&self, request: LspMessageRequest, owner_window: &str) -> Result<(), String> {
        self.send_control(
            &request.plugin_id,
            &request.plugin_version,
            &request.workspace_root,
            &request.language,
            owner_window,
            ControlMessage::Send(request.message),
        )
    }

    pub fn cancel(&self, request: LspCancelRequest, owner_window: &str) -> Result<(), String> {
        validate_request_id(&request.request_id)?;
        self.send_control(
            &request.plugin_id,
            &request.plugin_version,
            &request.workspace_root,
            &request.language,
            owner_window,
            ControlMessage::Cancel(request.request_id),
        )
    }

    pub fn stop(
        &self,
        plugin_id: &str,
        plugin_version: &str,
        workspace_root: &str,
        language: &str,
        owner_window: &str,
    ) -> Result<(), String> {
        let workspace_root = canonical_workspace(workspace_root)?;
        let key = SessionKey {
            owner_window: owner_window.to_string(),
            workspace_root,
            language: language.to_string(),
        };
        let (session, starting) = {
            let mut state = self
                .inner
                .lock()
                .map_err(|_| "Unable to lock LSP state.".to_string())?;
            if let Some(session) = state.sessions.get_mut(&key) {
                if session.approved.key.plugin_id != plugin_id
                    || session.approved.key.plugin_version != plugin_version
                {
                    return Err("LSP session belongs to a different plugin.".to_string());
                }
                session.owners.remove(owner_window);
                let session = if session.owners.is_empty() {
                    state.sessions.remove(&key)
                } else {
                    None
                };
                (session, None)
            } else if let Some(entry) = state.starting.get_mut(&key) {
                if entry.approved.key.plugin_id != plugin_id
                    || entry.approved.key.plugin_version != plugin_version
                {
                    return Err("LSP session belongs to a different plugin.".to_string());
                }
                entry.owners.remove(owner_window);
                let entry = if entry.owners.is_empty() {
                    state.starting.remove(&key)
                } else {
                    None
                };
                (None, entry)
            } else {
                (None, None)
            }
        };
        if let Some(entry) = starting {
            entry.cancel.cancel();
        }
        if let Some(session) = session {
            stop_session(session)?;
        }
        Ok(())
    }

    pub fn stop_workspace_for_window(
        &self,
        workspace_root: &str,
        owner_window: &str,
    ) -> Result<(), String> {
        let workspace_root = canonical_workspace(workspace_root)?;
        let (sessions, starting) = {
            let mut state = self
                .inner
                .lock()
                .map_err(|_| "Unable to lock LSP state.".to_string())?;
            let keys = state
                .sessions
                .keys()
                .filter(|key| key.workspace_root == workspace_root)
                .cloned()
                .collect::<Vec<_>>();
            let mut to_stop = Vec::new();
            for key in keys {
                let should_stop = if let Some(session) = state.sessions.get_mut(&key) {
                    session.owners.remove(owner_window);
                    session.owners.is_empty()
                } else {
                    false
                };
                if should_stop {
                    if let Some(session) = state.sessions.remove(&key) {
                        to_stop.push(session);
                    }
                }
            }
            let starting_keys = state
                .starting
                .keys()
                .filter(|key| key.workspace_root == workspace_root)
                .cloned()
                .collect::<Vec<_>>();
            let mut to_cancel = Vec::new();
            for key in starting_keys {
                let should_cancel = if let Some(entry) = state.starting.get_mut(&key) {
                    entry.owners.remove(owner_window);
                    entry.owners.is_empty()
                } else {
                    false
                };
                if should_cancel {
                    if let Some(entry) = state.starting.remove(&key) {
                        to_cancel.push(entry);
                    }
                }
            }
            (to_stop, to_cancel)
        };
        cancel_starting(starting);
        stop_sessions(sessions)
    }

    pub fn stop_plugin(&self, plugin_id: &str) -> Result<(), String> {
        let (sessions, starting) = {
            let mut state = self
                .inner
                .lock()
                .map_err(|_| "Unable to lock LSP state.".to_string())?;
            state.approvals.retain(|key, _| key.plugin_id != plugin_id);
            let keys = state
                .sessions
                .iter()
                .filter(|(_, session)| session.approved.key.plugin_id == plugin_id)
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>();
            let sessions = keys
                .into_iter()
                .filter_map(|key| state.sessions.remove(&key))
                .collect::<Vec<_>>();
            let starting_keys = state
                .starting
                .iter()
                .filter(|(_, entry)| entry.approved.key.plugin_id == plugin_id)
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>();
            let starting = starting_keys
                .into_iter()
                .filter_map(|key| state.starting.remove(&key))
                .collect::<Vec<_>>();
            (sessions, starting)
        };
        cancel_starting(starting);
        stop_sessions(sessions)
    }

    /// SB-01: removes the sessions and in-flight starts owned solely by this
    /// window from the manager under a short lock and returns them for
    /// stopping. Stopping is a separate step so it can run off the main
    /// thread.
    #[cfg(test)]
    pub fn take_window_sessions(&self, owner_window: &str) -> Result<WindowSessions, String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Unable to lock LSP state.".to_string())?;
        let keys = state.sessions.keys().cloned().collect::<Vec<_>>();
        let mut sessions = Vec::new();
        for key in keys {
            let should_stop = if let Some(session) = state.sessions.get_mut(&key) {
                session.owners.remove(owner_window);
                session.owners.is_empty()
            } else {
                false
            };
            if should_stop {
                if let Some(session) = state.sessions.remove(&key) {
                    sessions.push(session);
                }
            }
        }
        let starting_keys = state.starting.keys().cloned().collect::<Vec<_>>();
        let mut starting = Vec::new();
        for key in starting_keys {
            let should_cancel = if let Some(entry) = state.starting.get_mut(&key) {
                entry.owners.remove(owner_window);
                entry.owners.is_empty()
            } else {
                false
            };
            if should_cancel {
                if let Some(entry) = state.starting.remove(&key) {
                    starting.push(entry);
                }
            }
        }
        Ok(WindowSessions { sessions, starting })
    }

    pub fn cleanup_window(&self, owner_window: &str) -> Result<(), String> {
        let deadline = Instant::now() + LSP_CLEANUP_BATCH_TIMEOUT;
        let (sessions, starting, mut errors) = {
            let mut state = self
                .inner
                .lock()
                .map_err(|_| "Unable to lock LSP state.".to_string())?;
            let keys = state.sessions.keys().cloned().collect::<Vec<_>>();
            let mut to_stop = Vec::new();
            let mut errors = Vec::new();
            for key in keys {
                if let Some(session) = state.sessions.get_mut(&key) {
                    if !session.owners.contains(owner_window) {
                        continue;
                    }
                    if session.stopping.load(Ordering::Acquire) {
                        if session.cleanup_worker_active.load(Ordering::Acquire) {
                            errors.push(format!(
                                "{}: LSP cleanup is already in progress.",
                                session.approved.key.server_id
                            ));
                            continue;
                        }
                        // A prior bounded attempt ended without success.
                        // Its worker is finished, so this close attempt can
                        // safely retry the retained session.
                        session.stopping.store(false, Ordering::Release);
                    }
                    if session.owners.len() > 1 {
                        session.owners.remove(owner_window);
                    } else {
                        // Keep the final owner on the session until cleanup
                        // succeeds. A repeated close for the same window can
                        // then observe the in-flight stop and fail closed.
                        session.stopping.store(true, Ordering::Release);
                        to_stop.push((key, session.clone()));
                    }
                }
            }
            let starting_keys = state.starting.keys().cloned().collect::<Vec<_>>();
            let mut to_cancel = Vec::new();
            for key in starting_keys {
                let should_cancel = if let Some(entry) = state.starting.get_mut(&key) {
                    if !entry.owners.contains(owner_window) {
                        false
                    } else if entry.owners.len() > 1 {
                        entry.owners.remove(owner_window);
                        false
                    } else {
                        // Like active sessions, retain the final owner as a
                        // cleanup marker until the canceled launch is reaped.
                        true
                    }
                } else {
                    false
                };
                if should_cancel {
                    if let Some(entry) = state.starting.get(&key) {
                        // Publish cancellation while holding the same lock
                        // complete_start needs to register the process. This
                        // prevents a start from becoming active after the
                        // cleanup snapshot has already been taken.
                        entry.cancel.cancel();
                        to_cancel.push((key.clone(), entry.id, Arc::clone(&entry.completion)));
                    }
                }
            }
            (to_stop, to_cancel, errors)
        };

        let stopping_sessions = sessions
            .iter()
            .map(|(key, session)| (key.clone(), session.id))
            .collect::<Vec<_>>();
        let (failed_sessions, session_result) = stop_sessions_bounded(
            sessions.into_iter().map(|(_, session)| session).collect(),
            deadline,
        );
        if let Ok(mut state) = self.inner.lock() {
            let failed_ids = failed_sessions
                .iter()
                .map(|session| session.id)
                .collect::<HashSet<_>>();
            for (key, id) in stopping_sessions {
                if !failed_ids.contains(&id)
                    && state
                        .sessions
                        .get(&key)
                        .is_some_and(|session| session.id == id)
                {
                    state.sessions.remove(&key);
                }
            }
            for mut session in failed_sessions {
                let key = SessionKey {
                    owner_window: owner_window.to_string(),
                    workspace_root: session.approved.key.workspace_root.clone(),
                    language: session.approved.key.language.clone(),
                };
                if let Some(current) = state.sessions.get_mut(&key) {
                    if current.id == session.id {
                        current.owners.insert(owner_window.to_string());
                        if !current.cleanup_worker_active.load(Ordering::Acquire) {
                            current.stopping.store(false, Ordering::Release);
                        }
                    } else {
                        errors.push(format!(
                            "{}: a different LSP session replaced a process that still needs cleanup.",
                            session.approved.key.server_id
                        ));
                    }
                } else {
                    session.owners.insert(owner_window.to_string());
                    if !session.cleanup_worker_active.load(Ordering::Acquire) {
                        session.stopping.store(false, Ordering::Release);
                    }
                    state.sessions.insert(key, session);
                }
            }
        }

        errors.extend(session_result.err());
        for (key, id, completion) in starting {
            match completion.wait_until(deadline) {
                Some(Ok(())) => {}
                Some(Err(error)) => {
                    #[cfg(unix)]
                    let retry = self
                        .inner
                        .lock()
                        .ok()
                        .and_then(|state| {
                            state
                                .starting
                                .get(&key)
                                .filter(|entry| entry.id == id)
                                .and_then(|entry| entry.pending_process_group)
                        })
                        .map(|process_group| {
                            terminate_unix_process_group(
                                process_group,
                                deadline.saturating_duration_since(Instant::now()),
                            )
                        });
                    #[cfg(not(unix))]
                    let retry: Option<Result<(), String>> = None;

                    match retry {
                        Some(Ok(())) => {
                            if let Ok(mut state) = self.inner.lock() {
                                if state
                                    .starting
                                    .get(&key)
                                    .is_some_and(|entry| entry.id == id)
                                {
                                    state.starting.remove(&key);
                                }
                            }
                        }
                        Some(Err(retry_error)) => errors.push(format!(
                            "LSP start cleanup for {} ({}) failed: {error}; retry failed: {retry_error}",
                            key.language, id
                        )),
                        None => errors.push(format!(
                            "LSP start cleanup for {} ({}) failed: {error}",
                            key.language, id
                        )),
                    }
                }
                None => errors.push(format!(
                    "LSP start cleanup for {} ({}) did not finish within {} seconds.",
                    key.language,
                    id,
                    LSP_CLEANUP_BATCH_TIMEOUT.as_secs()
                )),
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    fn send_control(
        &self,
        plugin_id: &str,
        plugin_version: &str,
        workspace_root: &str,
        language: &str,
        owner_window: &str,
        message: ControlMessage,
    ) -> Result<(), String> {
        let workspace_root = canonical_workspace(workspace_root)?;
        let state = self
            .inner
            .lock()
            .map_err(|_| "Unable to lock LSP state.".to_string())?;
        let key = SessionKey {
            owner_window: owner_window.to_string(),
            workspace_root,
            language: language.to_string(),
        };
        if state.starting.contains_key(&key) {
            return Err(
                "LSP server is still starting for this workspace and language.".to_string(),
            );
        }
        let session = state.sessions.get(&key).ok_or_else(|| {
            "No LSP server is running for this workspace and language.".to_string()
        })?;
        if session.approved.key.plugin_id != plugin_id
            || session.approved.key.plugin_version != plugin_version
        {
            return Err("LSP session belongs to a different plugin.".to_string());
        }
        if !session.owners.contains(owner_window) {
            return Err("This window is not attached to the LSP session.".to_string());
        }
        match session.control.try_send(message) {
            Ok(()) => {
                session.wakeup.notify();
                Ok(())
            }
            Err(mpsc::TrySendError::Full(_)) => Err("LSP input queue is full.".to_string()),
            Err(mpsc::TrySendError::Disconnected(_)) => Err("LSP server has stopped.".to_string()),
        }
    }
}

/// LSP sessions and in-flight starts removed from the manager for one
/// window; stopping them is a separate step so it can run off the main
/// thread (SB-01).
#[cfg(test)]
pub struct WindowSessions {
    sessions: Vec<SessionHandle>,
    starting: Vec<StartingEntry>,
}

#[cfg(test)]
impl WindowSessions {
    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty() && self.starting.is_empty()
    }

    pub fn stop(self) -> Result<(), String> {
        cancel_starting(self.starting);
        stop_sessions(self.sessions)
    }
}

pub fn cleanup_window(state: &LspState, owner_window: &str) -> Result<(), String> {
    state.manager.cleanup_window(owner_window)
}

// SB-02: this is a plain helper now. The registered command lives in main.rs
// as the async `lsp_resolve_server` wrapper, which calls this on the blocking
// thread pool.
pub fn lsp_resolve_server(request: LspResolveRequest) -> Result<LspResolvedServer, String> {
    let workspace_root = canonical_workspace(&request.workspace_root)?;
    validate_server_declaration(&request.server)?;
    let executable_path = Path::new(&request.server.executable);
    let executable = fs::canonicalize(executable_path)
        .map_err(|error| format!("Unable to resolve approved LSP executable. {error}"))?;
    let metadata = fs::metadata(&executable)
        .map_err(|error| format!("Unable to inspect approved LSP executable. {error}"))?;
    if !metadata.is_file() {
        return Err("Approved LSP executable must be a regular file.".to_string());
    }
    validate_executable(&executable)?;
    Ok(LspResolvedServer {
        workspace_root: workspace_root.to_string_lossy().to_string(),
        server_id: request.server.server_id,
        language: request.server.language,
        executable_path: executable.to_string_lossy().to_string(),
        args: request.server.args,
    })
}

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

fn canonicalize_server(
    plugin_id: &str,
    plugin_version: &str,
    workspace_root: &str,
    server: &LspServerDeclaration,
) -> Result<ApprovedServer, String> {
    validate_token(plugin_id, "Plugin id", 128)?;
    validate_token(plugin_version, "Plugin version", 128)?;
    validate_server_declaration(server)?;

    let workspace_root = canonical_workspace(workspace_root)?;
    let executable_path = Path::new(&server.executable);
    if !executable_path.is_absolute() {
        return Err("LSP executable must be an absolute path.".to_string());
    }
    let executable = fs::canonicalize(executable_path)
        .map_err(|error| format!("Unable to resolve approved LSP executable. {error}"))?;
    let metadata = fs::metadata(&executable)
        .map_err(|error| format!("Unable to inspect approved LSP executable. {error}"))?;
    if !metadata.is_file() {
        return Err("Approved LSP executable must be a regular file.".to_string());
    }
    validate_executable(&executable)?;

    Ok(ApprovedServer {
        key: ApprovalKey {
            plugin_id: plugin_id.to_string(),
            plugin_version: plugin_version.to_string(),
            workspace_root,
            server_id: server.server_id.clone(),
            language: server.language.clone(),
        },
        executable,
        args: server.args.clone(),
    })
}

fn canonical_workspace(workspace_root: &str) -> Result<PathBuf, String> {
    if workspace_root.is_empty() {
        return Err("An open workspace is required to start an LSP server.".to_string());
    }
    let workspace = fs::canonicalize(workspace_root)
        .map_err(|error| format!("Unable to resolve LSP workspace. {error}"))?;
    if !workspace.is_dir() {
        return Err("LSP workspace must be a directory.".to_string());
    }
    Ok(workspace)
}

fn validate_token(value: &str, label: &str, max_bytes: usize) -> Result<(), String> {
    if value.is_empty()
        || value.len() > max_bytes
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
    {
        return Err(format!("{label} contains unsupported characters."));
    }
    Ok(())
}

fn validate_args(args: &[String]) -> Result<(), String> {
    if args.len() > MAX_LSP_ARGS {
        return Err("LSP server has too many command-line arguments.".to_string());
    }
    let mut total = 0usize;
    for argument in args {
        if argument.len() > MAX_LSP_ARG_BYTES || argument.contains('\0') {
            return Err("LSP server argument is too long or contains a null byte.".to_string());
        }
        total = total.saturating_add(argument.len());
    }
    if total > MAX_LSP_ARGS_BYTES {
        return Err("LSP server command-line arguments exceed the size limit.".to_string());
    }
    Ok(())
}

pub fn validate_server_declaration(server: &LspServerDeclaration) -> Result<(), String> {
    validate_token(&server.server_id, "LSP server id", 128)?;
    validate_token(&server.language, "LSP language", 64)?;
    validate_args(&server.args)?;
    if !Path::new(&server.executable).is_absolute() {
        return Err("LSP executable must be an absolute path.".to_string());
    }
    Ok(())
}

pub fn validate_server_declarations(servers: &[LspServerDeclaration]) -> Result<(), String> {
    if servers.len() > MAX_LSP_SERVERS {
        return Err("Plugin declares too many LSP servers.".to_string());
    }
    let mut server_ids = HashSet::new();
    for server in servers {
        validate_server_declaration(server)?;
        if !server_ids.insert(&server.server_id) {
            return Err(format!("Duplicate LSP server id: {}", server.server_id));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn validate_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    if fs::metadata(path)
        .map_err(|error| format!("Unable to inspect approved LSP executable. {error}"))?
        .permissions()
        .mode()
        & 0o111
        == 0
    {
        return Err("Approved LSP file is not executable.".to_string());
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod windows_bootstrap_tests {
    use super::windows_bootstrap::StartupGate;
    use super::windows_job::JobObject;
    use std::ffi::c_void;
    use std::process::{Child, Command};
    use std::thread;
    use std::time::{Duration, Instant};

    type Handle = *mut c_void;
    const PROCESS_SYNCHRONIZE: u32 = 0x0010_0000;
    const WAIT_OBJECT_0: u32 = 0;

    #[link(name = "Kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> Handle;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn CloseHandle(handle: Handle) -> i32;
        fn GetLastError() -> u32;
    }

    #[test]
    fn gated_bootstrap_starts_no_server_before_job_assignment_and_kills_its_tree() {
        let directory = std::env::temp_dir().join(format!(
            "pude-lsp-windows-job-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let source = directory.join("lsp_server_fixture.rs");
        let executable = directory.join("lsp_server_fixture.exe");
        let ready_path = directory.join("bootstrap-ready");
        let pid_path = directory.join("server-pid");
        std::fs::write(
            &source,
            include_str!("../tests/fixtures/lsp_server_fixture.rs"),
        )
        .unwrap();
        let output = Command::new("rustc")
            .arg("--edition=2021")
            .arg(&source)
            .arg("-o")
            .arg(&executable)
            .output()
            .expect("rustc should be available to build the Windows bootstrap fixture");
        assert!(
            output.status.success(),
            "fixture compilation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let event_name = format!("Local\\pude-lsp-test-{}", uuid::Uuid::new_v4().simple());
        let gate = StartupGate::new(&event_name).unwrap();
        let mut child = Command::new(&executable)
            .arg("--pude-lsp-test-bootstrap")
            .arg(&event_name)
            .arg(&ready_path)
            .arg(&pid_path)
            .spawn()
            .unwrap();
        let mut job = JobObject::new().unwrap();
        wait_for_file(&ready_path, &mut child);
        assert!(!pid_path.exists(), "server code ran before Job assignment");
        job.assign(&child).unwrap();
        gate.release().unwrap();
        wait_for_file(&pid_path, &mut child);
        let descendant_pid = std::fs::read_to_string(&pid_path)
            .unwrap()
            .parse::<u32>()
            .unwrap();

        job.terminate();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut bootstrap_exited = false;
        while Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() {
                bootstrap_exited = true;
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(bootstrap_exited, "bootstrap survived Job termination");
        let _ = child.wait();
        assert_process_exited(descendant_pid);
        std::fs::remove_dir_all(directory).unwrap();
    }

    fn wait_for_file(path: &std::path::Path, child: &mut Child) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if path.exists() {
                return;
            }
            if let Some(status) = child.try_wait().unwrap() {
                panic!("bootstrap exited before producing {path:?}: {status}");
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("timed out waiting for {path:?}");
    }

    fn assert_process_exited(process_id: u32) {
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, process_id) };
        if handle.is_null() {
            let error = unsafe { GetLastError() };
            assert_eq!(error, 87, "OpenProcess failed with Windows error {error}");
            return;
        }
        let wait = unsafe { WaitForSingleObject(handle, 5_000) };
        unsafe {
            let _ = CloseHandle(handle);
        }
        assert_eq!(
            wait, WAIT_OBJECT_0,
            "LSP descendant survived Job termination"
        );
    }
}

#[cfg(windows)]
fn validate_executable(path: &Path) -> Result<(), String> {
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("exe"))
        .unwrap_or(false)
    {
        return Err("Approved LSP executable must be a .exe file.".to_string());
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn validate_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn spawn_child(
    approved: &ApprovedServer,
    #[allow(unused_variables)] launcher: Option<&Path>,
    #[allow(unused_variables)] cancel: &StartCancel,
) -> Result<ChildRuntime, String> {
    spawn_child_with_wakeup(
        approved,
        launcher,
        cancel,
        Arc::new(SupervisorWakeup::default()),
    )
}

fn spawn_child_with_wakeup(
    approved: &ApprovedServer,
    #[allow(unused_variables)] launcher: Option<&Path>,
    #[allow(unused_variables)] cancel: &StartCancel,
    wakeup: Arc<SupervisorWakeup>,
) -> Result<ChildRuntime, String> {
    #[cfg(windows)]
    let (mut child, job) = windows_bootstrap::spawn(approved, launcher, cancel)?;
    #[cfg(not(windows))]
    let mut child = {
        let _ = (launcher, cancel);
        let mut command = Command::new(&approved.executable);
        command
            .args(&approved.args)
            .current_dir(&approved.key.workspace_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_process_group(&mut command);
        command
            .spawn()
            .map_err(|error| format!("Unable to start approved LSP server. {error}"))?
    };
    let Some(stdin) = child.stdin.take() else {
        #[cfg(windows)]
        terminate_failed_child(&mut child, &job);
        #[cfg(not(windows))]
        terminate_failed_child(&mut child);
        return Err("Unable to open LSP server stdin.".to_string());
    };
    let Some(stdout) = child.stdout.take() else {
        #[cfg(windows)]
        terminate_failed_child(&mut child, &job);
        #[cfg(not(windows))]
        terminate_failed_child(&mut child);
        return Err("Unable to open LSP server stdout.".to_string());
    };
    let Some(stderr) = child.stderr.take() else {
        #[cfg(windows)]
        terminate_failed_child(&mut child, &job);
        #[cfg(not(windows))]
        terminate_failed_child(&mut child);
        return Err("Unable to open LSP server stderr.".to_string());
    };
    let (sender, receiver) = mpsc::sync_channel(IO_CHANNEL_CAPACITY);
    let stdout_sender = sender.clone();
    let stdout_wakeup = Arc::clone(&wakeup);
    let io_thread = match thread::Builder::new()
        .name("pude-lsp-stdout".to_string())
        .spawn(move || read_stdout(stdout, stdout_sender, stdout_wakeup))
    {
        Ok(thread) => thread,
        Err(error) => {
            #[cfg(windows)]
            terminate_failed_child(&mut child, &job);
            #[cfg(not(windows))]
            terminate_failed_child(&mut child);
            return Err(format!("Unable to read LSP server stdout. {error}"));
        }
    };
    let stderr_sender = sender;
    let stderr_wakeup = Arc::clone(&wakeup);
    let stderr_thread = match thread::Builder::new()
        .name("pude-lsp-stderr".to_string())
        .spawn(move || read_stderr(stderr, stderr_sender, stderr_wakeup))
    {
        Ok(thread) => thread,
        Err(error) => {
            #[cfg(windows)]
            terminate_failed_child(&mut child, &job);
            #[cfg(not(windows))]
            terminate_failed_child(&mut child);
            let _ = io_thread.join();
            return Err(format!("Unable to read LSP server stderr. {error}"));
        }
    };
    Ok(ChildRuntime {
        child,
        stdin,
        io: receiver,
        wakeup,
        io_thread,
        stderr_thread,
        #[cfg(windows)]
        job,
    })
}

#[cfg(windows)]
fn terminate_failed_child(child: &mut Child, job: &windows_job::JobObject) {
    job.terminate();
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(windows))]
fn terminate_failed_child(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(windows)]
mod windows_bootstrap {
    use super::{windows_job::JobObject, ApprovedServer, StartCancel, LSP_STARTUP_DEADLINE};
    use std::ffi::{c_void, OsStr};
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use std::process::{Child, Command, Stdio};
    use std::time::Instant;
    use uuid::Uuid;

    const PIPE_ACCESS_OUTBOUND: u32 = 0x0000_0002;
    const PIPE_REJECT_REMOTE_CLIENTS: u32 = 0x0000_0008;
    const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
    const ERROR_IO_PENDING: u32 = 997;
    const ERROR_PIPE_CONNECTED: u32 = 535;
    const WAIT_OBJECT_0: u32 = 0;
    const WAIT_TIMEOUT: u32 = 0x0000_0102;
    const WAIT_FAILED: u32 = 0xFFFF_FFFF;
    const INVALID_HANDLE_VALUE: isize = -1;

    type Handle = *mut c_void;

    #[repr(C)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        event: Handle,
    }

    #[link(name = "Kernel32")]
    extern "system" {
        fn CreateEventW(
            attributes: *mut c_void,
            manual_reset: i32,
            initial_state: i32,
            name: *const u16,
        ) -> Handle;
        fn SetEvent(event: Handle) -> i32;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn WaitForMultipleObjects(
            count: u32,
            handles: *const Handle,
            wait_all: i32,
            milliseconds: u32,
        ) -> u32;
        fn CreateNamedPipeW(
            name: *const u16,
            open_mode: u32,
            pipe_mode: u32,
            max_instances: u32,
            out_buffer_size: u32,
            in_buffer_size: u32,
            default_timeout: u32,
            security_attributes: *mut c_void,
        ) -> Handle;
        fn ConnectNamedPipe(pipe: Handle, overlapped: *mut Overlapped) -> i32;
        fn GetNamedPipeClientProcessId(pipe: Handle, client_process_id: *mut u32) -> i32;
        fn GetLastError() -> u32;
        fn WriteFile(
            file: Handle,
            buffer: *const u8,
            bytes_to_write: u32,
            bytes_written: *mut u32,
            overlapped: *mut Overlapped,
        ) -> i32;
        fn GetOverlappedResult(
            file: Handle,
            overlapped: *mut Overlapped,
            bytes_transferred: *mut u32,
            wait: i32,
        ) -> i32;
        fn CancelIoEx(file: Handle, overlapped: *mut Overlapped) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    /// Builds a recognizable bootstrap error tagged with the failing stage
    /// and OS error text. It intentionally never includes the LSP payload.
    fn stage_error(stage: &str, error: &str) -> String {
        format!("LSP bootstrap {stage} failed. {error}")
    }

    fn os_error_text(code: u32) -> String {
        io::Error::from_raw_os_error(code as i32).to_string()
    }

    /// Manual-reset event used to wake an in-flight overlapped pipe wait as
    /// soon as the owning start reservation is canceled.
    pub struct CancelEvent(Handle);

    unsafe impl Send for CancelEvent {}
    unsafe impl Sync for CancelEvent {}

    impl CancelEvent {
        pub fn new() -> Result<Self, String> {
            let handle = unsafe { CreateEventW(std::ptr::null_mut(), 1, 0, std::ptr::null()) };
            if handle.is_null() {
                return Err(format!(
                    "Unable to create LSP start cancel event. {}",
                    io::Error::last_os_error()
                ));
            }
            Ok(Self(handle))
        }

        pub fn set(&self) {
            unsafe {
                let _ = SetEvent(self.0);
            }
        }

        pub fn raw(&self) -> Handle {
            self.0
        }
    }

    impl Drop for CancelEvent {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    pub(super) struct StartupGate(Handle);

    impl StartupGate {
        pub(super) fn new(name: &str) -> Result<Self, String> {
            let name = wide(name);
            let handle = unsafe { CreateEventW(std::ptr::null_mut(), 1, 0, name.as_ptr()) };
            if handle.is_null() {
                return Err(format!(
                    "Unable to create LSP bootstrap gate. {}",
                    io::Error::last_os_error()
                ));
            }
            Ok(Self(handle))
        }

        pub(super) fn release(&self) -> Result<(), String> {
            if unsafe { SetEvent(self.0) } == 0 {
                return Err(format!(
                    "Unable to release LSP bootstrap gate. {}",
                    io::Error::last_os_error()
                ));
            }
            Ok(())
        }
    }

    impl Drop for StartupGate {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    /// Outbound payload pipe. Both the client connect and the payload write
    /// run as overlapped I/O and wait simultaneously on the
    /// operation event, the bootstrap child process handle, and the start
    /// cancellation event, all bounded by the startup deadline. Timeouts and
    /// early child exits cancel the pending I/O before the handles close.
    struct PayloadPipe {
        handle: Handle,
        /// Auto-reset event reused as `OVERLAPPED.hEvent` for every operation.
        event: Handle,
    }

    impl PayloadPipe {
        fn new(name: &str) -> Result<Self, String> {
            let name = wide(name);
            let handle = unsafe {
                CreateNamedPipeW(
                    name.as_ptr(),
                    PIPE_ACCESS_OUTBOUND | FILE_FLAG_OVERLAPPED,
                    PIPE_REJECT_REMOTE_CLIENTS,
                    1,
                    16 * 1024,
                    0,
                    0,
                    std::ptr::null_mut(),
                )
            };
            if handle as isize == INVALID_HANDLE_VALUE {
                return Err(stage_error(
                    "pipe creation",
                    &io::Error::last_os_error().to_string(),
                ));
            }
            let event = unsafe { CreateEventW(std::ptr::null_mut(), 0, 0, std::ptr::null()) };
            if event.is_null() {
                let error = io::Error::last_os_error().to_string();
                unsafe {
                    let _ = CloseHandle(handle);
                }
                return Err(stage_error("pipe event creation", &error));
            }
            Ok(Self { handle, event })
        }

        fn connect(
            &self,
            child: &mut Child,
            cancel: &StartCancel,
            deadline: Instant,
        ) -> Result<(), String> {
            let mut overlapped = unsafe { std::mem::zeroed::<Overlapped>() };
            overlapped.event = self.event;
            let connected = unsafe { ConnectNamedPipe(self.handle, &mut overlapped) };
            if connected == 0 {
                let error = unsafe { GetLastError() };
                if error == ERROR_PIPE_CONNECTED {
                    return self.verify_client(child);
                }
                if error != ERROR_IO_PENDING {
                    return Err(stage_error("connect", &os_error_text(error)));
                }
                self.wait_overlapped(&mut overlapped, child, cancel, deadline, "connect")?;
            }
            self.verify_client(child)
        }

        fn verify_client(&self, child: &Child) -> Result<(), String> {
            let mut client_process_id = 0;
            if unsafe { GetNamedPipeClientProcessId(self.handle, &mut client_process_id) } == 0
                || client_process_id != child.id()
            {
                return Err(
                    "LSP bootstrap connect failed. The pipe was opened by an unexpected process."
                        .to_string(),
                );
            }
            Ok(())
        }

        fn write_payload(
            &self,
            payload: &[u8],
            child: &mut Child,
            cancel: &StartCancel,
            deadline: Instant,
        ) -> Result<(), String> {
            let mut written = 0usize;
            while written < payload.len() {
                let mut overlapped = unsafe { std::mem::zeroed::<Overlapped>() };
                overlapped.event = self.event;
                let mut transferred = 0u32;
                let chunk = &payload[written..];
                let completed = unsafe {
                    WriteFile(
                        self.handle,
                        chunk.as_ptr(),
                        chunk.len() as u32,
                        &mut transferred,
                        &mut overlapped,
                    )
                };
                if completed != 0 {
                    written += transferred as usize;
                    continue;
                }
                let error = unsafe { GetLastError() };
                if error != ERROR_IO_PENDING {
                    return Err(stage_error("payload write", &os_error_text(error)));
                }
                self.wait_overlapped(&mut overlapped, child, cancel, deadline, "payload write")?;
                written += transferred as usize;
            }
            Ok(())
        }

        fn wait_overlapped(
            &self,
            overlapped: &mut Overlapped,
            child: &mut Child,
            cancel: &StartCancel,
            deadline: Instant,
            stage: &str,
        ) -> Result<(), String> {
            let handles = [
                self.event,
                child.as_raw_handle() as Handle,
                cancel.event_handle(),
            ];
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                let wait = unsafe {
                    WaitForMultipleObjects(
                        handles.len() as u32,
                        handles.as_ptr(),
                        0,
                        remaining.as_millis().min(u32::MAX as u128) as u32,
                    )
                };
                match wait {
                    WAIT_OBJECT_0 => {
                        let mut transferred = 0u32;
                        let ok = unsafe {
                            GetOverlappedResult(self.handle, overlapped, &mut transferred, 0)
                        };
                        if ok == 0 {
                            let error = unsafe { GetLastError() };
                            return Err(stage_error(stage, &os_error_text(error)));
                        }
                        return Ok(());
                    }
                    signaled if signaled == WAIT_OBJECT_0 + 1 => {
                        // The bootstrap child exited before finishing the
                        // handshake; keep its exit status in the diagnostic.
                        let status = child.try_wait().ok().flatten();
                        self.abort_overlapped(overlapped);
                        return Err(format!(
                            "LSP bootstrap {stage} aborted because the bootstrap process exited early ({status:?})."
                        ));
                    }
                    signaled if signaled == WAIT_OBJECT_0 + 2 => {
                        self.abort_overlapped(overlapped);
                        return Err(format!("LSP bootstrap {stage} was canceled."));
                    }
                    WAIT_TIMEOUT => {
                        if Instant::now() >= deadline {
                            self.abort_overlapped(overlapped);
                            return Err(format!(
                                "LSP bootstrap {stage} exceeded the {} second startup deadline.",
                                LSP_STARTUP_DEADLINE.as_secs()
                            ));
                        }
                        continue;
                    }
                    WAIT_FAILED => {
                        return Err(stage_error(stage, &io::Error::last_os_error().to_string()));
                    }
                    unexpected => {
                        return Err(format!(
                            "LSP bootstrap {stage} wait failed with an unexpected result ({unexpected})."
                        ));
                    }
                }
            }
        }

        /// Cancels a pending overlapped operation and waits for the
        /// cancellation to land before the OVERLAPPED storage can leave
        /// scope, so the system never completes into freed stack memory.
        fn abort_overlapped(&self, overlapped: &mut Overlapped) {
            unsafe {
                let _ = CancelIoEx(self.handle, overlapped);
                let _ = WaitForSingleObject(self.event, 5_000);
                let mut transferred = 0u32;
                let _ = GetOverlappedResult(self.handle, overlapped, &mut transferred, 0);
            }
        }
    }

    impl Drop for PayloadPipe {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.event);
                let _ = CloseHandle(self.handle);
            }
        }
    }

    /// Launches the bootstrap child for an approved server. The launcher
    /// defaults to the app executable (which embeds the bootstrap branch in
    /// `main`); tests inject a helper binary that speaks the same protocol
    /// because the test harness binary would reject the bootstrap arguments.
    pub fn spawn(
        approved: &ApprovedServer,
        launcher: Option<&Path>,
        cancel: &StartCancel,
    ) -> Result<(Child, JobObject), String> {
        spawn_with_job(approved, launcher, cancel, JobObject::new()?)
    }

    /// Test seam for exercising the job-assignment failure path with an
    /// intentionally broken job object.
    #[cfg(test)]
    pub fn spawn_for_test(
        approved: &ApprovedServer,
        launcher: Option<&Path>,
        cancel: &StartCancel,
        job: JobObject,
    ) -> Result<(Child, JobObject), String> {
        spawn_with_job(approved, launcher, cancel, job)
    }

    fn spawn_with_job(
        approved: &ApprovedServer,
        launcher: Option<&Path>,
        cancel: &StartCancel,
        mut job: JobObject,
    ) -> Result<(Child, JobObject), String> {
        let deadline = Instant::now() + LSP_STARTUP_DEADLINE;
        let id = Uuid::new_v4().simple().to_string();
        let event_name = format!("Local\\pude-lsp-gate-{id}");
        let pipe_name = format!(r"\\.\pipe\pude-lsp-{id}");
        let gate = StartupGate::new(&event_name)?;
        let pipe = PayloadPipe::new(&pipe_name)?;
        let executable = match launcher {
            Some(path) => path.to_path_buf(),
            None => std::env::current_exe().map_err(|error| {
                format!("Unable to locate the LSP bootstrap executable. {error}")
            })?,
        };
        let mut command = Command::new(executable);
        command
            .arg(crate::lsp_bootstrap_protocol::LSP_BOOTSTRAP_ARGUMENT)
            .arg(&event_name)
            .arg(&pipe_name)
            .current_dir(&approved.key.workspace_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| format!("Unable to start LSP bootstrap process. {error}"))?;

        // Assign the child to its cleanup job before releasing the gate so
        // the approved server can never escape job-tree termination.
        if let Err(error) = job.assign(&child) {
            job.terminate();
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }

        let payload = crate::lsp_bootstrap_protocol::BootstrapPayload {
            executable: approved.executable.to_string_lossy().into_owned(),
            args: approved.args.clone(),
        };
        let encoded = crate::lsp_bootstrap_protocol::encode_payload(&payload)?;
        let delivered = gate
            .release()
            .and_then(|()| pipe.connect(&mut child, cancel, deadline))
            .and_then(|()| pipe.write_payload(&encoded, &mut child, cancel, deadline));
        if let Err(error) = delivered {
            job.terminate();
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        Ok((child, job))
    }

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }
}

#[cfg(windows)]
pub fn run_bootstrap_if_requested() -> bool {
    crate::lsp_bootstrap_protocol::run_if_requested()
}

#[cfg(not(any(unix, windows)))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(windows)]
mod windows_job {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::ptr::{null, null_mut};

    type Handle = *mut c_void;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: u32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimitInformation {
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

    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimitInformation {
        basic_limit_information: BasicLimitInformation,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "Kernel32")]
    extern "system" {
        fn CreateJobObjectW(job_attributes: *mut c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            information_class: u32,
            information: *mut c_void,
            information_length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    pub struct JobObject(Handle);

    unsafe impl Send for JobObject {}

    impl JobObject {
        pub fn new() -> Result<Self, String> {
            let handle = unsafe { CreateJobObjectW(null_mut(), null()) };
            if handle.is_null() {
                return Err(format!(
                    "Unable to create LSP cleanup job. {}",
                    std::io::Error::last_os_error()
                ));
            }

            let mut limits = ExtendedLimitInformation::default();
            limits.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    handle,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                    &mut limits as *mut ExtendedLimitInformation as *mut c_void,
                    size_of::<ExtendedLimitInformation>() as u32,
                )
            };
            if configured == 0 {
                let error = std::io::Error::last_os_error();
                unsafe {
                    CloseHandle(handle);
                }
                return Err(format!("Unable to configure LSP cleanup job. {error}"));
            }
            Ok(Self(handle))
        }

        pub fn assign(&mut self, child: &Child) -> Result<(), String> {
            let assigned =
                unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as Handle) };
            if assigned == 0 {
                return Err(format!(
                    "Unable to attach LSP server to its cleanup job. {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(())
        }

        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }

        /// Closes the underlying handle without destroying the object so
        /// tests can exercise the assignment-failure recovery path.
        #[cfg(test)]
        pub fn close_for_test(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
            self.0 = null_mut();
        }
    }

    impl Drop for JobObject {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

fn send_process_io(
    sender: &SyncSender<ProcessIoMessage>,
    wakeup: &SupervisorWakeup,
    message: ProcessIoMessage,
) -> bool {
    if sender.send(message).is_err() {
        return false;
    }
    wakeup.notify();
    true
}

fn read_stdout(
    stdout: impl Read,
    sender: SyncSender<ProcessIoMessage>,
    wakeup: Arc<SupervisorWakeup>,
) {
    let mut reader = BufReader::new(stdout);
    loop {
        match read_lsp_message(&mut reader) {
            Ok(Some(message)) => {
                if !send_process_io(&sender, &wakeup, ProcessIoMessage::Message(message)) {
                    return;
                }
            }
            Ok(None) => {
                let _ = send_process_io(&sender, &wakeup, ProcessIoMessage::Closed);
                return;
            }
            Err(error) => {
                let _ = send_process_io(&sender, &wakeup, ProcessIoMessage::Failed(error));
                return;
            }
        }
    }
}

fn read_stderr(
    stderr: impl Read,
    sender: SyncSender<ProcessIoMessage>,
    wakeup: Arc<SupervisorWakeup>,
) {
    let mut stderr = stderr;
    let mut buffer = vec![0u8; STDERR_CHUNK_BYTES];
    loop {
        match stderr.read(&mut buffer) {
            Ok(0) => return,
            Ok(length) => {
                if !send_process_io(
                    &sender,
                    &wakeup,
                    ProcessIoMessage::Stderr(buffer[..length].to_vec()),
                ) {
                    return;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => {
                let _ = send_process_io(
                    &sender,
                    &wakeup,
                    ProcessIoMessage::Failed(format!("Unable to read LSP server stderr. {error}")),
                );
                return;
            }
        }
    }
}

fn cancel_starting(entries: Vec<StartingEntry>) {
    for entry in entries {
        entry.cancel.cancel();
    }
}

fn remove_starting_reservation(inner: &Arc<Mutex<ManagerState>>, key: &SessionKey, id: u64) {
    if let Ok(mut state) = inner.lock() {
        if state.starting.get(key).is_some_and(|entry| entry.id == id) {
            state.starting.remove(key);
        }
    }
}

/// Registers a successfully started runtime as a session. The manager lock
/// is re-acquired here and the reservation must still be present with the
/// same generation; otherwise the start was revoked, stopped, or superseded
/// while the worker was spawning the process, and the runtime is torn down
/// without ever surfacing as a session.
fn complete_start(
    inner: Weak<Mutex<ManagerState>>,
    session_key: SessionKey,
    id: u64,
    approved: ApprovedServer,
    runtime: ChildRuntime,
    event_sink: LspEventSink,
    launcher: Option<PathBuf>,
    completion: Arc<StartCompletion>,
) {
    let (control, receiver) = mpsc::sync_channel(CONTROL_CHANNEL_CAPACITY);
    let wakeup = Arc::clone(&runtime.wakeup);
    let process_group = Arc::new(AtomicI32::new(runtime.child.id() as i32));
    let stop_requested = Arc::new(AtomicBool::new(false));
    let inner = match inner.upgrade() {
        Some(inner) => inner,
        None => {
            completion.complete(cleanup_runtime(runtime));
            return;
        }
    };
    let registered = {
        let mut state = match inner.lock() {
            Ok(state) => state,
            Err(_) => {
                completion.complete(cleanup_runtime(runtime));
                return;
            }
        };
        match state.starting.remove(&session_key) {
            Some(entry) if entry.id == id && !entry.cancel.is_canceled() => {
                state.sessions.insert(
                    session_key.clone(),
                    SessionHandle {
                        id,
                        approved: approved.clone(),
                        owners: entry.owners,
                        control,
                        wakeup,
                        stop_lock: Arc::new(Mutex::new(())),
                        stopping: Arc::new(AtomicBool::new(false)),
                        stop_requested: Arc::clone(&stop_requested),
                        cleanup_worker_active: Arc::new(AtomicBool::new(false)),
                        process_group: Arc::clone(&process_group),
                    },
                );
                (true, false)
            }
            Some(mut entry) if entry.id == id => {
                #[cfg(unix)]
                {
                    entry.pending_process_group = Some(process_group.load(Ordering::Acquire));
                }
                state.starting.insert(session_key.clone(), entry);
                (false, true)
            }
            // A different generation took the slot while we were spawning;
            // hand it back untouched and drop our runtime.
            other => {
                if let Some(entry) = other {
                    state.starting.insert(session_key.clone(), entry);
                }
                (false, false)
            }
        }
    };
    let (registered, canceled_reservation) = registered;
    if !registered {
        let cleanup = cleanup_runtime(runtime);
        if cleanup.is_ok() && canceled_reservation {
            remove_starting_reservation(&inner, &session_key, id);
        }
        completion.complete(cleanup.clone());
        emit_state(
            &event_sink,
            &approved,
            "stopped",
            0,
            Some(match &cleanup {
                Ok(()) => "LSP start was canceled before the server came up.".to_string(),
                Err(error) => {
                    format!("LSP start was canceled, but process cleanup did not finish: {error}")
                }
            }),
        );
        return;
    }
    completion.complete(Ok(()));
    let weak_inner = Arc::downgrade(&inner);
    supervise(
        approved,
        id,
        runtime,
        receiver,
        event_sink,
        weak_inner,
        session_key,
        launcher,
        process_group,
        stop_requested,
    );
}

/// Handles a failed spawn: removes the reservation when it is still ours so
/// the next `start` can retry, and reports a terminal state. A canceled start
/// is reported as `stopped`, never `startFailed`, and never revives the
/// session. Diagnostics carry the failing stage and OS error; no LSP payload
/// is logged.
fn fail_start(
    inner: Weak<Mutex<ManagerState>>,
    session_key: SessionKey,
    id: u64,
    approved: ApprovedServer,
    error: String,
    event_sink: LspEventSink,
    cancel: StartCancel,
) {
    let mut owned_reservation = false;
    if let Some(inner) = inner.upgrade() {
        if let Ok(mut state) = inner.lock() {
            match state.starting.remove(&session_key) {
                Some(entry) if entry.id == id => owned_reservation = true,
                other => {
                    if let Some(entry) = other {
                        state.starting.insert(session_key.clone(), entry);
                    }
                }
            }
        }
    }
    if cancel.is_canceled() || !owned_reservation {
        emit_state(
            &event_sink,
            &approved,
            "stopped",
            0,
            Some("LSP start was canceled before the server came up.".to_string()),
        );
    } else {
        emit_state(&event_sink, &approved, "startFailed", 0, Some(error));
    }
}

fn supervise(
    approved: ApprovedServer,
    session_id: u64,
    mut runtime: ChildRuntime,
    control: Receiver<ControlMessage>,
    event_sink: LspEventSink,
    inner: Weak<Mutex<ManagerState>>,
    session_key: SessionKey,
    launcher: Option<PathBuf>,
    process_group: Arc<AtomicI32>,
    stop_requested: Arc<AtomicBool>,
) {
    let mut restarts = VecDeque::<Instant>::new();
    let mut restart_count = 0usize;
    let mut stop_ack = None;
    let mut should_emit_stopped = false;
    emit_state(&event_sink, &approved, "started", restart_count, None);
    'supervise: loop {
        match run_child(&approved, &mut runtime, &control, &event_sink) {
            SupervisorExit::Stopped(ack) => {
                stop_ack = ack;
                should_emit_stopped = true;
                break;
            }
            SupervisorExit::Unexpected => {
                if stop_requested.load(Ordering::Acquire) {
                    should_emit_stopped = true;
                    break;
                }
                let now = Instant::now();
                while restarts
                    .front()
                    .map(|time| now.duration_since(*time) > RESTART_WINDOW)
                    .unwrap_or(false)
                {
                    restarts.pop_front();
                }
                if restarts.len() >= MAX_RESTARTS_PER_WINDOW {
                    emit_state(
                        &event_sink,
                        &approved,
                        "stopped",
                        restart_count,
                        Some("LSP server exceeded its restart limit.".to_string()),
                    );
                    break;
                }
                restarts.push_back(now);
                restart_count += 1;
                emit_state(&event_sink, &approved, "restarting", restart_count, None);
                let delay = Duration::from_millis(100 * (1u64 << (restart_count - 1).min(4)));
                match control.recv_timeout(delay) {
                    Ok(ControlMessage::Stop(ack)) => {
                        stop_ack = Some(ack);
                        should_emit_stopped = true;
                        break 'supervise;
                    }
                    Ok(ControlMessage::Send(_)) | Ok(ControlMessage::Cancel(_)) => {
                        // The previous process is gone. Requests during backoff are not replayed.
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => {
                        should_emit_stopped = true;
                        break 'supervise;
                    }
                }
                let restart_cancel = match StartCancel::new() {
                    Ok(cancel) => cancel,
                    Err(error) => {
                        emit_state(
                            &event_sink,
                            &approved,
                            "restartFailed",
                            restart_count,
                            Some(error),
                        );
                        continue;
                    }
                };
                match spawn_child_with_wakeup(
                    &approved,
                    launcher.as_deref(),
                    &restart_cancel,
                    Arc::clone(&runtime.wakeup),
                ) {
                    Ok(next) => {
                        process_group.store(next.child.id() as i32, Ordering::Release);
                        runtime = next;
                        emit_state(&event_sink, &approved, "started", restart_count, None);
                    }
                    Err(error) => {
                        emit_state(
                            &event_sink,
                            &approved,
                            "restartFailed",
                            restart_count,
                            Some(error),
                        );
                    }
                }
            }
        }
    }
    let cleanup = cleanup_runtime(runtime);
    match &cleanup {
        Ok(()) => {
            remove_finished_session(&inner, &session_key, session_id);
            if should_emit_stopped {
                emit_state(&event_sink, &approved, "stopped", restart_count, None);
            }
        }
        Err(error) => emit_state(
            &event_sink,
            &approved,
            "error",
            restart_count,
            Some(format!("LSP process cleanup did not finish: {error}")),
        ),
    }
    if let Some(ack) = stop_ack {
        let _ = ack.send(cleanup);
    }
}

fn run_child(
    approved: &ApprovedServer,
    runtime: &mut ChildRuntime,
    control: &Receiver<ControlMessage>,
    event_sink: &LspEventSink,
) -> SupervisorExit {
    let mut child_exited_at = None;
    loop {
        let observed_generation = runtime.wakeup.generation();
        let batch_started = Instant::now();
        let mut processed = 0usize;
        while processed < MAX_SUPERVISOR_BATCH_EVENTS
            && batch_started.elapsed() < MAX_SUPERVISOR_BATCH_TIME
        {
            let mut handled_event = false;
            match control.try_recv() {
                Ok(message) => {
                    handled_event = true;
                    processed += 1;
                    if let Some(exit) =
                        handle_control_message(approved, runtime, event_sink, message)
                    {
                        return exit;
                    }
                }
                Err(TryRecvError::Disconnected) => {
                    terminate_child(runtime);
                    return SupervisorExit::Stopped(None);
                }
                Err(TryRecvError::Empty) => {}
            }
            if processed >= MAX_SUPERVISOR_BATCH_EVENTS
                || batch_started.elapsed() >= MAX_SUPERVISOR_BATCH_TIME
            {
                break;
            }
            match runtime.io.try_recv() {
                Ok(message) => {
                    handled_event = true;
                    processed += 1;
                    if let Some(exit) =
                        handle_process_io_message(approved, runtime, event_sink, message)
                    {
                        return exit;
                    }
                }
                Err(TryRecvError::Disconnected) => {
                    terminate_child(runtime);
                    return SupervisorExit::Unexpected;
                }
                Err(TryRecvError::Empty) => {}
            }
            if !handled_event {
                break;
            }
        }

        match runtime.child.try_wait() {
            Ok(Some(_status)) => {
                let exit_time = child_exited_at.get_or_insert_with(Instant::now);
                if exit_time.elapsed() >= Duration::from_millis(250) {
                    terminate_child(runtime);
                    return SupervisorExit::Unexpected;
                }
            }
            Ok(None) => child_exited_at = None,
            Err(error) => {
                terminate_child(runtime);
                emit_state(
                    event_sink,
                    approved,
                    "error",
                    0,
                    Some(format!("Unable to inspect LSP process status. {error}")),
                );
                return SupervisorExit::Unexpected;
            }
        }

        if processed == 0 {
            match child_exited_at {
                Some(exit_time) => {
                    let remaining = Duration::from_millis(250).saturating_sub(exit_time.elapsed());
                    if !runtime
                        .wakeup
                        .wait_if_unchanged_for(observed_generation, remaining)
                    {
                        terminate_child(runtime);
                        return SupervisorExit::Unexpected;
                    }
                }
                None => runtime.wakeup.wait_if_unchanged(observed_generation),
            }
        }
    }
}

fn handle_control_message(
    approved: &ApprovedServer,
    runtime: &mut ChildRuntime,
    event_sink: &LspEventSink,
    message: ControlMessage,
) -> Option<SupervisorExit> {
    let message = match message {
        ControlMessage::Send(message) => message,
        ControlMessage::Cancel(request_id) => serde_json::json!({
            "jsonrpc": "2.0",
            "method": "$/cancelRequest",
            "params": { "id": request_id }
        }),
        ControlMessage::Stop(ack) => return Some(SupervisorExit::Stopped(Some(ack))),
    };
    if let Err(error) = write_lsp_message(&mut runtime.stdin, &message) {
        terminate_child(runtime);
        emit_state(event_sink, approved, "error", 0, Some(error));
        return Some(SupervisorExit::Unexpected);
    }
    None
}

fn handle_process_io_message(
    approved: &ApprovedServer,
    runtime: &mut ChildRuntime,
    event_sink: &LspEventSink,
    message: ProcessIoMessage,
) -> Option<SupervisorExit> {
    match message {
        ProcessIoMessage::Message(message) => emit_message(event_sink, approved, message),
        ProcessIoMessage::Stderr(bytes) => emit_stderr(event_sink, approved, &bytes),
        ProcessIoMessage::Closed => {
            terminate_child(runtime);
            return Some(SupervisorExit::Unexpected);
        }
        ProcessIoMessage::Failed(error) => {
            terminate_child(runtime);
            emit_state(event_sink, approved, "error", 0, Some(error));
            return Some(SupervisorExit::Unexpected);
        }
    }
    None
}

fn emit_state(
    sink: &LspEventSink,
    approved: &ApprovedServer,
    state: &str,
    restart_count: usize,
    message: Option<String>,
) {
    sink(LspEvent::State {
        plugin_id: approved.key.plugin_id.clone(),
        plugin_version: approved.key.plugin_version.clone(),
        workspace_root: approved.key.workspace_root.to_string_lossy().to_string(),
        language: approved.key.language.clone(),
        server_id: approved.key.server_id.clone(),
        state: state.to_string(),
        restart_count,
        message,
    });
}

fn emit_message(sink: &LspEventSink, approved: &ApprovedServer, message: Value) {
    sink(LspEvent::Message {
        plugin_id: approved.key.plugin_id.clone(),
        plugin_version: approved.key.plugin_version.clone(),
        workspace_root: approved.key.workspace_root.to_string_lossy().to_string(),
        language: approved.key.language.clone(),
        server_id: approved.key.server_id.clone(),
        message,
    });
}

fn emit_stderr(sink: &LspEventSink, approved: &ApprovedServer, bytes: &[u8]) {
    sink(LspEvent::Stderr {
        plugin_id: approved.key.plugin_id.clone(),
        plugin_version: approved.key.plugin_version.clone(),
        workspace_root: approved.key.workspace_root.to_string_lossy().to_string(),
        language: approved.key.language.clone(),
        server_id: approved.key.server_id.clone(),
        text: String::from_utf8_lossy(bytes).into_owned(),
    });
}

fn remove_finished_session(inner: &Weak<Mutex<ManagerState>>, key: &SessionKey, id: u64) {
    if let Some(inner) = inner.upgrade() {
        if let Ok(mut state) = inner.lock() {
            if state.sessions.get(key).map(|session| session.id) == Some(id) {
                state.sessions.remove(key);
            }
        }
    }
}

fn stop_sessions(sessions: Vec<SessionHandle>) -> Result<(), String> {
    let mut first_error = None;
    for session in sessions {
        if let Err(error) = stop_session(session) {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn stop_session(session: SessionHandle) -> Result<(), String> {
    session.stop_requested.store(true, Ordering::Release);
    let _stop_lock = match session.stop_lock.try_lock() {
        Ok(lock) => lock,
        Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => {
            return Err("LSP cleanup is already in progress for this session.".to_string())
        }
    };
    let (ack_sender, ack_receiver) = mpsc::sync_channel(1);
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut message = Some(ControlMessage::Stop(ack_sender));
    let mut send_error = None;
    loop {
        let Some(next_message) = message.take() else {
            break;
        };
        match session.control.try_send(next_message) {
            Ok(()) => {
                session.wakeup.notify();
                break;
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {
                send_error = Some("LSP supervisor has already stopped.".to_string());
                break;
            }
            Err(mpsc::TrySendError::Full(next_message)) => {
                message = Some(next_message);
                if Instant::now() >= deadline {
                    send_error =
                        Some("LSP input queue stayed full while stopping the server.".to_string());
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
    }
    // While a wedged bootstrap restart is being spawned the
    // supervisor can hold its control channel for up to the startup
    // deadline, so the stop acknowledgement budget must cover that worst
    // case plus teardown instead of assuming the supervisor is polling.
    let cleanup = if let Some(error) = send_error {
        Err(error)
    } else {
        match ack_receiver.recv_timeout(Duration::from_secs(10)) {
            Ok(cleanup) => cleanup,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Err("Timed out while stopping LSP server.".to_string())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("LSP supervisor exited before confirming cleanup.".to_string())
            }
        }
    };
    #[cfg(unix)]
    if let Err(error) = cleanup {
        let process_group = session.process_group.load(Ordering::Acquire);
        return terminate_unix_process_group(process_group, LSP_PROCESS_GROUP_CLEANUP_TIMEOUT)
            .map_err(|fallback_error| {
                format!("{error}; process-group cleanup failed: {fallback_error}")
            });
    }
    cleanup
}

fn stop_sessions_bounded(
    sessions: Vec<SessionHandle>,
    deadline: Instant,
) -> (Vec<SessionHandle>, Result<(), String>) {
    let (result_sender, result_receiver) = mpsc::channel();
    let mut pending = HashMap::new();
    let mut failed = Vec::new();
    let mut errors = Vec::new();

    for session in sessions {
        let key = SessionKey {
            owner_window: session.owners.iter().next().cloned().unwrap_or_default(),
            workspace_root: session.approved.key.workspace_root.clone(),
            language: session.approved.key.language.clone(),
        };
        let worker_session = session.clone();
        let worker_key = key.clone();
        let worker_sender = result_sender.clone();
        session.cleanup_worker_active.store(true, Ordering::Release);
        let worker_active = Arc::clone(&session.cleanup_worker_active);
        match thread::Builder::new()
            .name("pude-lsp-stop".to_string())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    stop_session(worker_session)
                }))
                .unwrap_or_else(|_| Err("LSP cleanup worker panicked.".to_string()));
                worker_active.store(false, Ordering::Release);
                let _ = worker_sender.send((worker_key, result));
            }) {
            Ok(worker) => {
                pending.insert(key, (session, worker));
            }
            Err(error) => {
                session
                    .cleanup_worker_active
                    .store(false, Ordering::Release);
                errors.push(format!(
                    "{}: unable to start LSP cleanup worker: {error}",
                    session.approved.key.server_id
                ));
                failed.push(session);
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
            Ok((key, result)) => {
                let Some((session, worker)) = pending.remove(&key) else {
                    continue;
                };
                drop(worker);
                if let Err(error) = result {
                    errors.push(format!("{}: {error}", session.approved.key.server_id));
                    failed.push(session);
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                timed_out = true;
                break;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    if !pending.is_empty() {
        let reason = if timed_out {
            format!(
                "cleanup did not finish within {} seconds",
                LSP_CLEANUP_BATCH_TIMEOUT.as_secs()
            )
        } else {
            "cleanup worker ended without reporting a result".to_string()
        };
        for (_, (session, worker)) in pending.drain() {
            drop(worker);
            errors.push(format!("{}: {reason}", session.approved.key.server_id));
            failed.push(session);
        }
    }

    errors.sort();
    let result = if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Unable to clean up LSP sessions: {}",
            errors.join("; ")
        ))
    };
    (failed, result)
}

fn terminate_child(runtime: &mut ChildRuntime) {
    if let Err(error) = terminate_child_checked(runtime) {
        eprintln!("LSP process cleanup did not finish: {error}");
    }
}

fn terminate_child_checked(runtime: &mut ChildRuntime) -> Result<(), String> {
    #[cfg(unix)]
    {
        let process_group = runtime.child.id() as i32;
        let mut errors = Vec::new();
        if let Err(error) = signal_unix_process_group(process_group, libc::SIGTERM) {
            errors.push(error);
        }
        let deadline = Instant::now() + Duration::from_millis(300);
        while Instant::now() < deadline {
            match runtime.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {}
                Err(error) => {
                    errors.push(format!(
                        "Unable to inspect LSP process during cleanup. {error}"
                    ));
                    break;
                }
            }
            thread::sleep(Duration::from_millis(10));
        }
        if let Err(error) = signal_unix_process_group(process_group, libc::SIGKILL) {
            errors.push(error);
        }
        if let Err(error) = runtime.child.wait() {
            errors.push(format!("Unable to reap LSP process. {error}"));
        }
        if let Err(error) =
            wait_for_unix_process_group_empty(process_group, LSP_PROCESS_GROUP_CLEANUP_TIMEOUT)
        {
            errors.push(error);
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
    #[cfg(windows)]
    {
        runtime.job.terminate();
        let _ = runtime.child.kill();
        runtime
            .child
            .wait()
            .map(|_| ())
            .map_err(|error| format!("Unable to reap LSP process. {error}"))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = runtime.child.kill();
        runtime
            .child
            .wait()
            .map(|_| ())
            .map_err(|error| format!("Unable to reap LSP process. {error}"))
    }
}

#[cfg(unix)]
fn signal_unix_process_group(process_group: i32, signal: i32) -> Result<(), String> {
    if unsafe { libc::kill(-process_group, signal) } == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(format!(
            "Unable to signal LSP process group {process_group}. {error}"
        ))
    }
}

#[cfg(unix)]
fn wait_for_unix_process_group_empty(process_group: i32, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if unsafe { libc::kill(-process_group, 0) } == 0 {
            if Instant::now() >= deadline {
                return Err(format!(
                    "LSP child processes in group {process_group} did not exit before the cleanup deadline."
                ));
            }
            thread::sleep(Duration::from_millis(10));
            continue;
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        return Err(format!(
            "Unable to inspect LSP process group {process_group}. {error}"
        ));
    }
}

#[cfg(unix)]
fn terminate_unix_process_group(process_group: i32, timeout: Duration) -> Result<(), String> {
    signal_unix_process_group(process_group, libc::SIGKILL)?;
    wait_for_unix_process_group_empty(process_group, timeout)
}

fn cleanup_runtime(mut runtime: ChildRuntime) -> Result<(), String> {
    let mut errors = Vec::new();
    if let Err(error) = terminate_child_checked(&mut runtime) {
        errors.push(error);
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline
        && (!runtime.io_thread.is_finished() || !runtime.stderr_thread.is_finished())
    {
        while runtime.io.try_recv().is_ok() {}
        thread::sleep(Duration::from_millis(10));
    }
    if runtime.io_thread.is_finished() {
        if runtime.io_thread.join().is_err() {
            errors.push("LSP stdout reader thread panicked during cleanup.".to_string());
        }
    } else {
        errors.push("LSP stdout reader did not stop within 2 seconds.".to_string());
    }
    if runtime.stderr_thread.is_finished() {
        if runtime.stderr_thread.join().is_err() {
            errors.push("LSP stderr reader thread panicked during cleanup.".to_string());
        }
    } else {
        errors.push("LSP stderr reader did not stop within 2 seconds.".to_string());
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

pub fn read_lsp_message(reader: &mut impl BufRead) -> Result<Option<Value>, String> {
    let mut header_bytes = 0usize;
    let mut content_length = None;
    loop {
        let Some(mut line) = read_bounded_header_line(reader, MAX_LSP_HEADER_BYTES - header_bytes)?
        else {
            if header_bytes == 0 {
                return Ok(None);
            }
            return Err("LSP frame ended inside its header.".to_string());
        };
        header_bytes += line.len();
        while matches!(line.last(), Some(b'\n' | b'\r')) {
            line.pop();
        }
        if line.is_empty() {
            break;
        }
        let line = std::str::from_utf8(&line)
            .map_err(|_| "LSP frame header is not valid UTF-8.".to_string())?;
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| "LSP frame header is malformed.".to_string())?;
        if name.trim().eq_ignore_ascii_case("content-length") {
            if content_length.is_some() {
                return Err("LSP frame contains duplicate Content-Length headers.".to_string());
            }
            let length = value
                .trim()
                .parse::<usize>()
                .map_err(|_| "LSP Content-Length is invalid.".to_string())?;
            if length == 0 || length > MAX_LSP_MESSAGE_BYTES {
                return Err("LSP message exceeds the size limit.".to_string());
            }
            content_length = Some(length);
        }
    }
    let length =
        content_length.ok_or_else(|| "LSP frame is missing Content-Length.".to_string())?;
    let mut body = vec![0; length];
    reader
        .read_exact(&mut body)
        .map_err(|error| format!("Unable to read LSP frame body. {error}"))?;
    let value: Value = serde_json::from_slice(&body)
        .map_err(|_| "LSP message body is not valid JSON.".to_string())?;
    validate_json_rpc_message(&value)?;
    Ok(Some(value))
}

fn read_bounded_header_line(
    reader: &mut impl BufRead,
    maximum_bytes: usize,
) -> Result<Option<Vec<u8>>, String> {
    let mut line = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .map_err(|error| format!("Unable to read LSP frame header. {error}"))?;
        if available.is_empty() {
            if line.is_empty() {
                return Ok(None);
            }
            return Err("LSP frame ended inside its header.".to_string());
        }
        let length = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(available.len());
        if line.len().saturating_add(length) > maximum_bytes {
            return Err("LSP frame header exceeds the size limit.".to_string());
        }
        let has_newline = available.get(length.saturating_sub(1)) == Some(&b'\n');
        let bytes = available[..length].to_vec();
        reader.consume(length);
        line.extend_from_slice(&bytes);
        if has_newline {
            return Ok(Some(line));
        }
    }
}

pub fn write_lsp_message(writer: &mut impl Write, message: &Value) -> Result<(), String> {
    validate_json_rpc_message(message)?;
    let body = serde_json::to_vec(message)
        .map_err(|error| format!("Unable to encode LSP message. {error}"))?;
    if body.is_empty() || body.len() > MAX_LSP_MESSAGE_BYTES {
        return Err("LSP message exceeds the size limit.".to_string());
    }
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())
        .and_then(|_| writer.write_all(&body))
        .and_then(|_| writer.flush())
        .map_err(|error| format!("Unable to write LSP message. {error}"))
}

fn validate_json_rpc_message(message: &Value) -> Result<(), String> {
    if !message.is_object() || message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err("LSP message must be a JSON-RPC 2.0 object.".to_string());
    }
    if let Some(method) = message.get("method") {
        if !method
            .as_str()
            .map(|method| !method.is_empty())
            .unwrap_or(false)
        {
            return Err("LSP message method is invalid.".to_string());
        }
        if message.get("result").is_some() || message.get("error").is_some() {
            return Err("LSP request cannot contain a response result or error.".to_string());
        }
    } else if message.get("id").is_none()
        || (message.get("result").is_none() && message.get("error").is_none())
    {
        return Err("LSP response is missing an id, result, or error.".to_string());
    }
    Ok(())
}

fn validate_request_id(request_id: &Value) -> Result<(), String> {
    if request_id
        .as_str()
        .map(|value| !value.is_empty() && value.len() <= 128)
        .unwrap_or(false)
        || request_id.as_i64().is_some()
        || request_id.as_u64().is_some()
    {
        Ok(())
    } else {
        Err("LSP request id must be a non-empty string or integer.".to_string())
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::{
        canonicalize_server, complete_start, spawn_child, LspEventSink, SessionKey, StartCancel,
        StartCompletion, StartingEntry, NEXT_SESSION_ID,
    };
    #[cfg(windows)]
    use super::{canonicalize_server, windows_bootstrap, windows_job::JobObject, StartCancel};
    use super::{
        read_lsp_message, write_lsp_message, LspApprovalGrant, LspCancelRequest, LspEvent,
        LspManager, LspMessageRequest, LspServerDeclaration, LspServerRequest,
        MAX_LSP_MESSAGE_BYTES,
    };
    use serde_json::{json, Value};
    use std::io::{BufReader, Cursor};
    use std::process::Command;
    use std::sync::{mpsc, Arc};
    use std::time::{Duration, Instant};
    #[cfg(unix)]
    use std::{collections::HashSet, os::unix::fs::PermissionsExt};

    #[cfg(unix)]
    struct ProcessGroupCleanup(i32);

    #[cfg(unix)]
    impl Drop for ProcessGroupCleanup {
        fn drop(&mut self) {
            unsafe {
                let _ = libc::kill(-self.0, libc::SIGKILL);
            }
        }
    }

    fn frame(message: &Value) -> Vec<u8> {
        let body = serde_json::to_vec(message).unwrap();
        let mut framed = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
        framed.extend(body);
        framed
    }

    #[test]
    fn reads_multiple_json_rpc_frames_with_case_insensitive_headers() {
        let first = json!({"jsonrpc":"2.0","method":"initialized"});
        let second = json!({"jsonrpc":"2.0","id":7,"result":null});
        let mut bytes = b"cOnTeNt-LeNgTh: ".to_vec();
        let first_body = serde_json::to_vec(&first).unwrap();
        bytes.extend(first_body.len().to_string().as_bytes());
        bytes.extend_from_slice(b"\r\n\r\n");
        bytes.extend(first_body);
        bytes.extend(frame(&second));
        let mut reader = BufReader::new(Cursor::new(bytes));

        assert_eq!(read_lsp_message(&mut reader).unwrap(), Some(first));
        assert_eq!(read_lsp_message(&mut reader).unwrap(), Some(second));
        assert_eq!(read_lsp_message(&mut reader).unwrap(), None);
    }

    #[test]
    fn rejects_missing_duplicate_oversized_and_invalid_json_frames() {
        let mut missing = BufReader::new(Cursor::new(b"X-Test: yes\r\n\r\n{}"));
        assert!(read_lsp_message(&mut missing)
            .unwrap_err()
            .contains("missing Content-Length"));

        let mut duplicate = BufReader::new(Cursor::new(
            b"Content-Length: 2\r\ncontent-length: 2\r\n\r\n{}",
        ));
        assert!(read_lsp_message(&mut duplicate)
            .unwrap_err()
            .contains("duplicate"));

        let oversized = format!("Content-Length: {}\r\n\r\n", MAX_LSP_MESSAGE_BYTES + 1);
        let mut oversized = BufReader::new(Cursor::new(oversized));
        assert!(read_lsp_message(&mut oversized)
            .unwrap_err()
            .contains("size limit"));

        let mut oversized_header = BufReader::new(Cursor::new(vec![b'x'; 8 * 1024 + 1]));
        assert!(read_lsp_message(&mut oversized_header)
            .unwrap_err()
            .contains("header exceeds the size limit"));

        let mut invalid = BufReader::new(Cursor::new(b"Content-Length: 1\r\n\r\nx"));
        assert!(read_lsp_message(&mut invalid)
            .unwrap_err()
            .contains("valid JSON"));
    }

    #[test]
    fn writes_utf8_json_rpc_with_byte_length() {
        let message = json!({"jsonrpc":"2.0","method":"pude/test","params":{"text":"編輯器"}});
        let mut bytes = Vec::new();
        write_lsp_message(&mut bytes, &message).unwrap();
        let expected = serde_json::to_vec(&message).unwrap();
        assert!(bytes.starts_with(format!("Content-Length: {}\r\n\r\n", expected.len()).as_bytes()));
        assert!(bytes.ends_with(&expected));
    }

    #[test]
    fn rejects_non_json_rpc_messages() {
        let mut bytes = Vec::new();
        assert!(write_lsp_message(&mut bytes, &json!({"method":"not-jsonrpc"})).is_err());
        assert!(write_lsp_message(&mut bytes, &json!({"jsonrpc":"2.0","method":""})).is_err());
        assert!(write_lsp_message(&mut bytes, &json!({"jsonrpc":"2.0"})).is_err());
    }

    #[test]
    fn an_exact_approval_is_required_and_process_stdio_is_managed() {
        let workspace =
            std::env::temp_dir().join(format!("pude-lsp-workspace-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).unwrap();
        let (fixture_directory, executable) = compile_server_fixture();
        let manager = LspManager::default();
        let mut cleanup = TestCleanup::new(&manager);
        cleanup.track(fixture_directory.clone());
        cleanup.track(workspace.clone());
        #[cfg(windows)]
        {
            let (helper_directory, helper_executable) = compile_bootstrap_helper();
            cleanup.track(helper_directory);
            manager.set_bootstrap_launcher(Some(helper_executable));
        }
        let canonical_executable = std::fs::canonicalize(&executable).unwrap();
        let server = fixture_declaration(&executable, "echo");
        let grant = LspApprovalGrant {
            plugin_id: "pude.reference-lsp".to_string(),
            plugin_version: "1.0.0".to_string(),
            workspace_root: workspace.to_string_lossy().to_string(),
            server: server.clone(),
            expected_executable_path: canonical_executable.to_string_lossy().to_string(),
        };
        let mut changed_resolution = grant.clone();
        changed_resolution.expected_executable_path = workspace.to_string_lossy().to_string();
        assert!(manager
            .approve(changed_resolution)
            .unwrap_err()
            .contains("changed after it was reviewed"));
        manager.approve(grant).unwrap();

        let mut changed = server.clone();
        changed.args.push("different-argument".to_string());
        assert!(manager
            .start(
                LspServerRequest {
                    plugin_id: "pude.reference-lsp".to_string(),
                    plugin_version: "1.0.0".to_string(),
                    workspace_root: workspace.to_string_lossy().to_string(),
                    server: changed,
                },
                "main",
                Arc::new(|_| {}),
            )
            .unwrap_err()
            .contains("differ from the approved server"));

        let (event_sender, event_receiver) = mpsc::channel();
        manager
            .start(
                LspServerRequest {
                    plugin_id: "pude.reference-lsp".to_string(),
                    plugin_version: "1.0.0".to_string(),
                    workspace_root: workspace.to_string_lossy().to_string(),
                    server: server.clone(),
                },
                "main",
                Arc::new(move |event| {
                    let _ = event_sender.send(event);
                }),
            )
            .unwrap();
        wait_for_state(&event_receiver, "started");
        manager
            .send(
                LspMessageRequest {
                    plugin_id: "pude.reference-lsp".to_string(),
                    plugin_version: "1.0.0".to_string(),
                    workspace_root: workspace.to_string_lossy().to_string(),
                    language: "rust".to_string(),
                    message: json!({"jsonrpc":"2.0","id":"round-trip","method":"pude/echo","params":{"text":"hello"}}),
                },
                "main",
            )
            .unwrap();
        let response = wait_for_message(&event_receiver);
        assert_eq!(response["id"], "round-trip");
        assert_eq!(response["result"]["echo"]["text"], "hello");

        manager
            .cancel(
                LspCancelRequest {
                    plugin_id: "pude.reference-lsp".to_string(),
                    plugin_version: "1.0.0".to_string(),
                    workspace_root: workspace.to_string_lossy().to_string(),
                    language: "rust".to_string(),
                    request_id: json!("round-trip"),
                },
                "main",
            )
            .unwrap();
        let cancellation = wait_for_message(&event_receiver);
        assert_eq!(cancellation["method"], "pude/cancelReceived");
        assert_eq!(cancellation["params"]["id"], "round-trip");
        manager
            .stop(
                "pude.reference-lsp",
                "1.0.0",
                &workspace.to_string_lossy(),
                "rust",
                "main",
            )
            .unwrap();
        remove_dir_when_free(&workspace);
        remove_dir_when_free(&fixture_directory);
    }

    #[test]
    fn lsp_supervisor_drains_200_pipe_responses_and_diagnostics_without_control_traffic() {
        assert_lsp_burst_drains_in_order(200, Duration::from_secs(5));
    }

    #[test]
    fn lsp_supervisor_drains_1000_pipe_responses_and_diagnostics_without_control_traffic() {
        assert_lsp_burst_drains_in_order(1_000, Duration::from_secs(10));
    }

    fn assert_lsp_burst_drains_in_order(count: u64, deadline: Duration) {
        let (manager, _cleanup, workspace, event_receiver) = start_burst_fixture("burst");
        let expected_message_count = count as usize * 2;
        let collector = std::thread::spawn(move || {
            let mut messages = Vec::with_capacity(expected_message_count);
            let expires = Instant::now() + Duration::from_secs(20);
            while messages.len() < expected_message_count {
                let remaining = expires.saturating_duration_since(Instant::now());
                assert!(
                    !remaining.is_zero(),
                    "timed out collecting LSP burst events"
                );
                match event_receiver.recv_timeout(remaining) {
                    Ok(LspEvent::Message { message, .. }) => messages.push(message),
                    Ok(_) => {}
                    Err(error) => panic!("timed out collecting LSP burst events: {error}"),
                }
            }
            messages
        });

        let started = Instant::now();
        let mut sequence = 1u64;
        while sequence <= count {
            let result = manager.send(
                LspMessageRequest {
                    plugin_id: "pude.reference-lsp".to_string(),
                    plugin_version: "1.0.0".to_string(),
                    workspace_root: workspace.to_string_lossy().to_string(),
                    language: "rust".to_string(),
                    message: json!({
                        "jsonrpc": "2.0",
                        "id": sequence,
                        "method": "pude/burst",
                        "params": { "sequence": sequence }
                    }),
                },
                "burst-window",
            );
            match result {
                Ok(()) => sequence += 1,
                Err(error) if error == "LSP input queue is full." => {
                    assert!(
                        started.elapsed() < deadline,
                        "LSP burst admission exceeded {deadline:?}"
                    );
                    std::thread::yield_now();
                }
                Err(error) => panic!("LSP burst request was rejected: {error}"),
            }
            assert!(
                started.elapsed() < deadline,
                "LSP burst exceeded {deadline:?} while submitting requests"
            );
        }

        let messages = collector.join().expect("event collector should not panic");
        let elapsed = started.elapsed();
        assert_eq!(messages.len(), expected_message_count);
        for sequence in 1..=count {
            let diagnostics = &messages[(sequence as usize - 1) * 2];
            assert_eq!(
                diagnostics["method"], "textDocument/publishDiagnostics",
                "diagnostic notification order changed at sequence {sequence}"
            );
            assert_eq!(
                diagnostics["params"]["diagnostics"][0]["message"],
                format!("diagnostic-{sequence}")
            );
            let response = &messages[(sequence as usize - 1) * 2 + 1];
            assert_eq!(response["id"], sequence);
            assert_eq!(response["result"]["sequence"], sequence);
        }
        assert!(
            elapsed < deadline,
            "{count} response/diagnostic pairs took {elapsed:?}, expected under {deadline:?}"
        );
        manager
            .stop(
                "pude.reference-lsp",
                "1.0.0",
                &workspace.to_string_lossy(),
                "rust",
                "burst-window",
            )
            .expect("the burst server should stop cleanly");
    }

    #[test]
    fn lsp_cancel_is_processed_while_child_io_is_continuously_ready() {
        let (manager, _cleanup, workspace, event_receiver) = start_burst_fixture("flood");
        manager
            .send(
                LspMessageRequest {
                    plugin_id: "pude.reference-lsp".to_string(),
                    plugin_version: "1.0.0".to_string(),
                    workspace_root: workspace.to_string_lossy().to_string(),
                    language: "rust".to_string(),
                    message: json!({
                        "jsonrpc": "2.0",
                        "id": 9001,
                        "method": "pude/flood",
                        "params": {}
                    }),
                },
                "burst-window",
            )
            .unwrap();
        wait_for_diagnostics(&event_receiver, 5, Duration::from_secs(2));

        let canceled_at = Instant::now();
        manager
            .cancel(
                LspCancelRequest {
                    plugin_id: "pude.reference-lsp".to_string(),
                    plugin_version: "1.0.0".to_string(),
                    workspace_root: workspace.to_string_lossy().to_string(),
                    language: "rust".to_string(),
                    request_id: json!(31415),
                },
                "burst-window",
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut acknowledged = false;
        while Instant::now() < deadline {
            if let Ok(LspEvent::Message { message, .. }) =
                event_receiver.recv_timeout(Duration::from_millis(100))
            {
                if message["method"] == "pude/cancelReceived" {
                    assert_eq!(message["params"]["id"], 31415);
                    acknowledged = true;
                    break;
                }
            }
        }
        assert!(
            acknowledged,
            "the busy server did not observe Cancel promptly"
        );
        assert!(
            canceled_at.elapsed() < Duration::from_secs(2),
            "Cancel waited {:?} during continuous IO",
            canceled_at.elapsed()
        );
        manager
            .stop(
                "pude.reference-lsp",
                "1.0.0",
                &workspace.to_string_lossy(),
                "rust",
                "burst-window",
            )
            .expect("the busy server should stop cleanly after Cancel");
    }

    #[test]
    fn lsp_stop_reaps_child_and_io_readers_during_continuous_output() {
        let (manager, _cleanup, workspace, event_receiver) = start_burst_fixture("flood");
        manager
            .send(
                LspMessageRequest {
                    plugin_id: "pude.reference-lsp".to_string(),
                    plugin_version: "1.0.0".to_string(),
                    workspace_root: workspace.to_string_lossy().to_string(),
                    language: "rust".to_string(),
                    message: json!({
                        "jsonrpc": "2.0",
                        "id": 9002,
                        "method": "pude/flood",
                        "params": {}
                    }),
                },
                "burst-window",
            )
            .unwrap();
        wait_for_diagnostics(&event_receiver, 5, Duration::from_secs(2));

        let stopped_at = Instant::now();
        manager
            .stop(
                "pude.reference-lsp",
                "1.0.0",
                &workspace.to_string_lossy(),
                "rust",
                "burst-window",
            )
            .expect("Stop should complete while child output is ready");
        assert!(
            stopped_at.elapsed() < Duration::from_secs(2),
            "Stop took {:?} during continuous output",
            stopped_at.elapsed()
        );
        assert!(manager
            .send(
                LspMessageRequest {
                    plugin_id: "pude.reference-lsp".to_string(),
                    plugin_version: "1.0.0".to_string(),
                    workspace_root: workspace.to_string_lossy().to_string(),
                    language: "rust".to_string(),
                    message: json!({"jsonrpc":"2.0","method":"initialized"}),
                },
                "burst-window",
            )
            .unwrap_err()
            .contains("No LSP server is running"));
    }

    fn wait_for_diagnostics(
        receiver: &mpsc::Receiver<LspEvent>,
        expected: usize,
        timeout: Duration,
    ) {
        let deadline = Instant::now() + timeout;
        let mut received = 0;
        while received < expected {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(
                !remaining.is_zero(),
                "timed out waiting for flood diagnostics"
            );
            match receiver.recv_timeout(remaining) {
                Ok(LspEvent::Message { message, .. })
                    if message["method"] == "textDocument/publishDiagnostics" =>
                {
                    received += 1;
                }
                Ok(_) => {}
                Err(error) => panic!("timed out waiting for flood diagnostics: {error}"),
            }
        }
    }

    fn start_burst_fixture(
        mode: &str,
    ) -> (
        LspManager,
        TestCleanup,
        std::path::PathBuf,
        mpsc::Receiver<LspEvent>,
    ) {
        let workspace =
            std::env::temp_dir().join(format!("pude-lsp-burst-workspace-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).unwrap();
        let (fixture_directory, executable) = compile_fixture(
            "lsp_burst_fixture.rs",
            if cfg!(windows) {
                "lsp_burst_fixture.exe"
            } else {
                "lsp_burst_fixture"
            },
        );
        let manager = LspManager::default();
        let mut cleanup = TestCleanup::new(&manager);
        cleanup.track(workspace.clone());
        cleanup.track(fixture_directory);
        #[cfg(windows)]
        {
            let (helper_directory, helper_executable) = compile_bootstrap_helper();
            cleanup.track(helper_directory);
            manager.set_bootstrap_launcher(Some(helper_executable));
        }
        approve_fixture(&manager, &workspace, &executable, vec![mode.to_string()]);
        let (event_sender, event_receiver) = mpsc::channel();
        manager
            .start(
                start_fixture_request(&workspace, &executable, vec![mode.to_string()]),
                "burst-window",
                Arc::new(move |event| {
                    let _ = event_sender.send(event);
                }),
            )
            .unwrap();
        wait_for_state(&event_receiver, "started");
        (manager, cleanup, workspace, event_receiver)
    }

    #[cfg(unix)]
    #[test]
    fn failed_unix_launch_reports_the_error_and_allows_a_clean_retry() {
        let workspace =
            std::env::temp_dir().join(format!("pude-lsp-launch-fail-{}", uuid::Uuid::new_v4()));
        let script_directory =
            std::env::temp_dir().join(format!("pude-lsp-launch-fixture-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&script_directory).unwrap();
        let (fixture_directory, healthy_executable) = compile_server_fixture();
        let executable = script_directory.join("missing-interpreter-lsp");
        let missing_interpreter = script_directory.join("pude-missing-interpreter");
        std::fs::write(
            &executable,
            format!("#!{}\nexit 1\n", missing_interpreter.display()),
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();

        let manager = LspManager::default();
        let mut cleanup = TestCleanup::new(&manager);
        cleanup.track(workspace.clone());
        cleanup.track(script_directory.clone());
        cleanup.track(fixture_directory.clone());
        approve_fixture(&manager, &workspace, &executable, vec!["echo".to_string()]);
        let request = start_fixture_request(&workspace, &executable, vec!["echo".to_string()]);

        let (event_sender, event_receiver) = mpsc::channel();
        manager
            .start(
                request.clone(),
                "unix-launch-failure",
                Arc::new(move |event| {
                    let _ = event_sender.send(event);
                }),
            )
            .unwrap();
        let message =
            wait_for_state_message(&event_receiver, "startFailed", Duration::from_secs(3))
                .expect("the missing interpreter should produce a launch failure");
        assert!(
            message.contains("Unable to start approved LSP server"),
            "unexpected launch diagnostic: {message}"
        );
        assert!(message.contains("No such file") || message.contains("not found"));
        assert!(manager
            .send(
                LspMessageRequest {
                    plugin_id: "pude.reference-lsp".to_string(),
                    plugin_version: "1.0.0".to_string(),
                    workspace_root: workspace.to_string_lossy().to_string(),
                    language: "rust".to_string(),
                    message: json!({"jsonrpc":"2.0","method":"initialized"}),
                },
                "unix-launch-failure",
            )
            .unwrap_err()
            .contains("No LSP server is running"));

        std::fs::copy(&healthy_executable, &executable).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (event_sender, event_receiver) = mpsc::channel();
        manager
            .start(
                request,
                "unix-launch-failure",
                Arc::new(move |event| {
                    let _ = event_sender.send(event);
                }),
            )
            .unwrap();
        wait_for_state(&event_receiver, "started");
        manager
            .send(
                LspMessageRequest {
                    plugin_id: "pude.reference-lsp".to_string(),
                    plugin_version: "1.0.0".to_string(),
                    workspace_root: workspace.to_string_lossy().to_string(),
                    language: "rust".to_string(),
                    message: json!({"jsonrpc":"2.0","id":"retry","method":"pude/echo","params":{"text":"again"}}),
                },
                "unix-launch-failure",
            )
            .unwrap();
        let response = wait_for_message(&event_receiver);
        assert_eq!(response["id"], "round-trip");
        assert_eq!(response["result"]["echo"]["text"], "hello");
    }

    #[cfg(unix)]
    #[test]
    fn revoke_after_unix_spawn_reaps_the_late_start_without_registering_a_session() {
        let workspace =
            std::env::temp_dir().join(format!("pude-lsp-revoke-race-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).unwrap();
        let executable = workspace.join("held-lsp-server");
        let pid_path = workspace.join("server.pid");
        std::fs::write(
            &executable,
            "#!/bin/sh\nprintf '%s\\n' \"$$\" > \"$1\"\nwhile IFS= read -r line; do :; done\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();

        let server = LspServerDeclaration {
            server_id: "fixture".to_string(),
            language: "rust".to_string(),
            executable: executable.to_string_lossy().to_string(),
            args: vec![pid_path.to_string_lossy().to_string()],
        };
        let manager = LspManager::default();
        let mut cleanup = TestCleanup::new(&manager);
        cleanup.track(workspace.clone());
        manager
            .approve(LspApprovalGrant {
                plugin_id: "pude.reference-lsp".to_string(),
                plugin_version: "1.0.0".to_string(),
                workspace_root: workspace.to_string_lossy().to_string(),
                server: server.clone(),
                expected_executable_path: std::fs::canonicalize(&executable)
                    .unwrap()
                    .to_string_lossy()
                    .to_string(),
            })
            .unwrap();
        let approved = canonicalize_server(
            "pude.reference-lsp",
            "1.0.0",
            &workspace.to_string_lossy(),
            &server,
        )
        .unwrap();
        let session_key = SessionKey {
            owner_window: "revoke-race".to_string(),
            workspace_root: approved.key.workspace_root.clone(),
            language: approved.key.language.clone(),
        };
        let id = NEXT_SESSION_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let cancel = StartCancel::new().unwrap();
        let completion = Arc::new(StartCompletion::new());
        manager.inner.lock().unwrap().starting.insert(
            session_key.clone(),
            StartingEntry {
                id,
                approved: approved.clone(),
                owners: HashSet::from(["revoke-race".to_string()]),
                cancel: cancel.clone(),
                completion: Arc::clone(&completion),
                pending_process_group: None,
            },
        );

        let runtime = spawn_child(&approved, None, &cancel).expect("Unix LSP should spawn");
        let _process_group_cleanup = ProcessGroupCleanup(runtime.child.id() as i32);
        let pid_deadline = Instant::now() + Duration::from_secs(3);
        while !pid_path.exists() {
            assert!(
                Instant::now() < pid_deadline,
                "LSP fixture did not record its PID"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let child_pid = std::fs::read_to_string(&pid_path)
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();

        manager
            .revoke(
                "pude.reference-lsp",
                "1.0.0",
                &workspace.to_string_lossy(),
                "fixture",
                "rust",
            )
            .unwrap();
        assert!(
            cancel.is_canceled(),
            "revocation should cancel the reservation"
        );

        let (event_sender, event_receiver) = mpsc::channel();
        let event_sink: LspEventSink = Arc::new(move |event| {
            let _ = event_sender.send(event);
        });
        let cleanup_started = Instant::now();
        complete_start(
            Arc::downgrade(&manager.inner),
            session_key,
            id,
            approved,
            runtime,
            event_sink,
            None,
            completion,
        );
        assert!(cleanup_started.elapsed() < Duration::from_secs(5));
        let message = wait_for_state_message(&event_receiver, "stopped", Duration::from_secs(1))
            .expect("the canceled late start should report stopped");
        assert!(
            message.contains("canceled"),
            "unexpected state diagnostic: {message}"
        );

        let process_deadline = Instant::now() + Duration::from_secs(2);
        while unsafe { libc::kill(child_pid, 0) } == 0 {
            assert!(
                Instant::now() < process_deadline,
                "revoked LSP child survived cleanup"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH),
            "the revoked child must be gone, not merely inaccessible"
        );
        assert!(manager
            .send(
                LspMessageRequest {
                    plugin_id: "pude.reference-lsp".to_string(),
                    plugin_version: "1.0.0".to_string(),
                    workspace_root: workspace.to_string_lossy().to_string(),
                    language: "rust".to_string(),
                    message: json!({"jsonrpc":"2.0","method":"initialized"}),
                },
                "revoke-race",
            )
            .unwrap_err()
            .contains("No LSP server is running"));
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_window_waits_for_canceled_unix_start_to_reap_its_process_group() {
        let workspace = std::env::temp_dir().join(format!(
            "pude-lsp-window-cancel-race-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&workspace).unwrap();
        let executable = workspace.join("held-lsp-server");
        let pid_path = workspace.join("server.pid");
        std::fs::write(
            &executable,
            "#!/bin/sh\nprintf '%s\\n' \"$$\" > \"$1\"\nwhile IFS= read -r line; do :; done\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();

        let server = LspServerDeclaration {
            server_id: "fixture".to_string(),
            language: "rust".to_string(),
            executable: executable.to_string_lossy().to_string(),
            args: vec![pid_path.to_string_lossy().to_string()],
        };
        let request = start_fixture_request(&workspace, &executable, server.args.clone());
        let manager = LspManager::default();
        let mut cleanup = TestCleanup::new(&manager);
        cleanup.track(workspace.clone());
        manager
            .approve(LspApprovalGrant {
                plugin_id: "pude.reference-lsp".to_string(),
                plugin_version: "1.0.0".to_string(),
                workspace_root: workspace.to_string_lossy().to_string(),
                server: server.clone(),
                expected_executable_path: std::fs::canonicalize(&executable)
                    .unwrap()
                    .to_string_lossy()
                    .to_string(),
            })
            .unwrap();
        let approved = canonicalize_server(
            "pude.reference-lsp",
            "1.0.0",
            &workspace.to_string_lossy(),
            &server,
        )
        .unwrap();
        let session_key = SessionKey {
            owner_window: "closing-window".to_string(),
            workspace_root: approved.key.workspace_root.clone(),
            language: approved.key.language.clone(),
        };
        let id = NEXT_SESSION_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let cancel = StartCancel::new().unwrap();
        let completion = Arc::new(StartCompletion::new());
        manager.inner.lock().unwrap().starting.insert(
            session_key.clone(),
            StartingEntry {
                id,
                approved: approved.clone(),
                owners: HashSet::from(["closing-window".to_string()]),
                cancel: cancel.clone(),
                completion: Arc::clone(&completion),
                pending_process_group: None,
            },
        );

        let runtime = spawn_child(&approved, None, &cancel).expect("Unix LSP should spawn");
        let process_group = runtime.child.id() as i32;
        let _process_group_cleanup = ProcessGroupCleanup(process_group);
        let pid_deadline = Instant::now() + Duration::from_secs(3);
        while !pid_path.exists() {
            assert!(
                Instant::now() < pid_deadline,
                "LSP fixture did not record its PID"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let child_pid = std::fs::read_to_string(&pid_path)
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();

        let (event_sender, event_receiver) = mpsc::channel();
        let event_sink: LspEventSink = Arc::new(move |event| {
            let _ = event_sender.send(event);
        });
        let (continue_sender, continue_receiver) = mpsc::channel();
        let completion_inner = Arc::downgrade(&manager.inner);
        let completion_key = session_key.clone();
        let completion_approved = approved.clone();
        let completion_signal = Arc::clone(&completion);
        let complete_worker = std::thread::spawn(move || {
            continue_receiver
                .recv_timeout(Duration::from_secs(3))
                .expect("test should release late start completion");
            complete_start(
                completion_inner,
                completion_key,
                id,
                completion_approved,
                runtime,
                event_sink,
                None,
                completion_signal,
            );
        });

        let manager_for_cleanup = manager.clone();
        let (cleanup_sender, cleanup_receiver) = mpsc::channel();
        let cleanup_worker = std::thread::spawn(move || {
            let result = manager_for_cleanup.cleanup_window("closing-window");
            let _ = cleanup_sender.send(result);
        });
        let cancel_deadline = Instant::now() + Duration::from_secs(2);
        while !cancel.is_canceled() && Instant::now() < cancel_deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            cancel.is_canceled(),
            "window cleanup should cancel the start under the manager lock"
        );
        assert!(
            matches!(
                cleanup_receiver.recv_timeout(Duration::from_millis(100)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ),
            "cleanup must wait for the in-flight start completion"
        );
        assert!(manager
            .start(request, "closing-window", Arc::new(|_| {}))
            .unwrap_err()
            .contains("still cleaning up"));

        continue_sender
            .send(())
            .expect("late start completion should still be waiting");
        cleanup_receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("window cleanup should finish after the start worker exits")
            .expect("canceled start process group should be reaped");
        let cleanup_returned_group_status = unsafe { libc::kill(-process_group, 0) };
        let cleanup_returned_group_error = std::io::Error::last_os_error().raw_os_error();
        assert_eq!(
            cleanup_returned_group_status, -1,
            "window cleanup must return only after the owned process group is gone"
        );
        assert_eq!(
            cleanup_returned_group_error,
            Some(libc::ESRCH),
            "the process group should be absent, not merely inaccessible"
        );
        complete_worker
            .join()
            .expect("late start completion worker should exit");
        cleanup_worker
            .join()
            .expect("window cleanup worker should exit");
        super::wait_for_unix_process_group_empty(process_group, Duration::from_secs(1))
            .expect("cleanup success must mean the process group is gone");
        assert_eq!(unsafe { libc::kill(child_pid, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
        let state = manager.inner.lock().unwrap();
        assert!(!state.starting.contains_key(&session_key));
        assert!(!state.sessions.contains_key(&session_key));
        drop(state);
        let _ = event_receiver.try_iter().collect::<Vec<_>>();
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_window_reaps_only_its_own_unix_server() {
        let workspace =
            std::env::temp_dir().join(format!("pude-lsp-shared-window-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).unwrap();
        let (fixture_directory, executable) = compile_server_fixture();
        let pid_path = workspace.join("server.pid");
        let args = vec![
            "record-pid".to_string(),
            pid_path.to_string_lossy().to_string(),
        ];
        let manager = LspManager::default();
        let mut cleanup = TestCleanup::new(&manager);
        cleanup.track(workspace.clone());
        cleanup.track(fixture_directory);
        approve_fixture(&manager, &workspace, &executable, args.clone());
        let request = start_fixture_request(&workspace, &executable, args);

        let (event_sender, event_receiver) = mpsc::channel();
        manager
            .start(
                request.clone(),
                "first-window",
                Arc::new(move |event| {
                    let _ = event_sender.send(event);
                }),
            )
            .unwrap();
        wait_for_state(&event_receiver, "started");
        let pid_deadline = Instant::now() + Duration::from_secs(3);
        while !pid_path.exists() {
            assert!(
                Instant::now() < pid_deadline,
                "LSP fixture did not record its PID"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let process_group = std::fs::read_to_string(&pid_path)
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();
        let _process_group_cleanup = ProcessGroupCleanup(process_group);

        std::fs::remove_file(&pid_path).unwrap();
        let (second_sender, second_receiver) = mpsc::channel();
        manager
            .start(
                request,
                "second-window",
                Arc::new(move |event| {
                    let _ = second_sender.send(event);
                }),
            )
            .expect("each window should start its own approved server");
        wait_for_state(&second_receiver, "started");
        let deadline = Instant::now() + Duration::from_secs(3);
        while !pid_path.exists() {
            assert!(
                Instant::now() < deadline,
                "second server did not record its PID"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let second_group = std::fs::read_to_string(&pid_path)
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();
        let _second_cleanup = ProcessGroupCleanup(second_group);
        assert_ne!(process_group, second_group);
        manager
            .cleanup_window("first-window")
            .expect("first window cleanup should finish");
        assert_eq!(unsafe { libc::kill(-process_group, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
        assert_eq!(unsafe { libc::kill(-second_group, 0) }, 0);
        manager
            .send(
                LspMessageRequest {
                    plugin_id: "pude.reference-lsp".to_string(),
                    plugin_version: "1.0.0".to_string(),
                    workspace_root: workspace.to_string_lossy().to_string(),
                    language: "rust".to_string(),
                    message: json!({"jsonrpc":"2.0","id":"shared-owner","method":"pude/echo","params":{"text":"still-running"}}),
                },
                "second-window",
            )
            .expect("the remaining owner should still be allowed to use the server");
        assert_eq!(wait_for_message(&second_receiver)["id"], "round-trip");

        manager
            .cleanup_window("second-window")
            .expect("closing the second window should await its server cleanup");
        let cleanup_returned_group_status = unsafe { libc::kill(-second_group, 0) };
        let cleanup_returned_group_error = std::io::Error::last_os_error().raw_os_error();
        assert_eq!(
            cleanup_returned_group_status, -1,
            "second-window cleanup must return only after the owned process group is gone"
        );
        assert_eq!(
            cleanup_returned_group_error,
            Some(libc::ESRCH),
            "the process group should be absent, not merely inaccessible"
        );
        super::wait_for_unix_process_group_empty(second_group, Duration::from_secs(1))
            .expect("second-window cleanup should not return while the group is live");
        assert!(manager.inner.lock().unwrap().sessions.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_cleanup_of_independent_unix_windows_does_not_conflict() {
        let root = std::env::temp_dir().join(format!(
            "pude-lsp-independent-window-cleanup-{}",
            uuid::Uuid::new_v4()
        ));
        let workspace_a = root.join("workspace-a");
        let workspace_b = root.join("workspace-b");
        std::fs::create_dir_all(&workspace_a).unwrap();
        std::fs::create_dir_all(&workspace_b).unwrap();
        let (fixture_directory, executable) = compile_server_fixture();
        let pid_path_a = workspace_a.join("server.pid");
        let pid_path_b = workspace_b.join("server.pid");
        let args_a = vec![
            "record-pid".to_string(),
            pid_path_a.to_string_lossy().to_string(),
        ];
        let args_b = vec![
            "record-pid".to_string(),
            pid_path_b.to_string_lossy().to_string(),
        ];
        let manager = LspManager::default();
        let mut cleanup = TestCleanup::new(&manager);
        cleanup.track(root);
        cleanup.track(fixture_directory);
        approve_fixture(&manager, &workspace_a, &executable, args_a.clone());
        approve_fixture(&manager, &workspace_b, &executable, args_b.clone());
        let request_a = start_fixture_request(&workspace_a, &executable, args_a);
        let request_b = start_fixture_request(&workspace_b, &executable, args_b);

        let (event_sender, event_receiver) = mpsc::channel();
        let event_sink: LspEventSink = Arc::new(move |event| {
            let _ = event_sender.send(event);
        });
        manager
            .start(request_a, "window-a", Arc::clone(&event_sink))
            .expect("window A should start its independent LSP server");
        manager
            .start(request_b, "window-b", event_sink)
            .expect("window B should start its independent LSP server");
        wait_for_state(&event_receiver, "started");
        wait_for_state(&event_receiver, "started");

        let pid_deadline = Instant::now() + Duration::from_secs(3);
        while !pid_path_a.exists() || !pid_path_b.exists() {
            assert!(
                Instant::now() < pid_deadline,
                "independent LSP fixtures did not both record their process IDs"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let process_group_a = std::fs::read_to_string(&pid_path_a)
            .expect("window A fixture should record its PID")
            .trim()
            .parse::<i32>()
            .expect("window A PID should be numeric");
        let process_group_b = std::fs::read_to_string(&pid_path_b)
            .expect("window B fixture should record its PID")
            .trim()
            .parse::<i32>()
            .expect("window B PID should be numeric");
        let process_group_cleanup_a = ProcessGroupCleanup(process_group_a);
        let process_group_cleanup_b = ProcessGroupCleanup(process_group_b);

        assert_eq!(
            unsafe { libc::kill(-process_group_a, libc::SIGSTOP) },
            0,
            "window A fixture should pause so its cleanup remains active while B closes"
        );
        assert_eq!(
            unsafe { libc::kill(-process_group_b, libc::SIGSTOP) },
            0,
            "window B fixture should pause so cleanup exercises real process groups"
        );

        let manager_a = manager.clone();
        let (cleanup_sender_a, cleanup_receiver_a) = mpsc::channel();
        let cleanup_thread_a = std::thread::spawn(move || {
            let _ = cleanup_sender_a.send(manager_a.cleanup_window("window-a"));
        });
        let active_deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let cleanup_active = manager
                .inner
                .lock()
                .unwrap()
                .sessions
                .values()
                .any(|session| {
                    session.owners.contains("window-a")
                        && session.stopping.load(std::sync::atomic::Ordering::Acquire)
                        && session
                            .cleanup_worker_active
                            .load(std::sync::atomic::Ordering::Acquire)
                });
            if cleanup_active {
                break;
            }
            assert!(
                Instant::now() < active_deadline,
                "window A cleanup did not enter its bounded process-group teardown"
            );
            std::thread::sleep(Duration::from_millis(5));
        }

        let manager_b = manager.clone();
        let (cleanup_sender_b, cleanup_receiver_b) = mpsc::channel();
        let cleanup_thread_b = std::thread::spawn(move || {
            let _ = cleanup_sender_b.send(manager_b.cleanup_window("window-b"));
        });
        cleanup_receiver_a
            .recv_timeout(Duration::from_secs(8))
            .expect("window A cleanup should finish within its bounded deadline")
            .expect("window A cleanup should not fail because window B has an independent session");
        let group_a_status = unsafe { libc::kill(-process_group_a, 0) };
        let group_a_error = std::io::Error::last_os_error().raw_os_error();
        assert_eq!(
            group_a_status, -1,
            "window A cleanup must return only after its process group is gone"
        );
        assert_eq!(group_a_error, Some(libc::ESRCH));
        super::wait_for_unix_process_group_empty(process_group_a, Duration::from_secs(1))
            .expect("window A process group should remain empty after cleanup returns");
        std::mem::forget(process_group_cleanup_a);

        cleanup_receiver_b
            .recv_timeout(Duration::from_secs(8))
            .expect("window B cleanup should finish within its bounded deadline")
            .expect("window B cleanup should ignore window A's independent cleanup state");
        let group_b_status = unsafe { libc::kill(-process_group_b, 0) };
        let group_b_error = std::io::Error::last_os_error().raw_os_error();
        assert_eq!(
            group_b_status, -1,
            "window B cleanup must return only after its process group is gone"
        );
        assert_eq!(group_b_error, Some(libc::ESRCH));
        super::wait_for_unix_process_group_empty(process_group_b, Duration::from_secs(1))
            .expect("window B process group should remain empty after cleanup returns");
        std::mem::forget(process_group_cleanup_b);

        cleanup_thread_a
            .join()
            .expect("window A cleanup thread should exit");
        cleanup_thread_b
            .join()
            .expect("window B cleanup thread should exit");
        assert!(manager.inner.lock().unwrap().sessions.is_empty());
    }

    #[test]
    fn each_window_has_independent_documents_channels_and_cleanup() {
        for separate_workspace in [false, true] {
            let root =
                std::env::temp_dir().join(format!("pude-lsp-windows-{}", uuid::Uuid::new_v4()));
            let workspace_a = root.join("a");
            let workspace_b = if separate_workspace {
                root.join("b")
            } else {
                workspace_a.clone()
            };
            std::fs::create_dir_all(&workspace_a).unwrap();
            std::fs::create_dir_all(&workspace_b).unwrap();
            let (fixture_directory, executable) = compile_server_fixture();
            let manager = LspManager::default();
            let mut cleanup = TestCleanup::new(&manager);
            cleanup.track(root);
            cleanup.track(fixture_directory);
            #[cfg(windows)]
            {
                let (helper_directory, helper_executable) = compile_bootstrap_helper();
                cleanup.track(helper_directory);
                manager.set_bootstrap_launcher(Some(helper_executable));
            }
            for workspace in [&workspace_a, &workspace_b] {
                approve_fixture(&manager, workspace, &executable, vec!["echo".to_string()]);
            }
            let start = |workspace: &std::path::Path, owner: &str| {
                let (sender, receiver) = mpsc::channel();
                manager
                    .start(
                        start_fixture_request(workspace, &executable, vec!["echo".to_string()]),
                        owner,
                        Arc::new(move |event| {
                            let _ = sender.send(event);
                        }),
                    )
                    .unwrap();
                wait_for_state(&receiver, "started");
                receiver
            };
            let receiver_a = start(&workspace_a, "window-a");
            let receiver_b = start(&workspace_b, "window-b");
            assert!(manager
                .start(
                    start_fixture_request(&workspace_a, &executable, vec!["echo".to_string()]),
                    "window-a",
                    Arc::new(|_| panic!("duplicate start must not replace the channel")),
                )
                .is_err());
            let send = |workspace: &std::path::Path, owner: &str, message: Value| {
                manager.send(
                    LspMessageRequest {
                        plugin_id: "pude.reference-lsp".to_string(),
                        plugin_version: "1.0.0".to_string(),
                        workspace_root: workspace.to_string_lossy().to_string(),
                        language: "rust".to_string(),
                        message,
                    },
                    owner,
                )
            };
            let query = || json!({"jsonrpc":"2.0","id":"document","method":"pude/document"});
            for (workspace, owner) in [(&workspace_a, "window-a"), (&workspace_b, "window-b")] {
                send(workspace, owner, json!({"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"file:///shared.rs","text":owner}}})).unwrap();
                send(workspace, owner, query()).unwrap();
            }
            let response_a = wait_for_message(&receiver_a);
            let response_b = wait_for_message(&receiver_b);
            assert_eq!(response_a["id"], response_b["id"]);
            assert_eq!(response_a["result"]["text"], "window-a");
            assert_eq!(response_b["result"]["text"], "window-b");
            manager.cleanup_window("window-a").unwrap();
            assert!(send(&workspace_a, "window-a", query()).is_err());
            send(&workspace_b, "window-b", query()).unwrap();
            assert_eq!(wait_for_message(&receiver_b)["result"]["text"], "window-b");
            let restarted = start(&workspace_a, "window-a");
            send(&workspace_a, "window-a", query()).unwrap();
            assert_eq!(wait_for_message(&restarted)["result"]["text"], "");
            send(&workspace_b, "window-b", query()).unwrap();
            assert_eq!(wait_for_message(&receiver_b)["result"]["text"], "window-b");
            manager.cleanup_window("window-a").unwrap();
            manager.cleanup_window("window-b").unwrap();
            let state = manager.inner.lock().unwrap();
            assert!(state.sessions.is_empty());
            assert!(state.starting.is_empty());
        }
    }

    #[test]
    fn automatic_restarts_stop_after_the_bounded_limit() {
        let workspace =
            std::env::temp_dir().join(format!("pude-lsp-restart-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).unwrap();
        let (fixture_directory, executable) = compile_server_fixture();
        let manager = LspManager::default();
        let mut cleanup = TestCleanup::new(&manager);
        cleanup.track(fixture_directory.clone());
        cleanup.track(workspace.clone());
        #[cfg(windows)]
        {
            let (helper_directory, helper_executable) = compile_bootstrap_helper();
            cleanup.track(helper_directory);
            manager.set_bootstrap_launcher(Some(helper_executable));
        }
        let server = fixture_declaration(&executable, "crash");
        let canonical_executable = std::fs::canonicalize(&executable).unwrap();
        manager
            .approve(LspApprovalGrant {
                plugin_id: "pude.reference-lsp".to_string(),
                plugin_version: "1.0.0".to_string(),
                workspace_root: workspace.to_string_lossy().to_string(),
                server: server.clone(),
                expected_executable_path: canonical_executable.to_string_lossy().to_string(),
            })
            .unwrap();
        let (event_sender, event_receiver) = mpsc::channel();
        manager
            .start(
                LspServerRequest {
                    plugin_id: "pude.reference-lsp".to_string(),
                    plugin_version: "1.0.0".to_string(),
                    workspace_root: workspace.to_string_lossy().to_string(),
                    server,
                },
                "restart-test",
                Arc::new(move |event| {
                    let _ = event_sender.send(event);
                }),
            )
            .unwrap();

        let mut started = 0;
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        let mut final_state = None;
        while std::time::Instant::now() < deadline {
            match event_receiver.recv_timeout(Duration::from_millis(500)) {
                Ok(LspEvent::State { state, .. }) if state == "started" => started += 1,
                Ok(LspEvent::State { state, message, .. }) if state == "stopped" => {
                    final_state = Some(message);
                    break;
                }
                Ok(_) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        assert_eq!(started, 4, "one initial start plus three bounded restarts");
        assert!(final_state
            .flatten()
            .unwrap_or_default()
            .contains("restart limit"));
        remove_dir_when_free(&workspace);
        remove_dir_when_free(&fixture_directory);
    }

    #[cfg(windows)]
    #[test]
    fn bootstrap_that_never_connects_times_out_with_a_bounded_diagnostic() {
        let workspace =
            std::env::temp_dir().join(format!("pude-lsp-noconnect-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).unwrap();
        let (server_directory, server_executable) = compile_server_fixture();
        let (sleep_directory, sleep_executable) =
            compile_fixture("lsp_bootstrap_sleep_fixture.rs", "lsp_bootstrap_sleep.exe");
        let manager = LspManager::default();
        let mut cleanup = TestCleanup::new(&manager);
        cleanup.track(server_directory.clone());
        cleanup.track(sleep_directory.clone());
        cleanup.track(workspace.clone());
        manager.set_bootstrap_launcher(Some(sleep_executable));
        approve_fixture(
            &manager,
            &workspace,
            &server_executable,
            vec!["echo".to_string()],
        );

        let (event_sender, event_receiver) = mpsc::channel();
        let started_at = std::time::Instant::now();
        manager
            .start(
                start_fixture_request(&workspace, &server_executable, vec!["echo".to_string()]),
                "no-connect-test",
                Arc::new(move |event| {
                    let _ = event_sender.send(event);
                }),
            )
            .unwrap();
        let message =
            wait_for_state_message(&event_receiver, "startFailed", Duration::from_secs(12))
                .expect("start failure should carry a diagnostic");
        assert!(
            started_at.elapsed() >= Duration::from_secs(4),
            "the bounded wait should approach the startup deadline, returned after {:?}",
            started_at.elapsed()
        );
        assert!(
            message.contains("connect"),
            "unexpected diagnostic: {message}"
        );
        assert!(
            message.contains("deadline"),
            "unexpected diagnostic: {message}"
        );
        let send_error = manager
            .send(
                LspMessageRequest {
                    plugin_id: "pude.reference-lsp".to_string(),
                    plugin_version: "1.0.0".to_string(),
                    workspace_root: workspace.to_string_lossy().to_string(),
                    language: "rust".to_string(),
                    message: json!({"jsonrpc":"2.0","method":"initialized"}),
                },
                "no-connect-test",
            )
            .unwrap_err();
        assert!(
            send_error.contains("No LSP server is running"),
            "unexpected send error: {send_error}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn bootstrap_that_exits_immediately_is_diagnosed_and_the_start_can_be_retried() {
        // The server fixture exits with a failure code for unknown switches,
        // so using it as the launcher models a bootstrap binary that dies
        // before the pipe handshake.
        let workspace =
            std::env::temp_dir().join(format!("pude-lsp-earlyexit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).unwrap();
        let (server_directory, server_executable) = compile_server_fixture();
        let (helper_directory, helper_executable) = compile_bootstrap_helper();
        let manager = LspManager::default();
        let mut cleanup = TestCleanup::new(&manager);
        cleanup.track(server_directory.clone());
        cleanup.track(helper_directory.clone());
        cleanup.track(workspace.clone());
        manager.set_bootstrap_launcher(Some(server_executable.clone()));
        approve_fixture(
            &manager,
            &workspace,
            &server_executable,
            vec!["echo".to_string()],
        );

        let (event_sender, event_receiver) = mpsc::channel();
        manager
            .start(
                start_fixture_request(&workspace, &server_executable, vec!["echo".to_string()]),
                "early-exit-test",
                Arc::new(move |event| {
                    let _ = event_sender.send(event);
                }),
            )
            .unwrap();
        let message =
            wait_for_state_message(&event_receiver, "startFailed", Duration::from_secs(10))
                .expect("start failure should carry a diagnostic");
        assert!(
            message.contains("exited early"),
            "unexpected diagnostic: {message}"
        );

        // The failed start must release its reservation so a retry can
        // succeed with a healthy launcher.
        manager.set_bootstrap_launcher(Some(helper_executable));
        let (event_sender, event_receiver) = mpsc::channel();
        manager
            .start(
                start_fixture_request(&workspace, &server_executable, vec!["echo".to_string()]),
                "early-exit-test",
                Arc::new(move |event| {
                    let _ = event_sender.send(event);
                }),
            )
            .unwrap();
        wait_for_state(&event_receiver, "started");
        manager
            .send(
                LspMessageRequest {
                    plugin_id: "pude.reference-lsp".to_string(),
                    plugin_version: "1.0.0".to_string(),
                    workspace_root: workspace.to_string_lossy().to_string(),
                    language: "rust".to_string(),
                    message: json!({"jsonrpc":"2.0","id":"retry","method":"pude/echo","params":{"text":"again"}}),
                },
                "early-exit-test",
            )
            .unwrap();
        let response = wait_for_message(&event_receiver);
        // The fixture echoes a hard-coded response; reaching it proves the
        // retried session is a live server, not the failed start revived.
        assert_eq!(response["id"], "round-trip");
        assert_eq!(response["result"]["echo"]["text"], "hello");
    }

    #[cfg(windows)]
    #[test]
    fn bootstrap_that_connects_but_never_reads_hits_the_payload_write_deadline() {
        let workspace =
            std::env::temp_dir().join(format!("pude-lsp-noread-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).unwrap();
        let (server_directory, server_executable) = compile_server_fixture();
        let (stall_directory, stall_executable) =
            compile_fixture("lsp_bootstrap_stall_fixture.rs", "lsp_bootstrap_stall.exe");
        let manager = LspManager::default();
        let mut cleanup = TestCleanup::new(&manager);
        cleanup.track(server_directory.clone());
        cleanup.track(stall_directory.clone());
        cleanup.track(workspace.clone());
        manager.set_bootstrap_launcher(Some(stall_executable));
        // Pad the approved arguments so the encoded payload is comfortably
        // larger than the 16 KiB pipe buffer; the stall fixture then blocks
        // the overlapped payload write until the startup deadline.
        let padded_args = vec!["x".repeat(7 * 1024); 3];
        approve_fixture(
            &manager,
            &workspace,
            &server_executable,
            padded_args.clone(),
        );

        let (event_sender, event_receiver) = mpsc::channel();
        manager
            .start(
                start_fixture_request(&workspace, &server_executable, padded_args),
                "no-read-test",
                Arc::new(move |event| {
                    let _ = event_sender.send(event);
                }),
            )
            .unwrap();
        let message =
            wait_for_state_message(&event_receiver, "startFailed", Duration::from_secs(12))
                .expect("start failure should carry a diagnostic");
        assert!(
            message.contains("payload write"),
            "unexpected diagnostic: {message}"
        );
        assert!(
            message.contains("deadline"),
            "unexpected diagnostic: {message}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn job_assignment_failure_is_reported_and_the_bootstrap_is_reaped() {
        let workspace =
            std::env::temp_dir().join(format!("pude-lsp-badjob-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).unwrap();
        let (server_directory, server_executable) = compile_server_fixture();
        let (helper_directory, helper_executable) = compile_bootstrap_helper();
        let approved = canonicalize_server(
            "pude.reference-lsp",
            "1.0.0",
            &workspace.to_string_lossy(),
            &LspServerDeclaration {
                server_id: "fixture".to_string(),
                language: "rust".to_string(),
                executable: server_executable.to_string_lossy().to_string(),
                args: vec!["echo".to_string()],
            },
        )
        .unwrap();

        let mut broken_job = JobObject::new().unwrap();
        broken_job.close_for_test();
        let cancel = StartCancel::new().unwrap();
        let started_at = std::time::Instant::now();
        let error = match windows_bootstrap::spawn_for_test(
            &approved,
            Some(&helper_executable),
            &cancel,
            broken_job,
        ) {
            Ok(_) => panic!("spawn with a broken job object should fail"),
            Err(error) => error,
        };
        assert!(
            error.contains("cleanup job"),
            "unexpected assignment error: {error}"
        );
        assert!(
            started_at.elapsed() < Duration::from_secs(5),
            "assignment failure should return immediately, took {:?}",
            started_at.elapsed()
        );

        // A healthy spawn still works afterwards and its child is reaped.
        let valid_job = JobObject::new().unwrap();
        let (mut child, job) = windows_bootstrap::spawn_for_test(
            &approved,
            Some(&helper_executable),
            &cancel,
            valid_job,
        )
        .unwrap();
        job.terminate();
        let _ = child.kill();
        let _ = child.wait();
        remove_dir_when_free(&workspace);
        remove_dir_when_free(&server_directory);
        remove_dir_when_free(&helper_directory);
    }

    #[cfg(windows)]
    #[test]
    fn revoke_during_start_cancels_the_bootstrap_without_reviving_the_session() {
        let workspace =
            std::env::temp_dir().join(format!("pude-lsp-revoke-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).unwrap();
        let (server_directory, server_executable) = compile_server_fixture();
        let (sleep_directory, sleep_executable) =
            compile_fixture("lsp_bootstrap_sleep_fixture.rs", "lsp_bootstrap_sleep.exe");
        let (helper_directory, helper_executable) = compile_bootstrap_helper();
        let manager = LspManager::default();
        let mut cleanup = TestCleanup::new(&manager);
        cleanup.track(server_directory.clone());
        cleanup.track(sleep_directory.clone());
        cleanup.track(helper_directory.clone());
        cleanup.track(workspace.clone());
        manager.set_bootstrap_launcher(Some(sleep_executable));
        approve_fixture(
            &manager,
            &workspace,
            &server_executable,
            vec!["echo".to_string()],
        );

        let (event_sender, event_receiver) = mpsc::channel();
        manager
            .start(
                start_fixture_request(&workspace, &server_executable, vec!["echo".to_string()]),
                "revoke-race",
                Arc::new(move |event| {
                    let _ = event_sender.send(event);
                }),
            )
            .unwrap();
        manager
            .revoke(
                "pude.reference-lsp",
                "1.0.0",
                &workspace.to_string_lossy(),
                "fixture",
                "rust",
            )
            .unwrap();

        // The cancel event wakes the overlapped wait immediately, so the
        // terminal state arrives well before the startup deadline.
        let settled_at = std::time::Instant::now();
        let deadline = std::time::Instant::now() + Duration::from_secs(12);
        let mut saw_started = false;
        let mut saw_start_failed = false;
        let message = loop {
            match event_receiver.recv_timeout(Duration::from_millis(200)) {
                Ok(LspEvent::State { state, message, .. }) if state == "stopped" => break message,
                Ok(LspEvent::State { state, .. }) if state == "started" => saw_started = true,
                Ok(LspEvent::State { state, .. }) if state == "startFailed" => {
                    saw_start_failed = true
                }
                Ok(_) => {}
                Err(_) => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "timed out waiting for the canceled start to settle"
                    );
                }
            }
        };
        assert!(!saw_started, "a canceled start must never emit started");
        assert!(
            !saw_start_failed,
            "a canceled start must not be reported as a failure"
        );
        assert!(
            settled_at.elapsed() < Duration::from_secs(5),
            "cancel should return before the startup deadline, took {:?}",
            settled_at.elapsed()
        );
        let text = message.unwrap_or_default();
        assert!(text.contains("canceled"), "unexpected diagnostic: {text}");
        let send_error = manager
            .send(
                LspMessageRequest {
                    plugin_id: "pude.reference-lsp".to_string(),
                    plugin_version: "1.0.0".to_string(),
                    workspace_root: workspace.to_string_lossy().to_string(),
                    language: "rust".to_string(),
                    message: json!({"jsonrpc":"2.0","method":"initialized"}),
                },
                "revoke-race",
            )
            .unwrap_err();
        assert!(
            send_error.contains("No LSP server is running"),
            "unexpected send error: {send_error}"
        );

        // Re-approving and starting with a healthy launcher produces a real
        // new session; the canceled start must not be revived.
        approve_fixture(
            &manager,
            &workspace,
            &server_executable,
            vec!["echo".to_string()],
        );
        manager.set_bootstrap_launcher(Some(helper_executable));
        let (event_sender, event_receiver) = mpsc::channel();
        manager
            .start(
                start_fixture_request(&workspace, &server_executable, vec!["echo".to_string()]),
                "revoke-race",
                Arc::new(move |event| {
                    let _ = event_sender.send(event);
                }),
            )
            .unwrap();
        wait_for_state(&event_receiver, "started");
    }

    /// Drop-time cleanup so a panicking test still stops its servers and
    /// removes its temporary directories (tests must not depend on
    /// the CI runner to clean up processes).
    struct TestCleanup {
        manager: LspManager,
        directories: Vec<std::path::PathBuf>,
    }

    impl TestCleanup {
        fn new(manager: &LspManager) -> Self {
            Self {
                manager: manager.clone(),
                directories: Vec::new(),
            }
        }

        fn track(&mut self, directory: std::path::PathBuf) {
            self.directories.push(directory);
        }
    }

    impl Drop for TestCleanup {
        fn drop(&mut self) {
            let _ = self.manager.stop_plugin("pude.reference-lsp");
            for directory in &self.directories {
                let _ = std::fs::remove_dir_all(directory);
            }
        }
    }

    fn compile_fixture(
        source_name: &str,
        executable_name: &str,
    ) -> (std::path::PathBuf, std::path::PathBuf) {
        let directory =
            std::env::temp_dir().join(format!("pude-lsp-fixture-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let source = directory.join(source_name);
        let executable = directory.join(executable_name);
        let fixture_source = match source_name {
            "lsp_server_fixture.rs" => include_str!("../tests/fixtures/lsp_server_fixture.rs"),
            "lsp_burst_fixture.rs" => include_str!("../tests/fixtures/lsp_burst_fixture.rs"),
            "lsp_bootstrap_fixture.rs" => {
                include_str!("../tests/fixtures/lsp_bootstrap_fixture.rs")
            }
            "lsp_bootstrap_stall_fixture.rs" => {
                include_str!("../tests/fixtures/lsp_bootstrap_stall_fixture.rs")
            }
            "lsp_bootstrap_sleep_fixture.rs" => {
                include_str!("../tests/fixtures/lsp_bootstrap_sleep_fixture.rs")
            }
            other => panic!("unknown fixture source {other}"),
        };
        std::fs::write(&source, fixture_source).unwrap();
        let output = Command::new("rustc")
            .env("CARGO_MANIFEST_DIR", env!("CARGO_MANIFEST_DIR"))
            .arg("--edition=2021")
            .arg(&source)
            .arg("-o")
            .arg(&executable)
            .output()
            .expect("rustc should be available to build the LSP fixture");
        assert!(
            output.status.success(),
            "LSP fixture compilation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        (directory, executable)
    }

    fn compile_server_fixture() -> (std::path::PathBuf, std::path::PathBuf) {
        let executable_name = if cfg!(windows) {
            "lsp_server_fixture.exe"
        } else {
            "lsp_server_fixture"
        };
        compile_fixture("lsp_server_fixture.rs", executable_name)
    }

    /// The bootstrap launcher is injectable. The helper binary
    /// includes the real bootstrap protocol via `include!`, unlike the test
    /// harness binary whose libtest `main` rejects `--pude-lsp-bootstrap`.
    #[cfg(windows)]
    fn compile_bootstrap_helper() -> (std::path::PathBuf, std::path::PathBuf) {
        compile_fixture("lsp_bootstrap_fixture.rs", "lsp_bootstrap_helper.exe")
    }

    /// Process teardown (Job Object termination of grandchildren included) is
    /// asynchronous on Windows, so directory removal retries briefly instead
    /// of racing the first attempt.
    fn remove_dir_when_free(directory: &std::path::Path) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if std::fs::remove_dir_all(directory).is_ok() {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timed out removing fixture directory {directory:?}"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn approve_fixture(
        manager: &LspManager,
        workspace: &std::path::Path,
        executable: &std::path::Path,
        args: Vec<String>,
    ) {
        let canonical_executable = std::fs::canonicalize(executable).unwrap();
        manager
            .approve(LspApprovalGrant {
                plugin_id: "pude.reference-lsp".to_string(),
                plugin_version: "1.0.0".to_string(),
                workspace_root: workspace.to_string_lossy().to_string(),
                server: LspServerDeclaration {
                    server_id: "fixture".to_string(),
                    language: "rust".to_string(),
                    executable: executable.to_string_lossy().to_string(),
                    args,
                },
                expected_executable_path: canonical_executable.to_string_lossy().to_string(),
            })
            .unwrap();
    }

    fn start_fixture_request(
        workspace: &std::path::Path,
        executable: &std::path::Path,
        args: Vec<String>,
    ) -> LspServerRequest {
        LspServerRequest {
            plugin_id: "pude.reference-lsp".to_string(),
            plugin_version: "1.0.0".to_string(),
            workspace_root: workspace.to_string_lossy().to_string(),
            server: LspServerDeclaration {
                server_id: "fixture".to_string(),
                language: "rust".to_string(),
                executable: executable.to_string_lossy().to_string(),
                args,
            },
        }
    }

    /// Waits for a terminal `State` event and returns its message. Fails the
    /// test after `timeout` so a regression can never hang the suite.
    fn wait_for_state_message(
        receiver: &mpsc::Receiver<LspEvent>,
        expected: &str,
        timeout: Duration,
    ) -> Option<String> {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if let Ok(LspEvent::State { state, message, .. }) =
                receiver.recv_timeout(Duration::from_millis(100))
            {
                if state == expected {
                    return message;
                }
            }
        }
        panic!("timed out waiting for LSP state {expected}");
    }

    fn fixture_declaration(executable: &std::path::Path, mode: &str) -> LspServerDeclaration {
        LspServerDeclaration {
            server_id: "fixture".to_string(),
            language: "rust".to_string(),
            executable: executable.to_string_lossy().to_string(),
            args: vec![mode.to_string()],
        }
    }

    fn wait_for_state(receiver: &mpsc::Receiver<LspEvent>, expected: &str) {
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            if let Ok(LspEvent::State { state, .. }) =
                receiver.recv_timeout(Duration::from_millis(100))
            {
                if state == expected {
                    return;
                }
            }
        }
        panic!("timed out waiting for LSP state {expected}");
    }

    fn wait_for_message(receiver: &mpsc::Receiver<LspEvent>) -> Value {
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            if let Ok(LspEvent::Message { message, .. }) =
                receiver.recv_timeout(Duration::from_millis(100))
            {
                return message;
            }
        }
        panic!("timed out waiting for LSP response");
    }
}
