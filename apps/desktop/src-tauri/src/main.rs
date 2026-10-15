#![cfg_attr(all(not(debug_assertions), not(test)), windows_subsystem = "windows")]

use notify::{RecursiveMode, Watcher};
use rfd::FileDialog;
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::os::unix::ffi::{OsStrExt, OsStringExt};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt as UnixMetadataExt, OpenOptionsExt};
#[cfg(windows)]
use std::os::windows::fs::{MetadataExt as WindowsMetadataExt, OpenOptionsExt};
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, TrySendError};
use std::sync::{Arc, Condvar, Mutex, OnceLock, Weak};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

mod app_log;
mod app_update;
mod blocking;
mod document_encoding;
mod filesystem;
mod git_diff;
mod git_history;
mod git_repository;
mod git_runtime;
#[cfg(test)]
mod ipc_contracts;
#[cfg(windows)]
mod lsp_bootstrap_protocol;
mod lsp_manager;
#[cfg(target_os = "macos")]
mod macos_quit;
mod platform_trash;
#[cfg(unix)]
mod process_group;
mod plugin_installer;
mod plugin_security;
mod plugin_workspace;
mod python_environment;
mod startup_timeline;
mod terminal;
mod watcher;
mod window_visibility;

use blocking::BlockingClass;
use document_encoding::{decode_text_bytes, preferred_line_ending, serialize_save_content, MAX_FILE_READ_BYTES};
use git_diff::{
    INITIAL_DIFF_CONTEXT_LINES, MAX_DIFF_CONTEXT_LINES, next_context_lines, read_git_commit_diff,
    read_git_diff,
};
use git_history::{GitCommit, GitCommitFile, GitHistoryPage, load_git_commits_page};
use git_repository::{RepositoryRootCache, ResolvedGitRepository};
use git_runtime::{
    GitCommandOutput, GitCommandSpec, GitCoordinator, GitDirtyScope, GitErrorInfo, GitErrorKind,
    GitReadKind, GitReadRequest, RequestHandle,
};

#[cfg(unix)]
const WIRE_PATH_MARKER: &str = "~pude-bytes-v1~";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadFileResult {
    path: String,
    content: String,
    encoding: String,
    line_ending: String,
    line_endings: String,
    bom: bool,
    modified_at: u128,
    size: usize,
    fingerprint: String,
    identity: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitFileStatus {
    path: String,
    index_status: Option<String>,
    worktree_status: Option<String>,
    original_path: Option<String>,
    conflict: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitStatusResult {
    repository_root: String,
    branch: Option<String>,
    repository_state: String,
    head_oid: Option<String>,
    files: Vec<GitFileStatus>,
    commits: Vec<GitCommit>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitBranch {
    name: String,
    current: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitOperationResult {
    output: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitWorktreeResult {
    branch: String,
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiffResult {
    path: String,
    diff: String,
    staged: bool,
    context_lines: usize,
    output_bytes: usize,
    truncated: bool,
    next_context_lines: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileSnapshot {
    modified_at: u128,
    size: usize,
    fingerprint: String,
    identity: FileIdentity,
    #[cfg(unix)]
    mode: u32,
    #[cfg(windows)]
    attributes: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileIdentity {
    volume: u64,
    file: u64,
}

impl FileIdentity {
    fn wire(&self) -> String {
        format!("{:x}:{:x}", self.volume, self.file)
    }
}

#[derive(Default)]
struct GitMetadataRoots {
    git_dir: Option<PathBuf>,
    common_dir: Option<PathBuf>,
}

#[derive(Default)]
struct AppState {
    terminals: Arc<Mutex<HashMap<String, Arc<terminal::TerminalSession>>>>,
    terminal_lifecycle: Arc<terminal::TerminalLifecycle>,
    watchers: Arc<Mutex<HashMap<String, watcher::WatcherSession>>>,
    save_locks: Arc<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>>,
    git_repository_roots: Arc<RepositoryRootCache>,
    git_runtime: GitCoordinator,
}

#[derive(Default)]
pub(crate) struct QuitGateState {
    inner: Arc<Mutex<QuitGate>>,
    operation_drained: Arc<Condvar>,
}

#[derive(Default)]
struct QuitGate {
    transaction: Option<QuitTransaction>,
    permit_exit: bool,
    cleanup_pending: HashSet<String>,
    precleaned_windows: HashSet<String>,
    exit_after_cleanup: bool,
    no_window_exit_pending: bool,
    event_listeners_ready: HashSet<String>,
    in_flight_window_creations: usize,
    exit_waiting_for_window_creation: bool,
    closing_windows: HashSet<String>,
    destroyed_windows: HashSet<String>,
    active_resource_operations: HashMap<String, usize>,
    failed_cleanup_windows: HashSet<String>,
    exit_monitor_running: bool,
}

pub(crate) struct QuitResourceOperation {
    inner: Arc<Mutex<QuitGate>>,
    operation_drained: Arc<Condvar>,
    window_label: String,
}

impl Drop for QuitResourceOperation {
    fn drop(&mut self) {
        let mut gate = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(active) = gate.active_resource_operations.get_mut(&self.window_label) {
            *active = active.saturating_sub(1);
            if *active == 0 {
                gate.active_resource_operations.remove(&self.window_label);
            }
        }
        self.operation_drained.notify_all();
    }
}

struct QuitTransaction {
    request_id: String,
    participants: BTreeSet<String>,
    decisions: HashMap<String, QuitDecision>,
    commit_ready: HashSet<String>,
    destroyed: HashSet<String>,
    phase: QuitPhase,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QuitDecision {
    Save,
    Discard,
    Preserve,
}

impl QuitDecision {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "save" => Ok(Self::Save),
            "discard" => Ok(Self::Discard),
            "preserve" => Ok(Self::Preserve),
            _ => Err("Quit decision must be 'save', 'discard', 'preserve', or 'cancel'.".to_string()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Save => "save",
            Self::Discard => "discard",
            Self::Preserve => "preserve",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QuitPhase {
    AwaitingListeners,
    Preparing,
    Committing,
    Cleaning,
    Closing,
}

enum QuitStart {
    Started {
        request_id: String,
        participants: Vec<String>,
        listeners_ready: bool,
    },
    AlreadyPending,
    WindowCreationInFlight,
    NoWindows,
}

enum QuitReadyProgress {
    Ignored,
    Waiting,
    Prepare {
        request_id: String,
        participants: Vec<String>,
    },
}

enum QuitPrepareProgress {
    Ignored,
    Aborted {
        request_id: String,
        participants: Vec<String>,
    },
    Waiting,
    Commit {
        request_id: String,
        decisions: Vec<(String, QuitDecision)>,
    },
}

enum QuitCommitProgress {
    Ignored,
    Waiting,
    Cleanup {
        request_id: String,
        participants: Vec<String>,
    },
}

impl QuitGateState {
    fn lock(&self) -> std::sync::MutexGuard<'_, QuitGate> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn begin(&self, participants: impl IntoIterator<Item = String>) -> QuitStart {
        let mut gate = self.lock();
        if gate.transaction.is_some() {
            return QuitStart::AlreadyPending;
        }
        if gate.in_flight_window_creations > 0 {
            gate.exit_waiting_for_window_creation = true;
            return QuitStart::WindowCreationInFlight;
        }

        let participants: BTreeSet<String> = participants.into_iter().collect();
        if participants.is_empty() {
            gate.no_window_exit_pending = true;
            return QuitStart::NoWindows;
        }
        gate.no_window_exit_pending = false;

        let request_id = Uuid::new_v4().to_string();
        let participant_list: Vec<String> = participants.iter().cloned().collect();
        let listeners_ready = participants
            .iter()
            .all(|label| gate.event_listeners_ready.contains(label));
        gate.transaction = Some(QuitTransaction {
            request_id: request_id.clone(),
            participants,
            decisions: HashMap::new(),
            commit_ready: HashSet::new(),
            destroyed: HashSet::new(),
            phase: if listeners_ready {
                QuitPhase::Preparing
            } else {
                QuitPhase::AwaitingListeners
            },
        });
        QuitStart::Started {
            request_id,
            participants: participant_list,
            listeners_ready,
        }
    }

    pub(crate) fn admit_resource_operation(
        &self,
        window_label: &str,
    ) -> Result<QuitResourceOperation, String> {
        let mut gate = self.lock();
        let closing_transaction = gate.transaction.as_ref().is_some_and(|transaction| {
            matches!(transaction.phase, QuitPhase::Cleaning | QuitPhase::Closing)
                && transaction.participants.contains(window_label)
        });
        if gate.closing_windows.contains(window_label)
            || gate.destroyed_windows.contains(window_label)
            || closing_transaction
        {
            return Err(
                "The window is closing and cannot start another native operation.".to_string(),
            );
        }
        *gate
            .active_resource_operations
            .entry(window_label.to_string())
            .or_default() += 1;
        Ok(QuitResourceOperation {
            inner: Arc::clone(&self.inner),
            operation_drained: Arc::clone(&self.operation_drained),
            window_label: window_label.to_string(),
        })
    }

    fn close_resource_admission(
        &self,
        request_id: &str,
        participants: &[String],
    ) -> Result<(), String> {
        let mut gate = self.lock();
        let transaction = gate
            .transaction
            .as_ref()
            .ok_or_else(|| "The app quit request is no longer active.".to_string())?;
        if transaction.request_id != request_id
            || transaction.phase != QuitPhase::Cleaning
            || transaction.participants != participants.iter().cloned().collect()
        {
            return Err("The app quit request changed before native cleanup.".to_string());
        }
        gate.closing_windows.extend(participants.iter().cloned());
        Ok(())
    }

    fn wait_for_resource_operations(
        &self,
        window_label: &str,
        timeout: Duration,
    ) -> Result<(), String> {
        let deadline = std::time::Instant::now() + timeout;
        let mut gate = self.lock();
        loop {
            if gate
                .active_resource_operations
                .get(window_label)
                .copied()
                .unwrap_or_default()
                == 0
            {
                return Ok(());
            }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err(format!(
                    "Native operations in window {window_label} did not drain before app quit."
                ));
            }
            let (next, result) = self
                .operation_drained
                .wait_timeout(gate, remaining)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            gate = next;
            if result.timed_out() {
                return Err(format!(
                    "Native operations in window {window_label} did not drain before app quit."
                ));
            }
        }
    }

    fn wait_for_pending_cleanup(&self, timeout: Duration) -> Result<(), String> {
        let deadline = std::time::Instant::now() + timeout;
        let mut gate = self.lock();
        while !gate.cleanup_pending.is_empty() {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err(
                    "A previous window's native cleanup did not finish before app quit."
                        .to_string(),
                );
            }
            let (next, result) = self
                .operation_drained
                .wait_timeout(gate, remaining)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            gate = next;
            if result.timed_out() && !gate.cleanup_pending.is_empty() {
                return Err(
                    "A previous window's native cleanup did not finish before app quit."
                        .to_string(),
                );
            }
        }
        Ok(())
    }

    fn events_ready(&self, window_label: &str) -> QuitReadyProgress {
        let mut gate = self.lock();
        if gate.destroyed_windows.contains(window_label) {
            return QuitReadyProgress::Ignored;
        }
        gate.event_listeners_ready.insert(window_label.to_string());
        let event_listeners_ready = gate.event_listeners_ready.clone();
        let Some(transaction) = gate.transaction.as_mut() else {
            return QuitReadyProgress::Ignored;
        };
        if transaction.phase != QuitPhase::AwaitingListeners
            || !transaction.participants.contains(window_label)
        {
            return QuitReadyProgress::Ignored;
        }
        if !transaction
            .participants
            .iter()
            .all(|label| event_listeners_ready.contains(label))
        {
            return QuitReadyProgress::Waiting;
        }

        transaction.phase = QuitPhase::Preparing;
        QuitReadyProgress::Prepare {
            request_id: transaction.request_id.clone(),
            participants: transaction.participants.iter().cloned().collect(),
        }
    }

    fn prepare_reply(
        &self,
        request_id: &str,
        window_label: &str,
        decision: Option<QuitDecision>,
    ) -> Result<QuitPrepareProgress, String> {
        let mut gate = self.lock();
        let Some(transaction) = gate.transaction.as_mut() else {
            return Ok(QuitPrepareProgress::Ignored);
        };
        if transaction.request_id != request_id || transaction.phase != QuitPhase::Preparing {
            return Ok(QuitPrepareProgress::Ignored);
        }
        if !transaction.participants.contains(window_label) {
            return Err("This window is not part of the pending quit request.".to_string());
        }

        if decision.is_none() {
            let participants = transaction.participants.iter().cloned().collect();
            let request_id = transaction.request_id.clone();
            gate.transaction = None;
            return Ok(QuitPrepareProgress::Aborted {
                request_id,
                participants,
            });
        }

        let decision = decision.expect("checked as present");
        if let Some(existing) = transaction.decisions.get(window_label) {
            if *existing != decision {
                return Err("This window already replied to the pending quit request.".to_string());
            }
            return Ok(QuitPrepareProgress::Waiting);
        }
        transaction
            .decisions
            .insert(window_label.to_string(), decision);
        if transaction.decisions.len() != transaction.participants.len() {
            return Ok(QuitPrepareProgress::Waiting);
        }

        transaction.phase = QuitPhase::Committing;
        let decisions = transaction
            .participants
            .iter()
            .map(|label| {
                (
                    label.clone(),
                    *transaction
                        .decisions
                        .get(label)
                        .expect("all participants have replied"),
                )
            })
            .collect();
        Ok(QuitPrepareProgress::Commit {
            request_id: transaction.request_id.clone(),
            decisions,
        })
    }

    fn commit_ready(
        &self,
        request_id: &str,
        window_label: &str,
    ) -> Result<QuitCommitProgress, String> {
        let mut gate = self.lock();
        let Some(transaction) = gate.transaction.as_mut() else {
            return Ok(QuitCommitProgress::Ignored);
        };
        if transaction.request_id != request_id || transaction.phase != QuitPhase::Committing {
            return Ok(QuitCommitProgress::Ignored);
        }
        if !transaction.participants.contains(window_label) {
            return Err("This window is not part of the pending quit request.".to_string());
        }

        transaction.commit_ready.insert(window_label.to_string());
        if transaction.commit_ready.len() != transaction.participants.len() {
            return Ok(QuitCommitProgress::Waiting);
        }

        transaction.phase = QuitPhase::Cleaning;
        Ok(QuitCommitProgress::Cleanup {
            request_id: transaction.request_id.clone(),
            participants: transaction.participants.iter().cloned().collect(),
        })
    }

    fn finish_cleanup(&self, request_id: &str) -> Result<Vec<String>, String> {
        let mut gate = self.lock();
        let Some(transaction) = gate.transaction.as_ref() else {
            return Err("The app quit request is no longer active.".to_string());
        };
        if transaction.request_id != request_id || transaction.phase != QuitPhase::Cleaning {
            return Err("The app quit request is not ready to close windows.".to_string());
        }
        let participants = transaction.participants.iter().cloned().collect::<Vec<_>>();
        if participants.iter().any(|label| {
            !gate.closing_windows.contains(label)
                || gate
                    .active_resource_operations
                    .get(label)
                    .copied()
                    .unwrap_or_default()
                    > 0
        }) {
            return Err("Native operations are still active; windows remain open.".to_string());
        }
        if !gate.cleanup_pending.is_empty() {
            return Err(
                "Another native cleanup is still running; windows remain open.".to_string(),
            );
        }
        if !gate.failed_cleanup_windows.is_empty() {
            return Err(
                "A previous window cleanup has not completed; windows remain open.".to_string(),
            );
        }
        let transaction = gate
            .transaction
            .as_mut()
            .expect("transaction was verified above");
        transaction.phase = QuitPhase::Closing;
        gate.precleaned_windows.extend(participants.iter().cloned());
        Ok(participants)
    }

    fn window_destroyed(&self, window_label: &str) -> (Option<(String, Vec<String>)>, bool) {
        let mut gate = self.lock();
        let Some(transaction) = gate.transaction.as_mut() else {
            return (None, false);
        };
        if !transaction.participants.contains(window_label) {
            return (None, false);
        }

        if transaction.phase != QuitPhase::Closing {
            let request_id = transaction.request_id.clone();
            let participants = transaction.participants.iter().cloned().collect();
            gate.transaction = None;
            return (Some((request_id, participants)), false);
        }

        transaction.destroyed.insert(window_label.to_string());
        (None, false)
    }

    fn abort_if_current(&self, request_id: &str) -> Option<Vec<String>> {
        let mut gate = self.lock();
        let transaction = gate.transaction.as_ref()?;
        if transaction.request_id != request_id {
            return None;
        }
        let participants: Vec<String> = transaction.participants.iter().cloned().collect();
        gate.transaction = None;
        for participant in &participants {
            gate.precleaned_windows.remove(participant);
            gate.closing_windows.remove(participant);
        }
        Some(participants)
    }

    fn abort_if_committing(&self, request_id: &str) -> Option<Vec<String>> {
        let mut gate = self.lock();
        let transaction = gate.transaction.as_ref()?;
        if transaction.request_id != request_id || transaction.phase != QuitPhase::Committing {
            return None;
        }
        let participants: Vec<String> = transaction.participants.iter().cloned().collect();
        gate.transaction = None;
        for participant in &participants {
            gate.closing_windows.remove(participant);
        }
        Some(participants)
    }

    fn abort_if_phase(&self, request_id: &str, phase: QuitPhase) -> Option<Vec<String>> {
        let mut gate = self.lock();
        let transaction = gate.transaction.as_ref()?;
        if transaction.request_id != request_id || transaction.phase != phase {
            return None;
        }
        let participants: Vec<String> = transaction.participants.iter().cloned().collect();
        gate.transaction = None;
        for participant in &participants {
            gate.closing_windows.remove(participant);
        }
        Some(participants)
    }

    fn remove_window(&self, window_label: &str) {
        let mut gate = self.lock();
        gate.event_listeners_ready.remove(window_label);
        gate.destroyed_windows.insert(window_label.to_string());
    }

    fn take_exit_permit(&self) -> bool {
        let mut gate = self.lock();
        let permitted = std::mem::take(&mut gate.permit_exit);
        if permitted {
            gate.transaction = None;
            gate.closing_windows.clear();
            gate.no_window_exit_pending = false;
        }
        permitted
    }

    fn reserve_window_creation(&self) -> Result<(), String> {
        let mut gate = self.lock();
        if gate.transaction.is_some()
            || gate.exit_after_cleanup
            || gate.no_window_exit_pending
            || gate.exit_waiting_for_window_creation
            || gate.permit_exit
        {
            return Err(
                "Unable to open a new window while the app is preparing to quit.".to_string(),
            );
        }
        gate.in_flight_window_creations += 1;
        Ok(())
    }

    fn finish_window_creation(&self) -> bool {
        let mut gate = self.lock();
        gate.in_flight_window_creations = gate.in_flight_window_creations.saturating_sub(1);
        if gate.in_flight_window_creations == 0 && gate.exit_waiting_for_window_creation {
            gate.exit_waiting_for_window_creation = false;
            return true;
        }
        false
    }

    fn start_window_cleanup(&self, window_label: &str) -> bool {
        let mut gate = self.lock();
        if gate.precleaned_windows.remove(window_label) {
            return false;
        }
        gate.cleanup_pending.insert(window_label.to_string())
    }

    fn cleanup_completed(
        &self,
        window_label: &str,
        no_windows: bool,
    ) -> (bool, Option<(String, Vec<String>)>) {
        let mut gate = self.lock();
        gate.cleanup_pending.remove(window_label);
        gate.precleaned_windows.remove(window_label);
        gate.failed_cleanup_windows.remove(window_label);
        self.operation_drained.notify_all();

        let transaction_ready = gate.transaction.as_ref().is_some_and(|transaction| {
            transaction.phase == QuitPhase::Closing
                && transaction.destroyed.len() == transaction.participants.len()
                && gate.cleanup_pending.is_empty()
                && gate.precleaned_windows.is_empty()
                && gate.failed_cleanup_windows.is_empty()
                && transaction.participants.iter().all(|label| {
                    gate.active_resource_operations
                        .get(label)
                        .copied()
                        .unwrap_or_default()
                        == 0
                })
        });
        if transaction_ready {
            if no_windows {
                gate.permit_exit = true;
                return (true, None);
            }
            let transaction = gate.transaction.take().expect("transaction is ready");
            for participant in &transaction.participants {
                gate.closing_windows.remove(participant);
            }
            return (
                false,
                Some((
                    transaction.request_id,
                    transaction.participants.into_iter().collect(),
                )),
            );
        }

        if gate.exit_after_cleanup
            && no_windows
            && gate.no_window_exit_pending
            && gate.cleanup_pending.is_empty()
            && gate.failed_cleanup_windows.is_empty()
            && gate.active_resource_operations.is_empty()
        {
            gate.exit_after_cleanup = false;
            gate.permit_exit = true;
            return (true, None);
        }
        (false, None)
    }

    fn cleanup_failed(&self, window_label: &str) {
        let mut gate = self.lock();
        gate.cleanup_pending.remove(window_label);
        gate.failed_cleanup_windows.insert(window_label.to_string());
        if gate.exit_after_cleanup {
            gate.exit_after_cleanup = false;
        }
        gate.no_window_exit_pending = false;
        self.operation_drained.notify_all();
    }

    fn cleanup_succeeded(&self, window_label: &str) {
        let mut gate = self.lock();
        gate.cleanup_pending.remove(window_label);
        gate.failed_cleanup_windows.remove(window_label);
    }

    fn failed_cleanup_windows(&self) -> Vec<String> {
        let gate = self.lock();
        gate.failed_cleanup_windows.iter().cloned().collect()
    }

    fn claim_failed_cleanup_retries(&self) -> Vec<String> {
        let mut gate = self.lock();
        let labels = gate
            .failed_cleanup_windows
            .iter()
            .filter(|label| !gate.cleanup_pending.contains(*label))
            .cloned()
            .collect::<Vec<_>>();
        gate.cleanup_pending.extend(labels.iter().cloned());
        labels
    }

    fn try_complete_exit_after_cleanup(&self, no_windows: bool) -> bool {
        let mut gate = self.lock();
        if gate.exit_after_cleanup
            && no_windows
            && gate.no_window_exit_pending
            && gate.cleanup_pending.is_empty()
            && gate.failed_cleanup_windows.is_empty()
            && gate.active_resource_operations.is_empty()
        {
            gate.exit_after_cleanup = false;
            gate.permit_exit = true;
            return true;
        }
        false
    }

    fn exit_after_cleanup_pending(&self) -> bool {
        self.lock().exit_after_cleanup
    }

    fn fail_active_resource_cleanup(&self) -> Vec<String> {
        let mut gate = self.lock();
        gate.exit_after_cleanup = false;
        gate.no_window_exit_pending = false;
        let labels = gate
            .active_resource_operations
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        gate.failed_cleanup_windows.extend(labels.iter().cloned());
        labels
    }

    fn begin_exit_monitor(&self) -> bool {
        let mut gate = self.lock();
        if gate.exit_monitor_running {
            return false;
        }
        gate.exit_monitor_running = true;
        true
    }

    fn end_exit_monitor(&self) {
        self.lock().exit_monitor_running = false;
    }

    fn finish_window_creation_and_start_quit(&self) -> bool {
        self.finish_window_creation()
    }

    fn exit_after_window_cleanup(&self) -> bool {
        let mut gate = self.lock();
        if gate.in_flight_window_creations > 0 {
            gate.exit_waiting_for_window_creation = true;
            return false;
        }
        if !gate.no_window_exit_pending {
            return false;
        }
        if gate.cleanup_pending.is_empty()
            && gate.failed_cleanup_windows.is_empty()
            && gate.active_resource_operations.is_empty()
        {
            gate.permit_exit = true;
            return true;
        }
        gate.exit_after_cleanup = true;
        false
    }

    fn cancel_no_window_exit(&self) {
        let mut gate = self.lock();
        gate.no_window_exit_pending = false;
        gate.exit_after_cleanup = false;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QuitRequestPayload {
    request_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QuitAbortPayload {
    request_id: String,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuitCommitPayload {
    request_id: String,
    decision: &'static str,
}

fn emit_quit_abort(app: &AppHandle, request_id: &str, participants: &[String]) {
    emit_quit_abort_with_error(app, request_id, participants, None);
}

fn emit_quit_abort_with_error(
    app: &AppHandle,
    request_id: &str,
    participants: &[String],
    error: Option<&str>,
) {
    app.state::<app_update::UpdateState>().cancel_install_on_exit();
    let payload = QuitAbortPayload {
        request_id: request_id.to_string(),
        error: error.map(str::to_string),
    };
    for label in participants {
        if let Some(window) = app.get_webview_window(label) {
            if let Err(error) = window.emit("app-quit-abort", &payload) {
                eprintln!("Unable to cancel app quit in window {label}: {error}");
            }
        }
    }
}

fn emit_quit_commit(
    app: &AppHandle,
    request_id: &str,
    decisions: &[(String, QuitDecision)],
) -> Result<(), String> {
    for (label, decision) in decisions {
        let window = app
            .get_webview_window(label)
            .ok_or_else(|| format!("Window {label} closed during app quit."))?;
        window
            .emit(
                "app-quit-commit",
                QuitCommitPayload {
                    request_id: request_id.to_string(),
                    decision: decision.as_str(),
                },
            )
            .map_err(|error| format!("Unable to commit app quit in window {label}: {error}"))?;
    }
    Ok(())
}

fn quit_window_labels(app: &AppHandle) -> BTreeSet<String> {
    app.webview_windows().into_keys().collect()
}

fn quit_participants_match(app: &AppHandle, participants: &[String]) -> bool {
    quit_window_labels(app) == participants.iter().cloned().collect()
}

fn start_quit_phase_timeout(
    app: AppHandle,
    request_id: String,
    phase: QuitPhase,
    timeout: Duration,
    reason: &'static str,
) {
    let _ = thread::Builder::new()
        .name("pude-quit-phase-timeout".to_string())
        .spawn(move || {
            thread::sleep(timeout);
            let participants = app
                .state::<QuitGateState>()
                .abort_if_phase(&request_id, phase);
            if let Some(participants) = participants {
                eprintln!("App quit {reason} timed out; keeping windows open.");
                emit_quit_abort(&app, &request_id, &participants);
            }
        });
}

fn emit_quit_prepare(
    app: &AppHandle,
    quit_gate: &QuitGateState,
    request_id: &str,
    participants: &[String],
) -> Result<(), String> {
    if !quit_participants_match(app, participants) {
        if let Some(participants) = quit_gate.abort_if_current(request_id) {
            emit_quit_abort(app, request_id, &participants);
        }
        return Ok(());
    }

    let payload = QuitRequestPayload {
        request_id: request_id.to_string(),
    };
    for label in participants {
        let window = app
            .get_webview_window(label)
            .ok_or_else(|| format!("Window {label} disappeared during app quit."));
        let emitted = window.and_then(|window| {
            window
                .emit("app-quit-prepare", &payload)
                .map_err(|error| format!("Unable to prepare app quit in window {label}: {error}"))
        });
        if let Err(error) = emitted {
            if let Some(participants) = quit_gate.abort_if_current(request_id) {
                emit_quit_abort(app, request_id, &participants);
            }
            return Err(error);
        }
    }
    start_quit_phase_timeout(
        app.clone(),
        request_id.to_string(),
        QuitPhase::Preparing,
        Duration::from_secs(120),
        "prepare",
    );
    Ok(())
}

fn start_quit_commit_timeout(app: AppHandle, request_id: String) {
    let _ = thread::Builder::new()
        .name("pude-quit-commit-timeout".to_string())
        .spawn(move || {
            thread::sleep(Duration::from_secs(20));
            let participants = app
                .state::<QuitGateState>()
                .abort_if_committing(&request_id);
            if let Some(participants) = participants {
                eprintln!("App quit commit timed out; keeping remaining windows open.");
                emit_quit_abort(&app, &request_id, &participants);
            }
        });
}

fn handle_exit_requested(app: &AppHandle, code: Option<i32>, api: tauri::ExitRequestApi) {
    let quit_gate = app.state::<QuitGateState>();
    if code.is_some() && quit_gate.take_exit_permit() {
        return;
    }

    // A user-initiated exit must wait for every window to prepare. Coalesce
    // repeated Cmd+Q/Dock Quit requests while the same transaction is active.
    api.prevent_exit();
    begin_quit_request(app, &quit_gate);
}

fn begin_quit_request(app: &AppHandle, quit_gate: &QuitGateState) {
    match quit_gate.begin(quit_window_labels(app)) {
        QuitStart::AlreadyPending => {}
        QuitStart::WindowCreationInFlight => {}
        QuitStart::NoWindows => {
            if !quit_window_labels(app).is_empty() {
                quit_gate.cancel_no_window_exit();
                begin_quit_request(app, quit_gate);
                return;
            }
            if quit_gate.exit_after_window_cleanup() {
                app.exit(0);
            } else {
                retry_failed_window_cleanups(app);
                start_no_window_exit_monitor(app.clone());
            }
        }
        QuitStart::Started {
            request_id,
            participants,
            listeners_ready,
        } => {
            if listeners_ready {
                if let Err(error) = emit_quit_prepare(app, &quit_gate, &request_id, &participants) {
                    eprintln!("{error}");
                }
            } else {
                start_quit_phase_timeout(
                    app.clone(),
                    request_id,
                    QuitPhase::AwaitingListeners,
                    Duration::from_secs(15),
                    "event listener readiness",
                );
            }
        }
    }
}

fn retry_failed_window_cleanups(app: &AppHandle) {
    let failed_windows = app.state::<QuitGateState>().claim_failed_cleanup_retries();
    if failed_windows.is_empty() {
        return;
    }
    for label in failed_windows {
        let cleanup_app = app.clone();
        let cleanup_label = label.clone();
        let cleanup = thread::Builder::new()
            .name(format!("pude-exit-cleanup-retry-{cleanup_label}"))
            .spawn(
                move || match cleanup_one_quit_window(&cleanup_app, &cleanup_label) {
                    Ok(()) => {
                        let (should_exit, _) =
                            cleanup_app.state::<QuitGateState>().cleanup_completed(
                                &cleanup_label,
                                cleanup_app.webview_windows().is_empty(),
                            );
                        if should_exit {
                            cleanup_app.exit(0);
                        }
                    }
                    Err(error) => {
                        eprintln!("Unable to retry cleanup for window {cleanup_label}: {error}");
                    }
                },
            );
        if let Err(error) = cleanup {
            eprintln!("Unable to schedule cleanup retry for window {label}: {error}");
            app.state::<QuitGateState>().cleanup_failed(&label);
        }
    }
}

fn start_no_window_exit_monitor(app: AppHandle) {
    let gate = app.state::<QuitGateState>();
    if !gate.begin_exit_monitor() {
        return;
    }
    let monitor_app = app.clone();
    if let Err(error) = thread::Builder::new()
        .name("pude-no-window-exit-monitor".to_string())
        .spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(60);
            loop {
                let no_windows = monitor_app.webview_windows().is_empty();
                let gate = monitor_app.state::<QuitGateState>();
                if gate.try_complete_exit_after_cleanup(no_windows) {
                    gate.end_exit_monitor();
                    monitor_app.exit(0);
                    return;
                }
                if !gate.exit_after_cleanup_pending() || !no_windows {
                    gate.end_exit_monitor();
                    return;
                }
                if std::time::Instant::now() >= deadline {
                    let labels = gate.fail_active_resource_cleanup();
                    if !labels.is_empty() {
                        eprintln!(
                            "Native operations remain active after the bounded app-exit wait: {}",
                            labels.join(", ")
                        );
                    }
                    gate.end_exit_monitor();
                    return;
                }
                thread::sleep(Duration::from_millis(20));
            }
        })
    {
        gate.end_exit_monitor();
        gate.fail_active_resource_cleanup();
        eprintln!("Unable to schedule app exit monitor: {error}");
    }
}

#[tauri::command]
fn app_quit_events_ready(
    window: tauri::WebviewWindow,
    app: AppHandle,
    quit_gate: State<'_, QuitGateState>,
) -> Result<(), String> {
    match quit_gate.events_ready(window.label()) {
        QuitReadyProgress::Ignored | QuitReadyProgress::Waiting => Ok(()),
        QuitReadyProgress::Prepare {
            request_id,
            participants,
        } => emit_quit_prepare(&app, &quit_gate, &request_id, &participants),
    }
}

#[tauri::command]
fn app_quit_prepare_reply(
    window: tauri::WebviewWindow,
    app: AppHandle,
    quit_gate: State<'_, QuitGateState>,
    request_id: String,
    decision: String,
) -> Result<(), String> {
    let parsed_decision = if decision == "cancel" {
        None
    } else {
        Some(QuitDecision::parse(&decision)?)
    };
    match quit_gate.prepare_reply(&request_id, window.label(), parsed_decision)? {
        QuitPrepareProgress::Ignored | QuitPrepareProgress::Waiting => Ok(()),
        QuitPrepareProgress::Aborted {
            request_id,
            participants,
        } => {
            emit_quit_abort(&app, &request_id, &participants);
            Ok(())
        }
        QuitPrepareProgress::Commit {
            request_id,
            decisions,
        } => {
            let participants = decisions
                .iter()
                .map(|(label, _)| label.clone())
                .collect::<Vec<_>>();
            if !quit_participants_match(&app, &participants) {
                if let Some(participants) = quit_gate.abort_if_current(&request_id) {
                    emit_quit_abort(&app, &request_id, &participants);
                }
                return Ok(());
            }
            if let Err(error) = emit_quit_commit(&app, &request_id, &decisions) {
                eprintln!("{error}");
                if let Some(participants) = quit_gate.abort_if_current(&request_id) {
                    emit_quit_abort(&app, &request_id, &participants);
                }
                return Err(error);
            }
            start_quit_commit_timeout(app, request_id);
            Ok(())
        }
    }
}

#[tauri::command]
fn app_quit_commit_ready(
    window: tauri::WebviewWindow,
    app: AppHandle,
    quit_gate: State<'_, QuitGateState>,
    request_id: String,
) -> Result<(), String> {
    match quit_gate.commit_ready(&request_id, window.label())? {
        QuitCommitProgress::Ignored | QuitCommitProgress::Waiting => Ok(()),
        QuitCommitProgress::Cleanup {
            request_id,
            participants,
        } => {
            let cleanup_app = app.clone();
            let cleanup_request_id = request_id.clone();
            thread::Builder::new()
                .name("pude-app-quit-cleanup".to_string())
                .spawn(move || {
                    run_quit_cleanup_and_close(cleanup_app, cleanup_request_id, participants)
                })
                .map(|_| ())
                .map_err(|error| {
                    let message = format!("Unable to schedule app cleanup: {error}");
                    if let Some(participants) =
                        app.state::<QuitGateState>().abort_if_current(&request_id)
                    {
                        emit_quit_abort_with_error(
                            &app,
                            &request_id,
                            &participants,
                            Some(&message),
                        );
                    }
                    message
                })
        }
    }
}

fn run_quit_cleanup_and_close(app: AppHandle, request_id: String, participants: Vec<String>) {
    if let Err(error) = cleanup_quit_participants(&app, &request_id, &participants) {
        eprintln!("Unable to prepare app quit: {error}");
        if let Some(participants) = app.state::<QuitGateState>().abort_if_current(&request_id) {
            emit_quit_abort_with_error(&app, &request_id, &participants, Some(&error));
        }
        return;
    }

    let quit_gate = app.state::<QuitGateState>();
    let closing_participants = match quit_gate.finish_cleanup(&request_id) {
        Ok(participants) => participants,
        Err(error) => {
            if let Some(participants) = quit_gate.abort_if_current(&request_id) {
                emit_quit_abort_with_error(&app, &request_id, &participants, Some(&error));
            }
            return;
        }
    };

    let result = destroy_quit_participants(&app, &closing_participants);
    if let Err(error) = result {
        eprintln!("Unable to close all app windows after quit approval: {error}");
        if let Some(participants) = quit_gate.abort_if_current(&request_id) {
            emit_quit_abort_with_error(&app, &request_id, &participants, Some(&error));
        }
    }
}

fn cleanup_quit_participants(
    app: &AppHandle,
    request_id: &str,
    participants: &[String],
) -> Result<(), String> {
    if !quit_participants_match(app, participants) {
        return Err("The app window set changed before native cleanup.".to_string());
    }
    app.state::<QuitGateState>()
        .close_resource_admission(request_id, participants)?;

    // A window can finish closing while its normal cleanup worker is still
    // draining. Let that one bounded pass finish before retrying failed labels,
    // so app quit never runs two cleanup workers over the same resources.
    app.state::<QuitGateState>()
        .wait_for_pending_cleanup(Duration::from_secs(60))?;

    // A prior normal window close can fail after its WebView is already gone.
    // It is no longer in the live participant set, but its native resources
    // must still be drained before app-wide quit may proceed.
    let mut cleanup_labels = participants.iter().cloned().collect::<BTreeSet<_>>();
    cleanup_labels.extend(
        app.state::<QuitGateState>()
            .failed_cleanup_windows()
            .into_iter(),
    );

    let (sender, receiver) = std::sync::mpsc::channel();
    let mut workers = Vec::with_capacity(cleanup_labels.len());
    let mut errors = Vec::new();
    for label in &cleanup_labels {
        let worker_app = app.clone();
        let worker_label = label.clone();
        let worker_sender = sender.clone();
        let worker = thread::Builder::new()
            .name(format!("pude-quit-window-cleanup-{worker_label}"))
            .spawn(move || {
                let result = cleanup_one_quit_window(&worker_app, &worker_label);
                let _ = worker_sender.send((worker_label, result));
            });
        match worker {
            Ok(worker) => workers.push(worker),
            Err(error) => errors.push(format!(
                "Unable to schedule cleanup for window {label}: {error}"
            )),
        }
    }
    drop(sender);

    for _ in 0..workers.len() {
        match receiver.recv() {
            Ok((label, Ok(()))) => {
                eprintln!("Cleaned native resources for window {label}.");
                app.state::<QuitGateState>().cleanup_succeeded(&label);
            }
            Ok((label, Err(error))) => errors.push(format!("{label}: {error}")),
            Err(error) => errors.push(format!(
                "Native cleanup worker stopped unexpectedly: {error}"
            )),
        }
    }
    for worker in workers {
        if worker.join().is_err() {
            errors.push("A native cleanup worker panicked.".to_string());
        }
    }

    if errors.is_empty() {
        if quit_participants_match(app, participants) {
            Ok(())
        } else {
            Err("The app window set changed during native cleanup.".to_string())
        }
    } else {
        Err(format!("Native cleanup failed:\n{}", errors.join("\n")))
    }
}

fn cleanup_one_quit_window(app: &AppHandle, window_label: &str) -> Result<(), String> {
    let cleanup_result = cleanup_window_resources_with_gate(
        &app.state::<AppState>(),
        &app.state::<lsp_manager::LspState>(),
        &app.state::<QuitGateState>(),
        window_label,
    );
    if cleanup_result.is_err() {
        app.state::<QuitGateState>().cleanup_failed(window_label);
    }
    cleanup_result
}

fn destroy_quit_participants(app: &AppHandle, participants: &[String]) -> Result<(), String> {
    if !quit_participants_match(app, participants) {
        return Err("The app window set changed before windows could close.".to_string());
    }
    let windows = participants
        .iter()
        .map(|label| {
            app.get_webview_window(label)
                .map(|window| (label.clone(), window))
                .ok_or_else(|| format!("Window {label} disappeared before app quit."))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut errors = Vec::new();
    for (label, window) in windows {
        if let Err(error) = window.destroy() {
            errors.push(format!("{label}: {error}"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Unable to close every window:\n{}",
            errors.join("\n")
        ))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GitRepositoryState {
    Normal,
    Detached,
    Unborn,
    Unknown,
}

impl Default for GitRepositoryState {
    fn default() -> Self {
        Self::Unknown
    }
}

impl GitRepositoryState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Detached => "detached",
            Self::Unborn => "unborn",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Default)]
struct ParsedGitStatus {
    branch: Option<String>,
    repository_state: GitRepositoryState,
    head_oid: Option<String>,
    files: Vec<GitFileStatus>,
}

fn wire_path(path: &Path) -> String {
    #[cfg(unix)]
    {
        let bytes = path.as_os_str().as_bytes();
        let mut encoded = String::with_capacity(bytes.len());
        let mut component_start = 0;
        for (index, byte) in bytes.iter().enumerate() {
            if *byte == b'/' {
                encode_wire_component(&mut encoded, &bytes[component_start..index]);
                encoded.push('/');
                component_start = index + 1;
            }
        }
        encode_wire_component(&mut encoded, &bytes[component_start..]);
        return encoded;
    }

    #[cfg(not(unix))]
    {
        path.to_string_lossy().into_owned()
    }
}

fn checked_wire_path(path: &Path) -> Result<String, String> {
    #[cfg(windows)]
    if path.to_str().is_none() {
        return Err(
            "This Windows path contains characters that cannot be represented by the editor. Rename it in File Explorer and try again."
                .to_string(),
        );
    }
    Ok(wire_path(path))
}

fn decode_wire_path(value: &str) -> PathBuf {
    #[cfg(unix)]
    {
        if !value
            .split('/')
            .any(|component| component.starts_with(WIRE_PATH_MARKER))
        {
            return PathBuf::from(value);
        }
        let mut decoded = Vec::with_capacity(value.len());
        for (index, component) in value.split('/').enumerate() {
            if index > 0 {
                decoded.push(b'/');
            }
            decode_wire_component(&mut decoded, component);
        }
        return OsString::from_vec(decoded).into();
    }

    #[cfg(not(unix))]
    {
        PathBuf::from(value)
    }
}

#[cfg(unix)]
fn encode_wire_component(output: &mut String, component: &[u8]) {
    let valid = std::str::from_utf8(component).ok();
    let marker_collision =
        valid.is_some_and(|value| value.starts_with(WIRE_PATH_MARKER) || value.contains('\\'));
    if let Some(value) = valid.filter(|_| !marker_collision) {
        output.push_str(value);
        return;
    }

    output.push_str(WIRE_PATH_MARKER);
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for &byte in component {
        let safe_ascii = byte.is_ascii() && byte != b'%' && byte != b'\\' && !marker_collision;
        if safe_ascii {
            output.push(byte as char);
        } else {
            output.push('%');
            output.push(HEX[(byte >> 4) as usize] as char);
            output.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
}

#[cfg(unix)]
fn decode_wire_component(output: &mut Vec<u8>, component: &str) {
    let Some(encoded) = component.strip_prefix(WIRE_PATH_MARKER) else {
        output.extend_from_slice(component.as_bytes());
        return;
    };
    let bytes = encoded.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                output.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        let character = encoded[index..]
            .chars()
            .next()
            .expect("wire path index should point to a character");
        let mut buffer = [0_u8; 4];
        output.extend_from_slice(character.encode_utf8(&mut buffer).as_bytes());
        index += character.len_utf8();
    }
}

#[cfg(unix)]
fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn path_from_bytes(bytes: &[u8]) -> PathBuf {
    #[cfg(unix)]
    {
        return OsString::from_vec(bytes.to_vec()).into();
    }

    #[cfg(not(unix))]
    {
        PathBuf::from(String::from_utf8_lossy(bytes).into_owned())
    }
}

fn wire_path_bytes(bytes: &[u8]) -> String {
    wire_path(&path_from_bytes(bytes))
}

async fn run_blocking<T, F>(label: &'static str, class: BlockingClass, task: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    blocking::run(label, class, None, task).await
}

async fn run_blocking_resource<T, F>(
    label: &'static str,
    class: BlockingClass,
    resource: impl Into<String>,
    task: F,
) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    blocking::run(label, class, Some(resource.into()), task).await
}

fn git_error_info(kind: GitErrorKind, message: impl Into<String>) -> GitErrorInfo {
    GitErrorInfo {
        kind,
        message: message.into(),
        exit_code: None,
        stream: None,
        limit: None,
    }
}

impl From<String> for GitErrorInfo {
    fn from(message: String) -> Self {
        git_error_info(GitErrorKind::Failed, message)
    }
}

impl From<&str> for GitErrorInfo {
    fn from(message: &str) -> Self {
        git_error_info(GitErrorKind::Failed, message)
    }
}

fn git_scheduler_error(message: String) -> GitErrorInfo {
    git_error_info(GitErrorKind::Internal, message)
}

async fn run_git_blocking<T, F>(
    label: &'static str,
    resource: String,
    task: F,
) -> Result<T, GitErrorInfo>
where
    F: FnOnce() -> Result<T, GitErrorInfo> + Send + 'static,
    T: Send + 'static,
{
    blocking::run(
        label,
        BlockingClass::Git,
        Some(resource),
        move || Ok(task()),
    )
    .await
    .map_err(git_scheduler_error)?
}

#[tauri::command]
async fn open_folder_dialog() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        FileDialog::new().pick_folder().map(|path| wire_path(&path))
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn open_file_dialog() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        FileDialog::new().pick_file().map(|path| wire_path(&path))
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn save_file_dialog(default_name: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        FileDialog::new()
            .set_file_name(&default_name)
            .save_file()
            .map(|path| wire_path(&path))
    })
    .await
    .ok()
    .flatten()
}

fn encode_url_query_value(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push(HEX[(byte >> 4) as usize] as char);
            encoded.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    encoded
}

fn existing_workspace_path(value: &str) -> Result<PathBuf, String> {
    let path = decode_wire_path(value);
    let path = fs::canonicalize(&path)
        .map_err(|error| format!("Unable to open the workspace folder. {error}"))?;
    if !path.is_dir() {
        return Err("The workspace path must be a folder.".to_string());
    }
    Ok(path)
}

fn window_visibility_registry() -> &'static window_visibility::WindowVisibilityRegistry {
    static REGISTRY: OnceLock<window_visibility::WindowVisibilityRegistry> = OnceLock::new();
    REGISTRY.get_or_init(window_visibility::WindowVisibilityRegistry::default)
}

/// Arm a one-shot timer that force-shows the window after ~3 seconds unless
/// the frontend revealed it first. Idempotent per window label.
fn install_show_fallback_timer(app: &AppHandle, label: &str) {
    let guard = window_visibility_registry().get(label);
    if !guard.install_timer() {
        return;
    }
    let app = app.clone();
    let label = label.to_string();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(3));
        if let Some(window) = app.get_webview_window(&label) {
            match guard.reveal(|| window.show()) {
                Ok(true) => {
                    startup_timeline::record_window_shown();
                    app_log::log_info(&format!(
                        "Window {label} was force-shown by the startup fallback timer."
                    ));
                }
                Ok(false) => {}
                Err(error) => {
                    app_log::log_error(&format!("Unable to force-show window {label}: {error}"))
                }
            }
        }
    });
}

fn create_editor_window(app: &AppHandle, workspace: Option<&str>) -> Result<(), String> {
    let quit_gate = app.state::<QuitGateState>();
    quit_gate.reserve_window_creation()?;
    let label = format!("pude-{}", Uuid::new_v4());
    let url = workspace.map_or_else(
        || "index.html?workspace=".to_string(),
        |path| format!("index.html?workspace={}", encode_url_query_value(path)),
    );
    let window_label = label.clone();
    let builder = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App(url.into()))
        .title("pude — pure code editor")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .resizable(true)
        .decorations(cfg!(target_os = "macos"))
        .shadow(true)
        .visible(false)
        .background_color(tauri::window::Color(0x10, 0x12, 0x14, 0xff));
    // macOS keeps its native rounded window and traffic lights; the web header extends under the title bar.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 27.0));
    let result = builder
        .build()
        .map(|window| {
            install_show_fallback_timer(window.app_handle(), &window_label);
        })
        .map_err(|error| format!("Unable to open a new window. {error}"));
    if quit_gate.finish_window_creation_and_start_quit() {
        begin_quit_request(app, &quit_gate);
    }
    result
}

#[tauri::command(async)]
fn open_new_window(app: AppHandle, workspace: Option<String>) -> Result<(), String> {
    let workspace = workspace
        .as_deref()
        .map(existing_workspace_path)
        .transpose()?
        .map(|path| checked_wire_path(&path))
        .transpose()?;
    create_editor_window(&app, workspace.as_deref())
}

#[tauri::command]
async fn get_git_ignored_paths<R: tauri::Runtime>(
    workspace: String,
    paths: Vec<String>,
    window: tauri::WebviewWindow<R>,
    state: State<'_, AppState>,
    quit_gate: State<'_, QuitGateState>,
) -> Result<Vec<String>, GitErrorInfo> {
    let admission = quit_gate
        .admit_resource_operation(window.label())
        .map_err(|error| git_error_info(GitErrorKind::Cancelled, error))?;
    if paths.len() > 256
        || paths.iter().map(String::len).sum::<usize>() > git_runtime::MAX_STDIN_BYTES / 2
    {
        return Err(git_error_info(
            GitErrorKind::Capacity,
            "Too many paths for an ignore query.",
        ));
    }
    let roots = Arc::clone(&state.git_repository_roots);
    let runtime = state.git_runtime.clone();
    let request = runtime.begin_request(decode_wire_path(&workspace), Some(window.label()));
    let resource = git_resource_key_async(workspace.clone(), roots.clone()).await;
    run_git_blocking("Unable to check Git ignored paths", resource, move || {
        let _admission = admission;
        let repository = match cached_git_repository_root(&workspace, &roots, &runtime, &request) {
            Ok(root) => root,
            Err(error) if error.kind == GitErrorKind::NotRepository => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        git_ignored_paths_sync(&repository, &paths, &runtime, &request)
    })
    .await
}

fn git_ignored_paths_sync(
    repository: &Path,
    paths: &[String],
    runtime: &GitCoordinator,
    request: &RequestHandle,
) -> Result<Vec<String>, GitErrorInfo> {
    let mut input = Vec::new();
    for path in paths {
        let decoded = decode_wire_path(path);
        if !decoded.is_absolute()
            || !decoded.starts_with(repository)
            || decoded
                .components()
                .any(|part| part == std::path::Component::ParentDir)
        {
            continue;
        }
        #[cfg(unix)]
        let bytes = decoded.as_os_str().as_bytes().to_vec();
        #[cfg(not(unix))]
        let bytes = decoded.to_string_lossy().as_bytes().to_vec();
        if bytes.contains(&0) {
            continue;
        }
        input.extend_from_slice(&bytes);
        input.push(0);
    }
    if input.is_empty() {
        return Ok(Vec::new());
    }
    if input.len() > git_runtime::MAX_STDIN_BYTES {
        return Err(git_error_info(
            GitErrorKind::Capacity,
            "Ignore query exceeds the input limit.",
        ));
    }
    ensure_request_active(request)?;
    let mut spec = GitCommandSpec::read(
        repository.to_path_buf(),
        vec!["check-ignore".into(), "--stdin".into(), "-z".into()],
    );
    spec.stdin = Some(input.into());
    let output = runtime
        .read_shared_for(
            GitReadRequest::new(repository, GitReadKind::Status, spec),
            request,
        )
        .map_err(|error| error.info())?;
    if output.exit_code == Some(1) {
        return Ok(Vec::new());
    }
    let output = output.into_success().map_err(|error| error.info())?;
    output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| {
            #[cfg(unix)]
            let path = PathBuf::from(OsString::from_vec(path.to_vec()));
            #[cfg(not(unix))]
            let path = PathBuf::from(String::from_utf8_lossy(path).into_owned());
            checked_wire_path(&path).map_err(|error| git_error_info(GitErrorKind::Failed, error))
        })
        .collect()
}

#[tauri::command]
async fn git_status(
    workspace: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    quit_gate: State<'_, QuitGateState>,
) -> Result<GitStatusResult, GitErrorInfo> {
    let _admission = quit_gate
        .admit_resource_operation(window.label())
        .map_err(|error| git_error_info(GitErrorKind::Cancelled, error))?;
    let repository_roots = Arc::clone(&state.git_repository_roots);
    let runtime = state.git_runtime.clone();
    let window_id = window.label().to_string();
    let request = runtime.begin_request(decode_wire_path(&workspace), Some(&window_id));
    let resource = git_resource_key_async(workspace.clone(), repository_roots.clone()).await;
    let admission = _admission;
    run_git_blocking("Unable to read Git status", resource, move || {
        let _admission = admission;
        git_status_sync(workspace, repository_roots, runtime, request)
    })
    .await
}

fn git_status_sync(
    workspace: String,
    repository_roots: Arc<RepositoryRootCache>,
    runtime: GitCoordinator,
    request: RequestHandle,
) -> Result<GitStatusResult, GitErrorInfo> {
    let repository_root =
        cached_git_repository_root(&workspace, &repository_roots, &runtime, &request)?;
    let output = git_read_shared(
        &runtime,
        &repository_root,
        GitReadKind::Status,
        [
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
            "-z",
        ]
        .into_iter()
        .map(OsString::from)
        .collect(),
        &request,
    )?;
    let parsed = parse_git_status(&output.stdout);
    Ok(GitStatusResult {
        repository_root: wire_path(&repository_root),
        branch: parsed.branch,
        repository_state: parsed.repository_state.as_str().to_string(),
        head_oid: parsed.head_oid,
        files: parsed.files,
        commits: Vec::new(),
        error: None,
    })
}

fn cached_git_repository(
    workspace: &str,
    repository_roots: &RepositoryRootCache,
    runtime: &GitCoordinator,
    request: &RequestHandle,
) -> Result<ResolvedGitRepository, GitErrorInfo> {
    repository_roots.resolve(decode_wire_path(workspace), runtime, request)
}

fn cached_git_repository_root(
    workspace: &str,
    repository_roots: &RepositoryRootCache,
    runtime: &GitCoordinator,
    request: &RequestHandle,
) -> Result<PathBuf, GitErrorInfo> {
    Ok(cached_git_repository(workspace, repository_roots, runtime, request)?.root)
}

fn require_same_git_repository(
    workspace: &str,
    repository_roots: &RepositoryRootCache,
    runtime: &GitCoordinator,
    request: &RequestHandle,
    expected: &ResolvedGitRepository,
) -> Result<PathBuf, GitErrorInfo> {
    let current = cached_git_repository(workspace, repository_roots, runtime, request)?;
    if !expected.identity.same_repository(&current.identity) {
        return Err(git_error_info(
            GitErrorKind::Cancelled,
            "The Git repository changed before the operation could write. Retry it in the current repository.",
        ));
    }
    Ok(current.root)
}

#[tauri::command]
async fn git_branches(
    workspace: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    quit_gate: State<'_, QuitGateState>,
) -> Result<Vec<GitBranch>, GitErrorInfo> {
    let _admission = quit_gate
        .admit_resource_operation(window.label())
        .map_err(|error| git_error_info(GitErrorKind::Cancelled, error))?;
    let repository_roots = Arc::clone(&state.git_repository_roots);
    let runtime = state.git_runtime.clone();
    let window_id = window.label().to_string();
    let request = runtime.begin_request(decode_wire_path(&workspace), Some(&window_id));
    let resource = git_resource_key_async(workspace.clone(), repository_roots.clone()).await;
    let admission = _admission;
    run_git_blocking("Unable to read Git branches", resource, move || {
        let _admission = admission;
        git_branches_sync(workspace, repository_roots, runtime, request)
    })
    .await
}

fn git_branches_sync(
    workspace: String,
    repository_roots: Arc<RepositoryRootCache>,
    runtime: GitCoordinator,
    request: RequestHandle,
) -> Result<Vec<GitBranch>, GitErrorInfo> {
    let repository_root =
        cached_git_repository_root(&workspace, &repository_roots, &runtime, &request)?;
    let output = git_read_shared(
        &runtime,
        &repository_root,
        GitReadKind::Refs,
        vec![
            OsString::from("branch"),
            OsString::from("--format=%(HEAD)%00%(refname:short)"),
        ],
        &request,
    )?;
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let (head, name) = line.split_once('\0')?;
            let name = name.trim();
            if name.is_empty() {
                return None;
            }
            Some(GitBranch {
                name: name.to_string(),
                current: head.trim() == "*",
            })
        })
        .collect())
}

#[tauri::command]
async fn git_commits(
    workspace: String,
    cursor: Option<String>,
    page_size: Option<usize>,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    quit_gate: State<'_, QuitGateState>,
) -> Result<GitHistoryPage, GitErrorInfo> {
    let _admission = quit_gate
        .admit_resource_operation(window.label())
        .map_err(|error| git_error_info(GitErrorKind::Cancelled, error))?;
    let repository_roots = Arc::clone(&state.git_repository_roots);
    let runtime = state.git_runtime.clone();
    let window_id = window.label().to_string();
    let request = runtime.begin_request(decode_wire_path(&workspace), Some(&window_id));
    let resource = git_resource_key_async(workspace.clone(), repository_roots.clone()).await;
    let admission = _admission;
    run_git_blocking("Unable to read Git history", resource, move || {
        let _admission = admission;
        let repository = cached_git_repository(&workspace, &repository_roots, &runtime, &request)?;
        load_git_commits_page(
            &repository.root,
            &repository.identity,
            &runtime,
            &request,
            cursor.as_deref(),
            page_size.unwrap_or(60),
        )
    })
    .await
}

#[tauri::command]
async fn cancel_workspace(
    workspace: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .git_runtime
        .cancel_workspace(window.label(), decode_wire_path(&workspace));
    Ok(())
}

#[tauri::command]
async fn git_operation<R: tauri::Runtime>(
    workspace: String,
    action: String,
    value: Option<String>,
    original_path: Option<String>,
    message: Option<String>,
    start_point: Option<String>,
    window: tauri::WebviewWindow<R>,
    state: State<'_, AppState>,
    quit_gate: State<'_, QuitGateState>,
) -> Result<GitOperationResult, GitErrorInfo> {
    if workspace.trim().is_empty() {
        return Err(git_error_info(
            GitErrorKind::Failed,
            "Open a folder before running Git operations.",
        ));
    }

    let _admission = quit_gate
        .admit_resource_operation(window.label())
        .map_err(|error| git_error_info(GitErrorKind::Cancelled, error))?;
    let value = value.unwrap_or_default();
    let original_path = original_path.unwrap_or_default();
    let message = message.unwrap_or_default().trim().to_string();
    let start_point = start_point.unwrap_or_default().trim().to_string();
    let file_action = matches!(
        action.as_str(),
        "stage-file" | "unstage-file" | "discard-file" | "discard-untracked-file"
    );
    let valid_file_path = |path: &str| {
        !path.is_empty()
            && Path::new(path)
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_)))
    };
    if file_action
        && (!valid_file_path(&value)
            || (!original_path.is_empty() && !valid_file_path(&original_path)))
    {
        return Err(git_error_info(
            GitErrorKind::Failed,
            "Choose a file inside the repository.",
        ));
    }
    let pathspec = format!(":(literal){value}");
    let mut rename_pathspecs = vec![pathspec.clone()];
    if !original_path.is_empty() {
        rename_pathspecs.push(format!(":(literal){original_path}"));
    }
    let value = value.trim().to_string();
    let args: Vec<String> = match action.as_str() {
        "add" => vec!["add".to_string(), "--all".to_string()],
        "stage-file" => [
            vec!["add".to_string(), "--".to_string()],
            rename_pathspecs.clone(),
        ]
        .concat(),
        "unstage-file" => [
            vec![
                "restore".to_string(),
                "--staged".to_string(),
                "--".to_string(),
            ],
            rename_pathspecs.clone(),
        ]
        .concat(),
        "unstage-all" => vec![
            "restore".to_string(),
            "--staged".to_string(),
            "--".to_string(),
            ".".to_string(),
        ],
        "discard-file" => vec![
            "restore".to_string(),
            "--worktree".to_string(),
            "--".to_string(),
            pathspec.clone(),
        ],
        "discard-untracked-file" => vec![
            "clean".to_string(),
            "-f".to_string(),
            "--".to_string(),
            pathspec.clone(),
        ],
        "commit" | "commit-all" => {
            if message.is_empty() {
                return Err(git_error_info(
                    GitErrorKind::Failed,
                    "Commit message cannot be empty.",
                ));
            }
            vec!["commit".to_string(), "-m".to_string(), message]
        }
        "push" => vec!["push".to_string()],
        "pull" => vec!["pull".to_string()],
        "stash" => vec![
            "stash".to_string(),
            "push".to_string(),
            "--include-untracked".to_string(),
            "-m".to_string(),
            "pude stash".to_string(),
        ],
        "stash-pop" => vec!["stash".to_string(), "pop".to_string()],
        "switch" => {
            require_git_value(&value, "branch")?;
            vec!["switch".to_string(), value]
        }
        "create-branch" => {
            require_git_value(&value, "branch")?;
            let mut args = vec!["switch".to_string(), "-c".to_string(), value];
            if !start_point.is_empty() {
                args.push(start_point);
            }
            args
        }
        "delete-branch" => {
            require_git_value(&value, "branch")?;
            vec!["branch".to_string(), "-d".to_string(), value]
        }
        _ => {
            return Err(git_error_info(
                GitErrorKind::Failed,
                format!("Unsupported Git operation: {action}"),
            ))
        }
    };

    let repository_roots = Arc::clone(&state.git_repository_roots);
    let runtime = state.git_runtime.clone();
    let window_id = window.label().to_string();
    let request = runtime.begin_request(decode_wire_path(&workspace), Some(&window_id));
    let resource = git_resource_key_async(workspace.clone(), repository_roots.clone()).await;
    let admission = _admission;
    run_git_blocking("Unable to run Git operation", resource, move || {
        let _admission = admission;
        let repository =
            cached_git_repository(&workspace, &repository_roots, &runtime, &request)?;
        let repository_root = repository.root.clone();
        let mut args = args;
        if action == "commit-all" {
            require_same_git_repository(
                &workspace,
                &repository_roots,
                &runtime,
                &request,
                &repository,
            )?;
            let staged = git_execute(
                &runtime,
                &repository_root,
                vec![OsString::from("add"), OsString::from("--all")],
                &request,
            );
            runtime.invalidate(&repository_root, GitDirtyScope::ALL);
            staged?;
        }
        if action == "unstage-file" || action == "unstage-all" {
            let has_head = git_execute(
                &runtime,
                &repository_root,
                vec![
                    OsString::from("rev-parse"),
                    OsString::from("--verify"),
                    OsString::from("HEAD"),
                ],
                &request,
            )
            .is_ok();
            if !has_head {
                args = if action == "unstage-file" {
                    [
                        vec!["rm".to_string(), "--cached".to_string(), "--".to_string()],
                        rename_pathspecs,
                    ]
                    .concat()
                } else {
                    vec![
                        "rm".to_string(),
                        "--cached".to_string(),
                        "-r".to_string(),
                        "--".to_string(),
                        ".".to_string(),
                    ]
                };
            }
        }
        let arguments = args.into_iter().map(OsString::from).collect();
        let write_root = require_same_git_repository(
            &workspace,
            &repository_roots,
            &runtime,
            &request,
            &repository,
        )?;
        let output = git_execute(&runtime, &write_root, arguments, &request);
        runtime.invalidate(&repository_root, GitDirtyScope::ALL);
        let output = output?;
        Ok(GitOperationResult {
            output: git_success_message_runtime(&output),
        })
    })
    .await
}

fn git_worktree_destination(
    repository_root: &Path,
    requested_path: &str,
) -> Result<PathBuf, GitErrorInfo> {
    let requested = decode_wire_path(requested_path);
    if requested.as_os_str().is_empty() {
        return Err(git_error_info(
            GitErrorKind::Failed,
            "Choose a folder path for the new worktree.",
        ));
    }
    let target = if requested.is_absolute() {
        requested
    } else {
        repository_root.join(requested)
    };
    let name = target.file_name().ok_or_else(|| {
        git_error_info(
            GitErrorKind::Failed,
            "The worktree path must name a new folder.",
        )
    })?;
    let parent = target.parent().ok_or_else(|| {
        git_error_info(
            GitErrorKind::Failed,
            "The worktree path must be inside an existing parent folder.",
        )
    })?;
    let parent = fs::canonicalize(parent).map_err(|error| {
        git_error_info(
            GitErrorKind::Failed,
            format!("The worktree parent folder must exist and be accessible. {error}"),
        )
    })?;
    let parent = git_cli_path(parent);
    if !parent.is_dir() {
        return Err(git_error_info(
            GitErrorKind::Failed,
            "The worktree parent path must be a folder.",
        ));
    }
    let destination = parent.join(name);
    match fs::symlink_metadata(&destination) {
        Ok(_) => {
            return Err(git_error_info(
                GitErrorKind::Failed,
                "The worktree folder already exists. Choose a new folder path.",
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(git_error_info(
                GitErrorKind::Failed,
                format!("Unable to inspect the worktree path. {error}"),
            ));
        }
    }
    checked_wire_path(&destination).map_err(GitErrorInfo::from)?;
    Ok(destination)
}

#[cfg(windows)]
fn git_cli_path(path: PathBuf) -> PathBuf {
    let Some(value) = path.to_str() else {
        return path;
    };
    if let Some(network_path) = value.strip_prefix("\\\\?\\UNC\\") {
        return PathBuf::from(format!("\\\\{network_path}"));
    }
    value
        .strip_prefix("\\\\?\\")
        .map(PathBuf::from)
        .unwrap_or(path)
}

#[cfg(not(windows))]
fn git_cli_path(path: PathBuf) -> PathBuf {
    path
}

fn validate_worktree_branch(
    branch: &str,
    repository_root: &Path,
    runtime: &GitCoordinator,
    request: &RequestHandle,
) -> Result<(), GitErrorInfo> {
    if branch.trim().is_empty() {
        return Err(git_error_info(
            GitErrorKind::Failed,
            "Choose a branch name for the new worktree.",
        ));
    }
    let output = git_read_shared_raw(
        runtime,
        repository_root,
        GitReadKind::Refs,
        vec![
            OsString::from("check-ref-format"),
            OsString::from(format!("refs/heads/{branch}")),
        ],
        request,
    )?;
    if output.success {
        Ok(())
    } else {
        Err(git_error_info(
            GitErrorKind::Failed,
            "That is not a valid Git branch name.",
        ))
    }
}

fn resolve_worktree_start_point(
    start_point: &str,
    repository_root: &Path,
    runtime: &GitCoordinator,
    request: &RequestHandle,
) -> Result<Option<OsString>, GitErrorInfo> {
    let start_point = start_point.trim();
    if start_point.is_empty() {
        return Ok(None);
    }
    let revision = format!("{start_point}^{{commit}}");
    let output = git_read_shared_raw(
        runtime,
        repository_root,
        GitReadKind::Refs,
        vec![
            OsString::from("rev-parse"),
            OsString::from("--verify"),
            OsString::from("--end-of-options"),
            OsString::from(revision),
        ],
        request,
    )?;
    if !output.success {
        return Err(git_error_info(
            GitErrorKind::Failed,
            format!(
                "The worktree start point must name an existing commit. {}",
                git_runtime_output_error(&output).message
            ),
        ));
    }
    let object_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if object_id.is_empty() || !object_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(git_error_info(
            GitErrorKind::Internal,
            "Git returned an invalid commit ID for the worktree start point.",
        ));
    }
    Ok(Some(OsString::from(object_id)))
}

#[tauri::command]
async fn create_git_worktree(
    workspace: String,
    branch_name: String,
    path: String,
    start_point: Option<String>,
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    quit_gate: State<'_, QuitGateState>,
) -> Result<GitWorktreeResult, GitErrorInfo> {
    if workspace.trim().is_empty() {
        return Err(git_error_info(
            GitErrorKind::Failed,
            "Open a Git repository before creating a worktree.",
        ));
    }
    let _admission = quit_gate
        .admit_resource_operation(window.label())
        .map_err(|error| git_error_info(GitErrorKind::Cancelled, error))?;
    let branch_name = branch_name.trim().to_string();
    let result_branch = branch_name.clone();
    let start_point = start_point.unwrap_or_default().trim().to_string();
    let repository_roots = Arc::clone(&state.git_repository_roots);
    let runtime = state.git_runtime.clone();
    let window_id = window.label().to_string();
    let request = runtime.begin_request(decode_wire_path(&workspace), Some(&window_id));
    let resource = git_resource_key_async(workspace.clone(), repository_roots.clone()).await;
    let admission = _admission;
    let destination = run_git_blocking("Unable to create Git worktree", resource, move || {
        let _admission = admission;
        let repository =
            cached_git_repository(&workspace, &repository_roots, &runtime, &request)?;
        let repository_root = repository.root.clone();
        validate_worktree_branch(&branch_name, &repository_root, &runtime, &request)?;
        let start_point =
            resolve_worktree_start_point(&start_point, &repository_root, &runtime, &request)?;
        let destination = git_worktree_destination(&repository_root, &path)?;
        let mut arguments = vec![
            OsString::from("worktree"),
            OsString::from("add"),
            OsString::from("-b"),
            OsString::from(branch_name),
            destination.as_os_str().to_os_string(),
        ];
        if let Some(start_point) = start_point {
            arguments.push(start_point);
        }
        let write_root = require_same_git_repository(
            &workspace,
            &repository_roots,
            &runtime,
            &request,
            &repository,
        )?;
        let output = git_execute(&runtime, &write_root, arguments, &request);
        runtime.invalidate(&repository_root, GitDirtyScope::ALL);
        output?;
        Ok(destination)
    })
    .await?;

    let workspace_path = checked_wire_path(&destination)
        .map_err(|error| git_error_info(GitErrorKind::Internal, error))?;
    create_editor_window(&app, Some(&workspace_path)).map_err(|error| {
        git_error_info(
            GitErrorKind::Internal,
            format!(
                "The worktree was created at {workspace_path}, but its window could not be opened. {error}"
            ),
        )
    })?;
    Ok(GitWorktreeResult {
        branch: result_branch,
        path: workspace_path,
    })
}

#[cfg(test)]
mod git_worktree_start_point_tests {
    use super::*;

    struct TempRepo {
        base: PathBuf,
        repository: PathBuf,
    }

    impl TempRepo {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!("pude-worktree-start-{}", Uuid::new_v4()));
            let path = base.join("repository");
            fs::create_dir_all(&path).expect("temporary repository directory should be created");
            let repository = Self {
                base,
                repository: path,
            };
            repository.git(&["init", "--quiet", "--initial-branch=main"]);
            repository.git(&["config", "user.name", "Pude Test"]);
            repository.git(&["config", "user.email", "pude-test@example.invalid"]);
            fs::write(
                repository.path().join("tracked.txt"),
                "worktree start point test\n",
            )
            .expect("tracked test file should be written");
            repository.git(&["add", "tracked.txt"]);
            repository.git(&["commit", "--quiet", "-m", "initial commit"]);
            repository
        }

        fn path(&self) -> &Path {
            &self.repository
        }

        fn git(&self, args: &[&str]) -> String {
            self.git_at(self.path(), args)
        }

        fn git_at(&self, directory: &Path, args: &[&str]) -> String {
            let output = Command::new("git")
                .current_dir(directory)
                .args(args)
                .output()
                .expect("Git should start");
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }

        fn resolve_start_point(&self, start_point: &str) -> Result<Option<OsString>, GitErrorInfo> {
            let runtime = GitCoordinator::new();
            let request = runtime.begin_request(self.path(), None);
            resolve_worktree_start_point(start_point, self.path(), &runtime, &request)
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn git_ignored_paths_follow_rules_tracking_and_cache_invalidation() {
        let repository = TempRepo::new();
        fs::create_dir(repository.path().join("src")).unwrap();
        fs::create_dir(repository.path().join("node_modules")).unwrap();
        fs::write(
            repository.path().join(".gitignore"),
            "*.log\n!keep.log\ntracked.txt\nnode_modules/\n",
        )
        .unwrap();
        fs::write(repository.path().join("src/.gitignore"), "nested.txt\n").unwrap();
        fs::write(repository.path().join(".git/info/exclude"), "private.txt\n").unwrap();
        let names = [
            "tracked.txt",
            "cache.log",
            "keep.log",
            "繁體 中文.log",
            "src/nested.txt",
            "node_modules",
            "private.txt",
            "untracked.txt",
        ];
        let mut paths: Vec<String> = names
            .iter()
            .map(|name| {
                let path = repository.path().join(name);
                if !path.is_dir() {
                    fs::write(&path, "fixture").unwrap();
                }
                wire_path(&path)
            })
            .collect();
        #[cfg(unix)]
        for name in [OsString::from("line\nbreak.log")] {
            let path = repository.path().join(name);
            fs::write(&path, "fixture").unwrap();
            paths.push(wire_path(&path));
        }
        let global_excludes = repository.base.join("global-ignore");
        fs::write(&global_excludes, "global.txt\n").unwrap();
        repository.git(&[
            "config",
            "core.excludesFile",
            global_excludes.to_str().unwrap(),
        ]);
        let global_path = repository.path().join("global.txt");
        fs::write(&global_path, "fixture").unwrap();
        paths.push(wire_path(&global_path));
        let runtime = GitCoordinator::new();
        let request = runtime.begin_request(repository.path(), None);
        let ignored =
            git_ignored_paths_sync(repository.path(), &paths, &runtime, &request).unwrap();
        for index in [1, 3, 4, 5, 6] {
            assert!(ignored.contains(&paths[index]), "missing {}", paths[index]);
        }
        for index in [0, 2, 7] {
            assert!(
                !ignored.contains(&paths[index]),
                "unexpected {}",
                paths[index]
            );
        }
        for path in &paths[8..] {
            assert!(ignored.contains(path), "missing {path}");
        }
        // Different stdin must not reuse the preceding query's cached result.
        assert!(
            git_ignored_paths_sync(repository.path(), &paths[7..8], &runtime, &request)
                .unwrap()
                .is_empty()
        );
        fs::write(repository.path().join(".gitignore"), "").unwrap();
        runtime.invalidate(repository.path(), GitDirtyScope::WORKTREE);
        assert!(
            !git_ignored_paths_sync(repository.path(), &paths, &runtime, &request)
                .unwrap()
                .contains(&paths[1])
        );
        assert!(git_ignored_paths_sync(
            repository.path(),
            &[wire_path(&repository.base.join("outside.log"))],
            &runtime,
            &request
        )
        .unwrap()
        .is_empty());
    }

    #[test]
    fn start_point_resolves_only_commits_and_treats_option_like_names_as_revisions() {
        let repository = TempRepo::new();
        let head_oid = repository.git(&["rev-parse", "HEAD"]);
        repository.git(&["update-ref", "refs/heads/--help", "HEAD"]);

        assert_eq!(
            repository
                .resolve_start_point("HEAD")
                .expect("HEAD should resolve")
                .expect("HEAD should resolve to an object ID"),
            OsString::from(&head_oid)
        );
        assert_eq!(
            repository
                .resolve_start_point("--help")
                .expect("an option-like branch name should be treated as a revision")
                .expect("the option-like branch should resolve to an object ID"),
            OsString::from(&head_oid)
        );
        assert!(repository
            .resolve_start_point("HEAD:tracked.txt")
            .expect_err("a blob must not be accepted as a worktree start point")
            .message
            .contains("existing commit"));
        assert!(repository
            .resolve_start_point("missing-start-point")
            .is_err());
        assert!(repository
            .resolve_start_point(" ")
            .expect("an empty start point should use the current HEAD")
            .is_none());
    }

    #[test]
    fn worktree_add_creates_the_requested_branch_and_rejects_existing_destination() {
        let repository = TempRepo::new();
        let runtime = GitCoordinator::new();
        let request = runtime.begin_request(repository.path(), None);
        let branch = "feature/integration-worktree";
        let requested_path = wire_path(&repository.base.join("worktree"));

        validate_worktree_branch(branch, repository.path(), &runtime, &request)
            .expect("valid branch name should pass validation");
        assert_eq!(
            validate_worktree_branch("invalid branch", repository.path(), &runtime, &request)
                .expect_err("invalid branch names should be rejected")
                .kind,
            GitErrorKind::Failed
        );
        let destination = git_worktree_destination(repository.path(), &requested_path)
            .expect("new destination should pass path validation");
        let initial_head = repository.git(&["rev-parse", "HEAD"]);
        let output = git_execute(
            &runtime,
            repository.path(),
            vec![
                OsString::from("worktree"),
                OsString::from("add"),
                OsString::from("-b"),
                OsString::from(branch),
                destination.as_os_str().to_os_string(),
            ],
            &request,
        )
        .expect("git worktree add should succeed");
        assert!(output.success);
        assert!(destination.is_dir(), "worktree directory should be created");
        assert_eq!(
            repository.git_at(&destination, &["branch", "--show-current"]),
            branch
        );
        assert_eq!(
            repository.git_at(&destination, &["rev-parse", "HEAD"]),
            initial_head,
            "new worktree should start at the repository's current HEAD"
        );
        assert_eq!(
            git_worktree_destination(repository.path(), &requested_path)
                .expect_err("an existing worktree destination should be rejected")
                .kind,
            GitErrorKind::Failed
        );
    }
}

#[tauri::command]
async fn git_diff(
    workspace: String,
    path: String,
    staged: bool,
    untracked_hint: Option<bool>,
    context_lines: Option<usize>,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    quit_gate: State<'_, QuitGateState>,
) -> Result<DiffResult, GitErrorInfo> {
    let _admission = quit_gate
        .admit_resource_operation(window.label())
        .map_err(|error| git_error_info(GitErrorKind::Cancelled, error))?;
    let repository_roots = Arc::clone(&state.git_repository_roots);
    let runtime = state.git_runtime.clone();
    let window_id = window.label().to_string();
    let request = runtime.begin_request(decode_wire_path(&workspace), Some(&window_id));
    let resource = git_resource_key_async(workspace.clone(), repository_roots.clone()).await;
    let admission = _admission;
    run_git_blocking("Unable to read Git diff", resource, move || {
        let _admission = admission;
        git_diff_sync_with_hint(
            workspace,
            path,
            staged,
            untracked_hint,
            context_lines.unwrap_or(INITIAL_DIFF_CONTEXT_LINES),
            repository_roots,
            runtime,
            request,
        )
    })
    .await
}

fn git_diff_sync_with_hint(
    workspace: String,
    path: String,
    staged: bool,
    untracked_hint: Option<bool>,
    context_lines: usize,
    repository_roots: Arc<RepositoryRootCache>,
    runtime: GitCoordinator,
    request: RequestHandle,
) -> Result<DiffResult, GitErrorInfo> {
    let context_lines = context_lines.min(MAX_DIFF_CONTEXT_LINES);
    let repository_root =
        cached_git_repository_root(&workspace, &repository_roots, &runtime, &request)?;
    let file_path = decode_wire_path(&path);
    let untracked = !staged && untracked_hint.unwrap_or(false);
    let mut output = read_git_diff(
        &runtime,
        &repository_root,
        &request,
        &file_path,
        staged,
        untracked,
        context_lines,
    )?;
    if !staged
        && !untracked
        && output.stdout.is_empty()
        && is_untracked_path(&repository_root, &path, None, &runtime, &request)?
    {
        output = read_git_diff(
            &runtime,
            &repository_root,
            &request,
            &file_path,
            staged,
            true,
            context_lines,
        )?;
    }

    Ok(DiffResult {
        path,
        diff: String::from_utf8_lossy(&output.stdout).to_string(),
        staged,
        context_lines,
        output_bytes: output.stdout.len(),
        truncated: false,
        next_context_lines: next_context_lines(context_lines),
    })
}

fn git_diff_sync(
    workspace: String,
    path: String,
    staged: bool,
    repository_roots: Arc<RepositoryRootCache>,
    runtime: GitCoordinator,
    request: RequestHandle,
) -> Result<DiffResult, GitErrorInfo> {
    git_diff_sync_with_hint(
        workspace,
        path,
        staged,
        None,
        INITIAL_DIFF_CONTEXT_LINES,
        repository_roots,
        runtime,
        request,
    )
}

#[tauri::command]
async fn git_commit_diff(
    workspace: String,
    commit: String,
    path: String,
    context_lines: Option<usize>,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    quit_gate: State<'_, QuitGateState>,
) -> Result<DiffResult, GitErrorInfo> {
    let _admission = quit_gate
        .admit_resource_operation(window.label())
        .map_err(|error| git_error_info(GitErrorKind::Cancelled, error))?;
    let repository_roots = Arc::clone(&state.git_repository_roots);
    let runtime = state.git_runtime.clone();
    let window_id = window.label().to_string();
    let request = runtime.begin_request(decode_wire_path(&workspace), Some(&window_id));
    let resource = git_resource_key_async(workspace.clone(), repository_roots.clone()).await;
    let admission = _admission;
    run_git_blocking("Unable to read commit diff", resource, move || {
        let _admission = admission;
        git_commit_diff_sync(
            workspace,
            commit,
            path,
            context_lines.unwrap_or(INITIAL_DIFF_CONTEXT_LINES),
            repository_roots,
            runtime,
            request,
        )
    })
    .await
}

fn git_commit_diff_sync(
    workspace: String,
    commit: String,
    path: String,
    context_lines: usize,
    repository_roots: Arc<RepositoryRootCache>,
    runtime: GitCoordinator,
    request: RequestHandle,
) -> Result<DiffResult, GitErrorInfo> {
    let context_lines = context_lines.min(MAX_DIFF_CONTEXT_LINES);
    let repository_root =
        cached_git_repository_root(&workspace, &repository_roots, &runtime, &request)?;
    let file_path = decode_wire_path(&path);
    let output = read_git_commit_diff(
        &runtime,
        &repository_root,
        &request,
        &commit,
        &file_path,
        context_lines,
    )?;
    Ok(DiffResult {
        path,
        diff: String::from_utf8_lossy(&output.stdout).to_string(),
        staged: false,
        context_lines,
        output_bytes: output.stdout.len(),
        truncated: false,
        next_context_lines: next_context_lines(context_lines),
    })
}

#[tauri::command]
async fn git_commit_files(
    workspace: String,
    commit: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    quit_gate: State<'_, QuitGateState>,
) -> Result<Vec<GitCommitFile>, GitErrorInfo> {
    let _admission = quit_gate
        .admit_resource_operation(window.label())
        .map_err(|error| git_error_info(GitErrorKind::Cancelled, error))?;
    let repository_roots = Arc::clone(&state.git_repository_roots);
    let runtime = state.git_runtime.clone();
    let window_id = window.label().to_string();
    let request = runtime.begin_request(decode_wire_path(&workspace), Some(&window_id));
    let resource = git_resource_key_async(workspace.clone(), repository_roots.clone()).await;
    let admission = _admission;
    run_git_blocking("Unable to read commit files", resource, move || {
        let _admission = admission;
        let repository_root =
            cached_git_repository_root(&workspace, &repository_roots, &runtime, &request)?;
        git_commit_files_sync(repository_root, commit, &runtime, &request)
    })
    .await
}

fn git_commit_files_sync(
    repository_root: PathBuf,
    commit: String,
    runtime: &GitCoordinator,
    request: &RequestHandle,
) -> Result<Vec<GitCommitFile>, GitErrorInfo> {
    let output = git_read_shared(
        runtime,
        &repository_root,
        GitReadKind::History,
        vec![
            OsString::from("show"),
            OsString::from("--format="),
            OsString::from("--name-status"),
            OsString::from("--find-renames"),
            OsString::from("-z"),
            OsString::from(commit),
        ],
        request,
    )?;
    Ok(parse_git_commit_files(&output.stdout))
}

#[tauri::command]
async fn watch_workspace(
    workspace: String,
    extra_paths: Option<Vec<String>>,
    excludes: Option<Vec<String>>,
    open_files: Option<Vec<String>>,
    events: tauri::ipc::Channel<watcher::FileChangedEvent>,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    quit_gate: State<'_, QuitGateState>,
) -> Result<String, String> {
    let admission = quit_gate.admit_resource_operation(window.label())?;
    let watchers = Arc::clone(&state.watchers);
    let repository_roots = Arc::clone(&state.git_repository_roots);
    let runtime = state.git_runtime.clone();
    repository_roots
        .invalidate_workspace(decode_wire_path(&workspace), &runtime)
        .map_err(|error| error.message)?;
    let window_label = window.label().to_string();
    let request = runtime.begin_request(decode_wire_path(&workspace), Some(&window_label));
    let resource = git_resource_key_async(workspace.clone(), repository_roots.clone()).await;
    run_blocking_resource(
        "Unable to start file watcher",
        BlockingClass::Git,
        resource,
        move || {
            let _admission = admission;
            watch_workspace_sync(
                workspace,
                extra_paths,
                excludes,
                open_files,
                events,
                watchers,
                repository_roots,
                runtime,
                window_label,
                request,
            )
        },
    )
    .await
}

struct WatcherCompletion(Arc<AtomicBool>);

impl Drop for WatcherCompletion {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

fn watch_workspace_sync(
    workspace: String,
    extra_paths: Option<Vec<String>>,
    excludes: Option<Vec<String>>,
    open_files: Option<Vec<String>>,
    events: tauri::ipc::Channel<watcher::FileChangedEvent>,
    watchers: Arc<Mutex<HashMap<String, watcher::WatcherSession>>>,
    repository_roots: Arc<RepositoryRootCache>,
    runtime: GitCoordinator,
    window_label: String,
    request: RequestHandle,
) -> Result<String, String> {
    let workspace_path = decode_wire_path(&workspace);
    if let Ok(metadata) = fs::symlink_metadata(&workspace_path) {
        if metadata.file_type().is_symlink() || is_windows_reparse_point(&metadata) {
            return Err(
                "Unable to start file watcher. Symlink workspace folders are not supported; open the target folder directly."
                    .to_string(),
            );
        }
    }
    let session_id = Uuid::new_v4().to_string();
    let (control, receiver) =
        sync_channel::<watcher::WatcherMessage>(watcher::WATCHER_CHANNEL_CAPACITY);
    let stop_requested = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));
    let overflowed = Arc::new(AtomicBool::new(false));
    let callback_control = control.clone();
    let callback_overflowed = Arc::clone(&overflowed);
    let mut watcher = notify::recommended_watcher(move |result| {
        if let Err(error) = callback_control.try_send(watcher::WatcherMessage::Event(result)) {
            if matches!(error, TrySendError::Full(_)) {
                callback_overflowed.store(true, Ordering::Release);
            }
        }
    })
    .map_err(|error| format!("Unable to start file watcher. {error}"))?;
    let workspace = if workspace_path.is_dir() {
        normalize_watch_path(workspace_path)
    } else {
        workspace_path
    };
    ensure_request_active(&request).map_err(|error| error.message.clone())?;
    let has_workspace = workspace.is_dir();
    let repository = has_workspace
        .then(|| repository_roots.resolve(&workspace, &runtime, &request).ok())
        .flatten();
    let metadata = repository.as_ref().map_or_else(GitMetadataRoots::default, |repository| {
        GitMetadataRoots {
            git_dir: Some(repository.identity.git_dir.clone()),
            common_dir: Some(repository.identity.common_dir.clone()),
        }
    });
    let repository_root = repository
        .map(|repository| repository.root)
        .filter(|root| root.is_dir())
        .map(normalize_watch_path);
    ensure_request_active(&request).map_err(|error| error.message.clone())?;

    let mut logical_roots = Vec::new();
    if has_workspace {
        watcher::add_watch_root(
            &mut logical_roots,
            workspace.clone(),
            watcher::WatchRootKind::Workspace,
        );
        if let Some(repository_root) = repository_root.as_ref() {
            if repository_root != &workspace {
                // Git status is repository-wide even when the editor is opened on a
                // subdirectory, so changes in sibling worktree paths must wake it.
                watcher::add_watch_root(
                    &mut logical_roots,
                    repository_root.clone(),
                    watcher::WatchRootKind::Worktree,
                );
            }
        }
        if let Some(git_dir) = metadata.git_dir.as_ref() {
            watcher::add_watch_root(
                &mut logical_roots,
                git_dir.clone(),
                watcher::WatchRootKind::GitDir,
            );
        }
        if let Some(common_dir) = metadata.common_dir.as_ref() {
            watcher::add_watch_root(
                &mut logical_roots,
                common_dir.clone(),
                watcher::WatchRootKind::CommonDir,
            );
        }
    }
    for extra_path in extra_paths.unwrap_or_default() {
        let extra_path = watcher::resolve_watch_input(&extra_path, &workspace);
        if extra_path.is_dir() {
            watcher::add_watch_root(
                &mut logical_roots,
                normalize_watch_path(extra_path),
                watcher::WatchRootKind::External,
            );
        }
    }
    if logical_roots.is_empty() {
        return Err(
            "Unable to start file watcher. No existing directory is available to watch."
                .to_string(),
        );
    }
    ensure_request_active(&request).map_err(|error| error.message.clone())?;
    let registration_roots = watcher::minimize_watch_roots(&logical_roots);
    let recovery_parents = watcher::watcher_recovery_parents(&registration_roots);
    for parent in &recovery_parents {
        ensure_request_active(&request).map_err(|error| error.message.clone())?;
        watcher.watch(parent, RecursiveMode::NonRecursive).map_err(|error| {
            format!(
                "Unable to watch parent folder {} to detect workspace removal or recreation. {error}",
                parent.display()
            )
        })?;
    }
    for watch_root in &registration_roots {
        ensure_request_active(&request).map_err(|error| error.message.clone())?;
        watcher
            .watch(&watch_root.path, RecursiveMode::Recursive)
            .map_err(|error| format!("Unable to watch {}. {error}", watch_root.path.display()))?;
    }
    let config = watcher::WatcherConfig {
        workspace: workspace.clone(),
        watch_roots: logical_roots.clone(),
        git_dir: metadata.git_dir,
        common_dir: metadata.common_dir,
        repository_root,
        git_runtime: runtime,
        excludes: excludes
            .unwrap_or_default()
            .iter()
            .map(|value| watcher::resolve_watch_input(value, &workspace))
            .map(normalize_watch_path)
            .collect(),
        open_files: open_files
            .unwrap_or_default()
            .iter()
            .map(|value| watcher::resolve_watch_input(value, &workspace))
            .map(normalize_watch_path)
            .collect(),
    };
    ensure_request_active(&request).map_err(|error| error.message.clone())?;
    let returned_session_id = session_id.clone();
    let thread_session_id = session_id.clone();
    let thread_stop_requested = Arc::clone(&stop_requested);
    let thread_finished = Arc::clone(&finished);
    let thread_request_token = request.token();
    let thread_watchers = Arc::clone(&watchers);
    let thread_registration_roots = registration_roots
        .into_iter()
        .map(|root| watcher::WatchRootRegistration {
            identity: watcher::watch_root_identity(&root.path),
            path: root.path,
            attached: true,
            failure_reported: false,
        })
        .collect();
    let _watcher_thread = thread::Builder::new()
        .name(format!("pude-watcher-{session_id}"))
        .spawn(move || {
            let _finished = WatcherCompletion(thread_finished);
            watcher::run_watcher(
                watcher,
                receiver,
                events,
                config,
                thread_session_id,
                thread_stop_requested,
                overflowed,
                thread_registration_roots,
                thread_request_token,
                thread_watchers,
            );
        })
        .map_err(|error| format!("Unable to start file watcher thread. {error}"))?;
    if let Err(error) = ensure_request_active(&request) {
        stop_requested.store(true, Ordering::Release);
        let _ = control.try_send(watcher::WatcherMessage::Stop);
        return Err(error.message.clone());
    }
    let previous = match watchers.lock() {
        Ok(mut watchers) => {
            if let Err(error) = ensure_request_active(&request) {
                stop_requested.store(true, Ordering::Release);
                let _ = control.try_send(watcher::WatcherMessage::Stop);
                return Err(error.message.clone());
            }
            watchers.insert(
                window_label.clone(),
                watcher::WatcherSession {
                    session_id: session_id.clone(),
                    control: control.clone(),
                    stop_requested: Arc::clone(&stop_requested),
                    finished: Arc::clone(&finished),
                },
            )
        }
        Err(_) => {
            stop_requested.store(true, Ordering::Release);
            let _ = control.try_send(watcher::WatcherMessage::Stop);
            return Err("Unable to lock watcher state.".to_string());
        }
    };
    if request.token().is_cancelled() {
        stop_requested.store(true, Ordering::Release);
        let _ = control.try_send(watcher::WatcherMessage::Stop);
        if let Ok(mut watchers) = watchers.lock() {
            if watchers
                .get(&window_label)
                .is_some_and(|session| session.session_id == session_id)
            {
                if let Some(session) = watchers.remove(&window_label) {
                    watcher::stop_watcher_session(&session);
                }
            }
        }
        return Err("Git command was cancelled.".to_string());
    }
    if let Some(previous) = previous {
        watcher::stop_watcher_session(&previous);
    }
    Ok(returned_session_id)
}

fn normalize_watch_path(path: PathBuf) -> PathBuf {
    fs::canonicalize(&path).unwrap_or(path)
}

fn path_eq(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .replace('/', "\\")
            .eq_ignore_ascii_case(&right.to_string_lossy().replace('/', "\\"))
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[tauri::command]
async fn reveal_in_file_manager(path: String) -> Result<(), String> {
    run_blocking("Unable to reveal file", BlockingClass::File, move || {
        reveal_in_file_manager_sync(path)
    })
    .await
}

fn reveal_in_file_manager_sync(path: String) -> Result<(), String> {
    let target = decode_wire_path(&path);
    if cfg!(windows) {
        Command::new("explorer")
            .arg("/select,")
            .arg(&target)
            .spawn()
            .map_err(|error| error.to_string())?;
    } else if cfg!(target_os = "macos") {
        Command::new("open")
            .arg("-R")
            .arg(&target)
            .spawn()
            .map_err(|error| error.to_string())?;
    } else {
        Command::new("xdg-open")
            .arg(target.parent().unwrap_or(&target))
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

// `canonicalize` and the per-directory .git walk can block for a long
// time on slow or network volumes, so they must not run on an async runtime
// worker. The same cache-first helper runs on the Git blocking pool instead;
// when the pool is unavailable (e.g. during shutdown) we fall back to
// computing the key inline.
async fn git_resource_key_async(
    workspace: String,
    repository_roots: Arc<RepositoryRootCache>,
) -> String {
    let fallback_workspace = workspace.clone();
    let fallback_roots = Arc::clone(&repository_roots);
    run_blocking_resource(
        "Unable to resolve Git resource key",
        BlockingClass::Git,
        workspace.clone(),
        move || Ok(git_resource_key(&workspace, &repository_roots)),
    )
    .await
    .unwrap_or_else(|_| git_resource_key(&fallback_workspace, &fallback_roots))
}

fn git_resource_key(workspace: &str, repository_roots: &RepositoryRootCache) -> String {
    let path = decode_wire_path(workspace);
    let path = repository_roots.resource_key(&path);
    wire_path(&path)
}

fn ensure_request_active(request: &RequestHandle) -> Result<(), GitErrorInfo> {
    if request.token().is_cancelled() {
        Err(git_error_info(
            GitErrorKind::Cancelled,
            "Git command was cancelled.",
        ))
    } else {
        Ok(())
    }
}

fn git_read_shared_raw(
    runtime: &GitCoordinator,
    repository: &Path,
    kind: GitReadKind,
    args: Vec<OsString>,
    request: &RequestHandle,
) -> Result<GitCommandOutput, GitErrorInfo> {
    ensure_request_active(request)?;
    let spec = GitCommandSpec::read(repository.to_path_buf(), args);
    runtime
        .read_shared_for(GitReadRequest::new(repository, kind, spec), request)
        .map_err(|error| error.info())
}

fn git_read_shared(
    runtime: &GitCoordinator,
    repository: &Path,
    kind: GitReadKind,
    args: Vec<OsString>,
    request: &RequestHandle,
) -> Result<GitCommandOutput, GitErrorInfo> {
    git_read_shared_raw(runtime, repository, kind, args, request)
        .and_then(|output| output.into_success().map_err(|error| error.info()))
}

fn git_execute(
    runtime: &GitCoordinator,
    repository: &Path,
    args: Vec<OsString>,
    request: &RequestHandle,
) -> Result<GitCommandOutput, GitErrorInfo> {
    ensure_request_active(request)?;
    let spec = GitCommandSpec::new(repository.to_path_buf(), args);
    runtime
        .execute(spec, &request.token())
        .and_then(|output| output.into_success())
        .map_err(|error| error.info())
}

#[derive(Debug)]
enum LimitedReadError {
    TooLarge { limit: u64 },
    NotAFile,
    Symlink,
    Changed,
    Io(io::Error),
}

fn read_file_with_metadata(
    path: &Path,
    limit: u64,
) -> Result<(Vec<u8>, fs::Metadata, FileIdentity), LimitedReadError> {
    let path_metadata = fs::symlink_metadata(path).map_err(LimitedReadError::Io)?;
    if path_metadata.file_type().is_symlink() || is_windows_reparse_point(&path_metadata) {
        return Err(LimitedReadError::Symlink);
    }
    if !path_metadata.is_file() {
        return Err(LimitedReadError::NotAFile);
    }
    let path_identity = path_file_identity(path, &path_metadata).map_err(LimitedReadError::Io)?;

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    #[cfg(windows)]
    options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    let file = options.open(path).map_err(|error| {
        if is_symlink_open_error(&error) {
            LimitedReadError::Symlink
        } else {
            LimitedReadError::Io(error)
        }
    })?;
    let metadata = file.metadata().map_err(LimitedReadError::Io)?;
    if is_windows_reparse_point(&metadata) {
        return Err(LimitedReadError::Symlink);
    }
    if !metadata.is_file() {
        return Err(LimitedReadError::NotAFile);
    }
    let opened_identity = opened_file_identity(&file, &metadata).map_err(LimitedReadError::Io)?;
    if metadata.len() > limit {
        return Err(LimitedReadError::TooLarge { limit });
    }

    let limit_usize = usize::try_from(limit).unwrap_or(usize::MAX);
    // Read at most limit+1 bytes in one take()+read_to_end() pass
    // instead of reallocating a 64 KiB buffer per loop iteration. Reading
    // limit+1 bytes preserves the over-limit semantics: more than `limit`
    // bytes means the file is too large.
    let mut bytes = Vec::with_capacity(
        (metadata.len().min(limit).saturating_add(1)).min(limit_usize as u64) as usize,
    );
    (&file)
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(LimitedReadError::Io)?;
    if bytes.len() > limit_usize {
        return Err(LimitedReadError::TooLarge { limit });
    }
    let final_metadata = file.metadata().map_err(LimitedReadError::Io)?;
    let final_path_metadata = fs::symlink_metadata(path).map_err(LimitedReadError::Io)?;
    if final_path_metadata.file_type().is_symlink()
        || is_windows_reparse_point(&final_path_metadata)
    {
        return Err(LimitedReadError::Changed);
    }
    let final_path_identity =
        path_file_identity(path, &final_path_metadata).map_err(LimitedReadError::Io)?;
    if path_identity != opened_identity
        || opened_identity != final_path_identity
        || metadata.len() != final_metadata.len()
        || metadata.modified().ok() != final_metadata.modified().ok()
        || bytes.len() as u64 != final_metadata.len()
    {
        return Err(LimitedReadError::Changed);
    }
    Ok((bytes, final_metadata, opened_identity))
}

#[cfg(unix)]
fn is_symlink_open_error(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::ELOOP)
}

#[cfg(not(unix))]
fn is_symlink_open_error(_error: &io::Error) -> bool {
    false
}

#[cfg(windows)]
fn is_windows_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_attributes() & 0x0000_0400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
}

#[cfg(not(windows))]
fn is_windows_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn path_file_identity(path: &Path, metadata: &fs::Metadata) -> io::Result<FileIdentity> {
    #[cfg(windows)]
    {
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        let mut options = OpenOptions::new();
        options.read(true).custom_flags(
            FILE_FLAG_OPEN_REPARSE_POINT
                | if metadata.is_dir() {
                    FILE_FLAG_BACKUP_SEMANTICS
                } else {
                    0
                },
        );
        let file = options.open(path)?;
        let opened_metadata = file.metadata()?;
        if is_windows_reparse_point(&opened_metadata)
            || opened_metadata.is_dir() != metadata.is_dir()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "the file was replaced or is a reparse point",
            ));
        }
        opened_file_identity(&file, &opened_metadata)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        opened_file_identity_from_metadata(metadata)
    }
}

fn opened_file_identity(file: &File, metadata: &fs::Metadata) -> io::Result<FileIdentity> {
    #[cfg(windows)]
    {
        let _ = metadata;
        windows_file_identity(file)
    }
    #[cfg(not(windows))]
    {
        let _ = file;
        opened_file_identity_from_metadata(metadata)
    }
}

#[cfg(not(windows))]
fn opened_file_identity_from_metadata(metadata: &fs::Metadata) -> io::Result<FileIdentity> {
    #[cfg(unix)]
    {
        Ok(FileIdentity {
            volume: metadata.dev(),
            file: metadata.ino(),
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        Ok(FileIdentity {
            volume: 0,
            file: metadata.len(),
        })
    }
}

#[cfg(windows)]
fn windows_file_identity(file: &impl AsRawHandle) -> io::Result<FileIdentity> {
    #[repr(C)]
    struct FileInformation {
        attributes: u32,
        creation_time: [u32; 2],
        access_time: [u32; 2],
        write_time: [u32; 2],
        volume_serial_number: u32,
        file_size_high: u32,
        file_size_low: u32,
        links: u32,
        file_index_high: u32,
        file_index_low: u32,
    }

    #[link(name = "Kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(
            handle: *mut std::ffi::c_void,
            info: *mut FileInformation,
        ) -> i32;
    }

    let mut info = std::mem::MaybeUninit::<FileInformation>::uninit();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let info = unsafe { info.assume_init() };
    Ok(FileIdentity {
        volume: u64::from(info.volume_serial_number),
        file: (u64::from(info.file_index_high) << 32) | u64::from(info.file_index_low),
    })
}

fn format_limited_read_error(action: &str, error: LimitedReadError) -> String {
    let context = match action {
        "read file" => "Unable to read file",
        "read saved file" => "Unable to verify the saved file",
        _ => "Unable to fingerprint file before saving",
    };
    match error {
        LimitedReadError::TooLarge { limit } => format!(
            "{context}. The file is too large to open (maximum {} MiB).",
            limit / (1024 * 1024)
        ),
        LimitedReadError::NotAFile => {
            format!("{context}. The selected path is not a regular file.")
        }
        LimitedReadError::Symlink => {
            format!("{context}. Symlink files are not supported; open the target file directly.")
        }
        LimitedReadError::Changed => format!(
            "{context}. The file changed while it was being checked; reload it and try again."
        ),
        LimitedReadError::Io(error) => format!("{context}. {error}"),
    }
}

fn save_lock_key(path: &Path) -> PathBuf {
    if let Ok(path) = fs::canonicalize(path) {
        return path;
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = path.file_name().unwrap_or_default();
    fs::canonicalize(parent)
        .map(|parent| parent.join(file_name))
        .unwrap_or_else(|_| path.to_path_buf())
}

fn path_lock(
    locks: &Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>,
    path: &Path,
) -> Result<Arc<Mutex<()>>, String> {
    let mut locks = locks
        .lock()
        .map_err(|_| "Unable to lock save state.".to_string())?;
    // A Weak entry is useful only while a caller owns or waits on the mutex.
    // Reap dead entries opportunistically while holding the registry lock so a
    // new caller cannot observe a stale key and create an untracked lock.
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks
        .iter()
        .find(|(registered_path, _)| path_eq(registered_path, path))
        .and_then(|(_, lock)| Weak::upgrade(lock))
    {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(path.to_path_buf(), Arc::downgrade(&lock));
    Ok(lock)
}

#[derive(Debug)]
enum AtomicSaveError {
    Conflict,
    Symlink,
    Io(io::Error),
    CommittedButNotDurable(io::Error),
}

fn format_atomic_save_error(error: AtomicSaveError) -> String {
    match error {
        AtomicSaveError::Conflict => {
            "Unable to save file. It changed on disk while saving; reload or compare before saving."
                .to_string()
        }
        AtomicSaveError::Symlink => {
            "Unable to save file. Symlink targets are not replaced automatically.".to_string()
        }
        AtomicSaveError::Io(error) => format!("Unable to save file. {error}"),
        AtomicSaveError::CommittedButNotDurable(error) => format!(
            "The file was replaced, but its folder could not be synced to storage. Reopen the file to confirm the saved contents. {error}"
        ),
    }
}

fn inspect_atomic_save_target(path: &Path) -> Result<Option<FileSnapshot>, AtomicSaveError> {
    match fs::symlink_metadata(path) {
        Ok(metadata)
            if metadata.file_type().is_symlink() || is_windows_reparse_point(&metadata) =>
        {
            Err(AtomicSaveError::Symlink)
        }
        Ok(_) => filesystem::save_file_metadata(path)
            .map(Some)
            .map_err(|_| AtomicSaveError::Conflict),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AtomicSaveError::Io(error)),
    }
}

fn save_file_atomically(
    path: &Path,
    bytes: &[u8],
    expected: Option<&FileSnapshot>,
) -> Result<(), AtomicSaveError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let initial = inspect_atomic_save_target(path)?;
    if initial.as_ref() != expected {
        return Err(AtomicSaveError::Conflict);
    }
    let original_metadata = if expected.is_some() {
        Some(fs::symlink_metadata(path).map_err(AtomicSaveError::Io)?)
    } else {
        None
    };
    if let Some(metadata) = original_metadata.as_ref() {
        if metadata.permissions().readonly() {
            return Err(AtomicSaveError::Io(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the destination file is read-only",
            )));
        }
        #[cfg(unix)]
        if metadata.mode() & 0o222 == 0 {
            return Err(AtomicSaveError::Io(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the destination file has no write permission bits",
            )));
        }
    }
    let (temporary_path, mut temporary_file) =
        create_unique_temp_file(parent).map_err(AtomicSaveError::Io)?;

    let write_result = (|| {
        temporary_file
            .write_all(bytes)
            .map_err(AtomicSaveError::Io)?;
        temporary_file.sync_all().map_err(AtomicSaveError::Io)?;
        if let (Some(metadata), Some(snapshot)) = (original_metadata.as_ref(), expected) {
            fs::set_permissions(&temporary_path, metadata.permissions())
                .map_err(AtomicSaveError::Io)?;
            copy_platform_file_metadata(path, &temporary_file, snapshot)?;
            temporary_file.sync_all().map_err(AtomicSaveError::Io)?;
        }
        Ok::<(), AtomicSaveError>(())
    })();

    if let Err(error) = write_result {
        drop(temporary_file);
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }
    let current = match inspect_atomic_save_target(path) {
        Ok(current) => current,
        Err(error) => {
            drop(temporary_file);
            let _ = fs::remove_file(&temporary_path);
            return Err(error);
        }
    };
    if current.as_ref() != expected {
        drop(temporary_file);
        let _ = fs::remove_file(&temporary_path);
        return Err(AtomicSaveError::Conflict);
    }
    drop(temporary_file);
    if let Err(error) = atomic_replace(&temporary_path, path, expected.is_some()) {
        let _ = fs::remove_file(&temporary_path);
        return Err(AtomicSaveError::Io(error));
    }
    sync_parent_directory(parent).map_err(AtomicSaveError::CommittedButNotDurable)?;
    Ok(())
}

fn copy_platform_file_metadata(
    original_path: &Path,
    _replacement: &File,
    expected: &FileSnapshot,
) -> Result<(), AtomicSaveError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    #[cfg(windows)]
    options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    let original = options.open(original_path).map_err(AtomicSaveError::Io)?;
    let metadata = original.metadata().map_err(AtomicSaveError::Io)?;
    if is_windows_reparse_point(&metadata)
        || opened_file_identity(&original, &metadata).map_err(AtomicSaveError::Io)?
            != expected.identity
    {
        return Err(AtomicSaveError::Conflict);
    }
    #[cfg(target_os = "macos")]
    copy_macos_file_metadata(&original, _replacement).map_err(AtomicSaveError::Io)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn copy_macos_file_metadata(original: &File, replacement: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    use std::os::raw::{c_int, c_void};

    #[link(name = "System")]
    extern "C" {
        fn fcopyfile(from_fd: c_int, to_fd: c_int, state: *mut c_void, flags: u32) -> c_int;
    }

    const COPYFILE_ACL: u32 = 1 << 0;
    const COPYFILE_XATTR: u32 = 1 << 2;
    let copied = unsafe {
        fcopyfile(
            original.as_raw_fd(),
            replacement.as_raw_fd(),
            std::ptr::null_mut(),
            COPYFILE_ACL | COPYFILE_XATTR,
        )
    };
    if copied == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn create_unique_temp_file(parent: &Path) -> io::Result<(PathBuf, File)> {
    for _ in 0..16 {
        let temporary_path = parent.join(format!(".pude-tmp-{}.tmp", Uuid::new_v4()));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
        {
            Ok(file) => return Ok((temporary_path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "unable to create a unique temporary file",
    ))
}

#[cfg(not(windows))]
fn atomic_replace(temporary: &Path, destination: &Path, replace_existing: bool) -> io::Result<()> {
    if replace_existing {
        return fs::rename(temporary, destination);
    }
    #[cfg(target_os = "macos")]
    {
        use std::ffi::CString;
        use std::os::raw::c_int;
        use std::os::unix::ffi::OsStrExt;

        #[link(name = "System")]
        extern "C" {
            fn renamex_np(from: *const i8, to: *const i8, flags: u32) -> c_int;
        }
        const RENAME_EXCL: u32 = 0x0000_0004;
        let temporary = CString::new(temporary.as_os_str().as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid temporary path"))?;
        let destination = CString::new(destination.as_os_str().as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid destination path"))?;
        let renamed = unsafe { renamex_np(temporary.as_ptr(), destination.as_ptr(), RENAME_EXCL) };
        if renamed == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        fs::hard_link(temporary, destination)?;
        fs::remove_file(temporary)
    }
}

#[cfg(windows)]
fn atomic_replace(temporary: &Path, destination: &Path, replace_existing: bool) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
        fn ReplaceFileW(
            replaced_file_name: *const u16,
            replacement_file_name: *const u16,
            backup_file_name: *const u16,
            replace_flags: u32,
            exclude: *mut std::ffi::c_void,
            reserved: *mut std::ffi::c_void,
        ) -> i32;
    }

    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let temporary: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let replaced = unsafe {
        if replace_existing {
            ReplaceFileW(
                destination.as_ptr(),
                temporary.as_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } else {
            MoveFileExW(
                temporary.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if replaced == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> io::Result<()> {
    File::open(parent)?.sync_all()
}

#[cfg(windows)]
fn sync_parent_directory(_parent: &Path) -> io::Result<()> {
    Ok(())
}

// The frontend already knows from `git status` whether the path is
// untracked (worktreeStatus == "?"). `untracked_hint` lets it skip the extra
// `git status` process here; when no hint is provided the behavior is
// unchanged.
fn is_untracked_path(
    repository_root: &Path,
    path: &str,
    untracked_hint: Option<bool>,
    runtime: &GitCoordinator,
    request: &RequestHandle,
) -> Result<bool, GitErrorInfo> {
    if let Some(untracked) = untracked_hint {
        return Ok(untracked);
    }
    let path = decode_wire_path(path);
    let args = vec![
        OsString::from("status"),
        OsString::from("--porcelain=v2"),
        OsString::from("--untracked-files=all"),
        OsString::from("-z"),
        OsString::from("--"),
        path.as_os_str().to_os_string(),
    ];
    let output = git_read_shared(runtime, repository_root, GitReadKind::Status, args, request)?;
    Ok(parse_git_status(&output.stdout)
        .files
        .iter()
        .any(|file| file.worktree_status.as_deref() == Some("?") && file.path == wire_path(&path)))
}

fn is_expected_no_index_difference_runtime(output: &GitCommandOutput) -> bool {
    output.exit_code == Some(1) && !output.stdout.is_empty()
}

#[cfg(windows)]
fn null_device_path() -> &'static str {
    "NUL"
}

#[cfg(not(windows))]
fn null_device_path() -> &'static str {
    "/dev/null"
}

fn require_git_value(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() {
        Err(format!("Choose a {label} first."))
    } else {
        Ok(())
    }
}

fn git_runtime_output_error(output: &GitCommandOutput) -> GitErrorInfo {
    let stderr = output.stderr_lossy().trim().to_string();
    let stdout = output.stdout_lossy().trim().to_string();
    let message = if stderr.is_empty() {
        if stdout.is_empty() {
            "Git operation failed without an error message.".to_string()
        } else {
            stdout
        }
    } else {
        stderr
    };
    git_error_info(GitErrorKind::Failed, message)
}

fn git_success_message_runtime(output: &GitCommandOutput) -> String {
    let stdout = output.stdout_lossy().trim().to_string();
    if stdout.is_empty() {
        "Git operation completed.".to_string()
    } else {
        stdout
    }
}

fn parse_git_status(bytes: &[u8]) -> ParsedGitStatus {
    let mut entries = bytes.split(|byte| *byte == 0);
    let mut parsed = ParsedGitStatus::default();
    let mut branch_head = None;
    let mut branch_oid = None;

    while let Some(entry) = entries.next() {
        if entry.is_empty() {
            continue;
        }
        if let Some(value) = entry.strip_prefix(b"# branch.head ") {
            branch_head = Some(String::from_utf8_lossy(value).into_owned());
            continue;
        }
        if let Some(value) = entry.strip_prefix(b"# branch.oid ") {
            branch_oid = Some(String::from_utf8_lossy(value).into_owned());
            continue;
        }
        if entry.starts_with(b"# ") {
            continue;
        }
        if let Some(fields) = split_git_record(entry, 9, b"1 ") {
            let status = fields[1];
            parsed.files.push(GitFileStatus {
                path: wire_path_bytes(fields[8]),
                index_status: status_char_byte(status.first().copied()),
                worktree_status: status_char_byte(status.get(1).copied()),
                original_path: None,
                conflict: false,
            });
            continue;
        }
        if let Some(fields) = split_git_record(entry, 10, b"2 ") {
            let status = fields[1];
            let original_path = entries
                .next()
                .filter(|path| !path.is_empty())
                .map(wire_path_bytes);
            parsed.files.push(GitFileStatus {
                path: wire_path_bytes(fields[9]),
                index_status: status_char_byte(status.first().copied()),
                worktree_status: status_char_byte(status.get(1).copied()),
                original_path,
                conflict: false,
            });
            continue;
        }
        if let Some(fields) = split_git_record(entry, 11, b"u ") {
            let status = fields[1];
            parsed.files.push(GitFileStatus {
                path: wire_path_bytes(fields[10]),
                index_status: status_char_byte(status.first().copied()),
                worktree_status: status_char_byte(status.get(1).copied()),
                original_path: None,
                conflict: true,
            });
            continue;
        }
        if let Some(path) = entry.strip_prefix(b"? ") {
            parsed.files.push(GitFileStatus {
                path: wire_path_bytes(path),
                index_status: None,
                worktree_status: Some("?".to_string()),
                original_path: None,
                conflict: false,
            });
        }
    }

    parsed.branch = branch_head
        .as_ref()
        .filter(|value| !value.is_empty() && value.as_str() != "(detached)")
        .cloned();
    parsed.head_oid = branch_oid
        .as_ref()
        .filter(|value| !value.is_empty() && value.as_str() != "(initial)")
        .cloned();
    parsed.repository_state = if branch_oid.as_deref() == Some("(initial)") {
        GitRepositoryState::Unborn
    } else if branch_head.as_deref() == Some("(detached)") {
        GitRepositoryState::Detached
    } else if parsed.branch.is_some() {
        GitRepositoryState::Normal
    } else {
        GitRepositoryState::Unknown
    };
    parsed
}

fn split_git_record<'a>(
    entry: &'a [u8],
    field_count: usize,
    prefix: &[u8],
) -> Option<Vec<&'a [u8]>> {
    if !entry.starts_with(prefix) {
        return None;
    }
    let fields: Vec<&[u8]> = entry.splitn(field_count, |byte| *byte == b' ').collect();
    (fields.len() == field_count).then_some(fields)
}

fn status_char_byte(value: Option<u8>) -> Option<String> {
    value
        .filter(|character| *character != b'.' && *character != b' ')
        .map(|character| char::from(character).to_string())
}

fn parse_git_commit_files(bytes: &[u8]) -> Vec<GitCommitFile> {
    let mut fields = bytes
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    let mut files = Vec::new();
    while let Some(status_bytes) = fields.next() {
        let status = String::from_utf8_lossy(status_bytes).trim().to_string();
        let Some(first_path_bytes) = fields.next() else {
            break;
        };
        if status.is_empty() || first_path_bytes.is_empty() {
            continue;
        }
        let first_path = wire_path_bytes(first_path_bytes);
        let is_rename_or_copy = status.starts_with('R') || status.starts_with('C');
        let renamed_path = is_rename_or_copy
            .then(|| fields.next().map(wire_path_bytes))
            .flatten();
        let path = renamed_path.clone().unwrap_or_else(|| first_path.clone());
        files.push(GitCommitFile {
            path,
            status,
            original_path: is_rename_or_copy.then_some(first_path),
        });
    }
    files
}

fn timestamp(time: SystemTime) -> Option<u128> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis())
}

fn content_fingerprint(bytes: &[u8]) -> String {
    // Keep this in sync with the renderer's FNV-1a implementation. It is a
    // deterministic change detector used together with mtime and size, not a
    // security hash.
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// SB-01: resources extracted from the state tables for one destroyed window.
/// Planning runs on the window event handler and only holds locks briefly;
/// stopping runs on the `pude-window-cleanup` thread.
#[cfg(test)]
struct WindowCleanupPlan {
    window_label: String,
    terminals_table: Arc<Mutex<HashMap<String, Arc<terminal::TerminalSession>>>>,
    terminals: Vec<(String, Arc<terminal::TerminalSession>)>,
    lsp: Option<lsp_manager::WindowSessions>,
}

#[cfg(test)]
impl WindowCleanupPlan {
    fn is_empty(&self) -> bool {
        self.terminals.is_empty()
            && self
                .lsp
                .as_ref()
                .map_or(true, lsp_manager::WindowSessions::is_empty)
    }
}

/// SB-01: join handles of in-flight window cleanup threads. They are drained
/// with a bounded wait when the app exits so child processes are reaped
/// instead of orphaned.
#[derive(Default)]
struct WindowCleanupRegistry {
    handles: Mutex<Vec<thread::JoinHandle<()>>>,
}

impl WindowCleanupRegistry {
    fn track(&self, handle: thread::JoinHandle<()>) {
        if let Ok(mut handles) = self.handles.lock() {
            handles.retain(|handle| !handle.is_finished());
            handles.push(handle);
        }
    }
}

const WINDOW_CLEANUP_EXIT_JOIN_BUDGET: Duration = Duration::from_secs(3);

fn join_window_cleanups(registry: &WindowCleanupRegistry) {
    let handles = match registry.handles.lock() {
        Ok(mut handles) => std::mem::take(&mut *handles),
        Err(error) => {
            app_log::log_error(&format!(
                "Unable to lock window cleanup registry during exit: {error}"
            ));
            return;
        }
    };
    let deadline = std::time::Instant::now() + WINDOW_CLEANUP_EXIT_JOIN_BUDGET;
    for handle in handles {
        if !join_thread_until(handle, deadline) {
            app_log::log_error(
                "Abandoned a window cleanup thread after the exit join budget elapsed; \
                 its child processes may be left running.",
            );
        }
    }
}

fn join_thread_until(handle: thread::JoinHandle<()>, deadline: std::time::Instant) -> bool {
    while !handle.is_finished() {
        if std::time::Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
    if let Err(error) = handle.join() {
        app_log::log_error(&format!(
            "Window cleanup thread panicked during exit join: {error:?}"
        ));
    }
    true
}

#[cfg(test)]
fn plan_window_cleanup(
    state: &AppState,
    lsp_manager: &lsp_manager::LspManager,
    window_label: &str,
) -> WindowCleanupPlan {
    state.git_runtime.cancel_window(window_label);
    if let Ok(mut watchers) = state.watchers.lock() {
        if let Some(session) = watchers.remove(window_label) {
            watcher::stop_watcher_session(&session);
        }
    }

    let mut terminals = Vec::new();
    {
        match state
            .terminal_lifecycle
            .retire_window(&state.terminals, window_label)
        {
            Ok(taken) => terminals = taken,
            Err(error) => app_log::log_error(&format!(
                "Unable to collect terminals for window {window_label}: {error}"
            )),
        }
    }

    let lsp = match lsp_manager.take_window_sessions(window_label) {
        Ok(sessions) => Some(sessions),
        Err(error) => {
            app_log::log_error(&format!(
                "Unable to collect LSP sessions for window {window_label}: {error}"
            ));
            None
        }
    };

    WindowCleanupPlan {
        window_label: window_label.to_string(),
        terminals_table: Arc::clone(&state.terminals),
        terminals,
        lsp,
    }
}

/// SB-01: stops every resource in the plan, one thread per terminal and one
/// for the LSP sessions so slow stops run in parallel.
#[cfg(test)]
fn run_window_cleanup(plan: WindowCleanupPlan) {
    let mut workers: Vec<thread::JoinHandle<()>> = Vec::new();
    for (session_id, terminal) in plan.terminals {
        let terminals_table = Arc::clone(&plan.terminals_table);
        let window_label = plan.window_label.clone();
        let stop_session_id = session_id.clone();
        let stop_terminal = Arc::clone(&terminal);
        match thread::Builder::new()
            .name("pude-resource-stop".to_string())
            .spawn(move || {
                if let Err(error) = terminal::stop_terminal_session(&stop_terminal) {
                    app_log::log_error(&format!(
                        "Unable to clean up terminal {stop_session_id} for window {window_label}: {error}"
                    ));
                    if let Ok(mut terminals) = terminals_table.lock() {
                        terminals.insert(stop_session_id, stop_terminal);
                    }
                }
            })
        {
            Ok(handle) => workers.push(handle),
            Err(error) => {
                app_log::log_error(&format!(
                    "Unable to spawn terminal cleanup for window {}: {error}",
                    plan.window_label
                ));
                // Put the session back so its process stays reachable instead
                // of being silently leaked.
                if let Ok(mut terminals) = plan.terminals_table.lock() {
                    terminals.insert(session_id, terminal);
                }
            }
        }
    }
    if let Some(lsp) = plan.lsp {
        let window_label = plan.window_label.clone();
        match thread::Builder::new()
            .name("pude-resource-stop".to_string())
            .spawn(move || {
                if let Err(error) = lsp.stop() {
                    app_log::log_error(&format!(
                        "Unable to stop LSP servers for window {window_label}: {error}"
                    ));
                }
            }) {
            Ok(handle) => workers.push(handle),
            Err(error) => app_log::log_error(&format!(
                "Unable to spawn LSP cleanup for window {}: {error}",
                plan.window_label
            )),
        }
    }
    for worker in workers {
        if let Err(error) = worker.join() {
            app_log::log_error(&format!(
                "Window {} cleanup worker panicked: {error:?}",
                plan.window_label
            ));
        }
    }
}

#[cfg(test)]
fn cleanup_window_resources(state: &AppState, window_label: &str) -> Result<(), String> {
    state
        .git_runtime
        .cancel_window_and_wait(window_label, Duration::from_secs(5))?;
    cleanup_window_resources_after_git_cancel(state, window_label)
}

fn cleanup_window_resources_with_gate(
    state: &AppState,
    lsp_state: &lsp_manager::LspState,
    quit_gate: &QuitGateState,
    window_label: &str,
) -> Result<(), String> {
    state
        .git_runtime
        .cancel_window_and_wait(window_label, Duration::from_secs(5))?;
    // Cancel startup handshakes and existing LSP work before waiting for the
    // command admission guards they own to drain.
    lsp_manager::cleanup_window(lsp_state, window_label)?;
    quit_gate.wait_for_resource_operations(window_label, Duration::from_secs(5))?;
    cleanup_window_resources_after_git_cancel(state, window_label)
}

fn cleanup_window_resources_after_git_cancel(
    state: &AppState,
    window_label: &str,
) -> Result<(), String> {
    let session = state
        .watchers
        .lock()
        .map_err(|_| format!("Unable to lock watcher state for window {window_label}."))?
        .remove(window_label);
    if let Some(session) = session {
        if let Err(error) = watcher::stop_watcher_session_and_wait(&session, Duration::from_secs(2))
        {
            if let Ok(mut watchers) = state.watchers.lock() {
                watchers.insert(window_label.to_string(), session);
            }
            return Err(format!("Unable to stop file watcher: {error}"));
        }
    }

    // A live watcher can enqueue Git work until its worker has returned. Drain
    // once more after joining it so no invalidation process survives teardown.
    state
        .git_runtime
        .cancel_window_and_wait(window_label, Duration::from_secs(5))?;

    let terminals = state
        .terminal_lifecycle
        .retire_window(&state.terminals, window_label)
        .map_err(|error| format!("Unable to collect terminals: {error}"))?;
    let (failed, result) = terminal::stop_terminal_sessions(terminals);
    if !failed.is_empty() {
        let mut sessions = state
            .terminals
            .lock()
            .map_err(|_| "Unable to restore failed terminal sessions.".to_string())?;
        for (session_id, terminal) in failed {
            sessions.insert(session_id, terminal);
        }
    }
    result.map_err(|error| format!("Unable to stop terminal sessions: {error}"))
}

#[cfg(test)]
mod window_cleanup_tests {
    use super::{
        join_thread_until, plan_window_cleanup, run_window_cleanup, AppState, WindowCleanupRegistry,
    };
    use crate::lsp_manager::LspState;
    use crate::terminal;
    use std::time::{Duration, Instant};

    #[test]
    fn cleanup_plan_extracts_only_the_destroyed_windows_resources_without_stopping() {
        let state = AppState::default();
        let lsp_state = LspState::default();
        let owned = terminal::test_terminal_session("main");
        let other = terminal::test_terminal_session("other");
        state
            .terminals
            .lock()
            .unwrap()
            .insert("main-1".to_string(), owned.clone());
        state
            .terminals
            .lock()
            .unwrap()
            .insert("other-1".to_string(), other.clone());

        let plan = plan_window_cleanup(&state, &lsp_state.manager, "main");

        assert_eq!(plan.window_label, "main");
        assert_eq!(plan.terminals.len(), 1);
        assert_eq!(plan.terminals[0].0, "main-1");
        assert!(std::sync::Arc::ptr_eq(&plan.terminals[0].1, &owned));
        assert!(!plan.is_empty());
        // Planning only extracts; the sessions are removed from the table but
        // not stopped yet.
        assert!(!state.terminals.lock().unwrap().contains_key("main-1"));
        assert!(state.terminals.lock().unwrap().contains_key("other-1"));
        assert!(!owned.is_stop_requested());
        assert!(!other.is_stop_requested());

        // Executing the plan stops the extracted session and leaves the other
        // window's session untouched.
        run_window_cleanup(plan);
        assert!(owned.is_stop_requested());
        assert!(!other.is_stop_requested());
        let terminals = state.terminals.lock().unwrap();
        assert!(!terminals.contains_key("main-1"));
        assert!(terminals.contains_key("other-1"));
    }

    #[test]
    fn empty_window_produces_an_empty_plan() {
        let state = AppState::default();
        let lsp_state = LspState::default();

        let plan = plan_window_cleanup(&state, &lsp_state.manager, "nothing");

        assert!(plan.is_empty());
        assert!(plan.terminals.is_empty());
    }

    #[test]
    fn join_thread_until_returns_false_after_the_deadline() {
        let handle = std::thread::spawn(|| std::thread::sleep(Duration::from_secs(30)));
        assert!(!join_thread_until(handle, Instant::now()));
    }

    #[test]
    fn registry_prunes_finished_handles_when_tracking() {
        let registry = WindowCleanupRegistry::default();
        let finished = std::thread::spawn(|| ());
        while !finished.is_finished() {
            std::hint::spin_loop();
        }
        let running = std::thread::spawn(|| std::thread::sleep(Duration::from_secs(30)));
        registry.track(finished);
        registry.track(running);
        let handles = registry.handles.lock().unwrap();
        assert_eq!(handles.len(), 1);
        assert!(!handles[0].is_finished());
    }
}

fn secondary_launch_workspace(args: &[String], cwd: &Path) -> Result<Option<String>, String> {
    let Some(argument) = args.get(1) else {
        return Ok(None);
    };
    let path = PathBuf::from(argument);
    let path = if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    };
    existing_workspace_path(&wire_path(&path))
        .and_then(|path| checked_wire_path(&path))
        .map(Some)
}

#[cfg(test)]
mod secondary_launch_tests {
    use super::*;

    #[test]
    fn resolves_relative_workspace_against_the_second_process_cwd() {
        let root = std::env::temp_dir().join(format!("pude-launch-{}", Uuid::new_v4()));
        let workspace = root.join("空白 folder # & %");
        fs::create_dir_all(&workspace).unwrap();
        let args = vec!["pude".to_string(), "空白 folder # & %".to_string()];
        let resolved = secondary_launch_workspace(&args, &root).unwrap().unwrap();
        assert_eq!(
            decode_wire_path(&resolved),
            fs::canonicalize(&workspace).unwrap()
        );
        let absolute_args = vec!["pude".to_string(), workspace.to_string_lossy().to_string()];
        assert_eq!(
            secondary_launch_workspace(&absolute_args, Path::new("unrelated")).unwrap(),
            Some(resolved)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn accepts_empty_launch_and_rejects_missing_workspaces() {
        assert_eq!(
            secondary_launch_workspace(&["pude".to_string()], Path::new(".")),
            Ok(None)
        );
        let missing = std::env::temp_dir().join(format!("pude-missing-{}", Uuid::new_v4()));
        assert!(secondary_launch_workspace(
            &["pude".to_string(), missing.to_string_lossy().to_string()],
            Path::new(".")
        )
        .is_err());
    }
}

#[tauri::command(async)]
async fn startup_folder(window: tauri::WebviewWindow) -> Option<String> {
    let window_url = window.url().ok();
    let has_workspace_query = window_url
        .as_ref()
        .is_some_and(|url| url.query_pairs().any(|(key, _)| key == "workspace"));
    let window_workspace = window_url.and_then(|url| {
        url.query_pairs()
            .find(|(key, _)| key == "workspace")
            .map(|(_, value)| decode_wire_path(value.as_ref()))
    });
    let command_line_workspace = if has_workspace_query {
        None
    } else {
        std::env::args_os().nth(1).map(PathBuf::from)
    };
    let candidate = window_workspace.or(command_line_workspace)?;
    // Directory checks are blocking filesystem work; keep them off the async
    // runtime worker.
    tauri::async_runtime::spawn_blocking(move || candidate.is_dir().then(|| wire_path(&candidate)))
        .await
        .unwrap_or(None)
}

#[tauri::command(async)]
fn mark_window_shown(window: tauri::WebviewWindow) -> Result<(), String> {
    let guard = window_visibility_registry().get(window.label());
    if guard
        .reveal(|| window.show())
        .map_err(|error| error.to_string())?
    {
        startup_timeline::record_window_shown();
    }
    Ok(())
}

#[tauri::command(async)]
fn log_frontend_error(message: String, source: Option<String>) {
    app_log::log_frontend_diagnostic(&message, source.as_deref());
}

#[tauri::command(async)]
fn get_startup_timing() -> Vec<startup_timeline::StartupTimingEntry> {
    // Startup measurements read the local log after invoking this command; refresh the
    // native milestones there when the perf log is enabled.
    startup_timeline::write_perf_log();
    startup_timeline::collect()
}

#[tauri::command(async)]
fn report_startup_event(name: String, at_ms: f64) {
    if !app_log::perf_log_enabled() {
        return;
    }
    let name = name.chars().take(128).collect::<String>();
    app_log::perf_log(&format!("startup frontend {name} @ {at_ms:.1} ms"));
}

// SB-02: the LSP commands live in `lsp_manager` and several perform blocking
// filesystem work (canonicalize/metadata) or wait for session shutdown (up to
// 8 s). Tauri runs plain `#[tauri::command]` handlers on the main thread, so
// these async wrappers move that work onto the blocking thread pool while
// keeping the command names, return types, and error strings unchanged. The
// `lsp_manager` functions remain registered nowhere and are still called
// directly as plain functions.
async fn run_lsp_blocking<T, F>(action: &'static str, task: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("Unable to {action}. {error}"))?
}

#[tauri::command(async, rename = "lsp_resolve_server")]
async fn lsp_resolve_server_async(
    request: lsp_manager::LspResolveRequest,
) -> Result<lsp_manager::LspResolvedServer, String> {
    run_lsp_blocking("resolve the LSP server", move || {
        lsp_manager::lsp_resolve_server(request)
    })
    .await
}

#[tauri::command(async, rename = "lsp_approve_server")]
async fn lsp_approve_server_async(
    state: State<'_, lsp_manager::LspState>,
    grant: lsp_manager::LspApprovalGrant,
) -> Result<(), String> {
    let manager = state.manager.clone();
    run_lsp_blocking("approve the LSP server", move || manager.approve(grant)).await
}

#[tauri::command(async, rename = "lsp_revoke_server")]
async fn lsp_revoke_server_async(
    state: State<'_, lsp_manager::LspState>,
    plugin_id: String,
    plugin_version: String,
    workspace_root: String,
    server_id: String,
    language: String,
) -> Result<(), String> {
    let manager = state.manager.clone();
    run_lsp_blocking("revoke the LSP server", move || {
        manager.revoke(
            &plugin_id,
            &plugin_version,
            &workspace_root,
            &server_id,
            &language,
        )
    })
    .await
}

#[tauri::command(async, rename = "lsp_start_server")]
async fn lsp_start_server_async(
    window: tauri::WebviewWindow,
    state: State<'_, lsp_manager::LspState>,
    quit_gate: State<'_, QuitGateState>,
    request: lsp_manager::LspServerRequest,
    events: tauri::ipc::Channel<lsp_manager::LspEvent>,
) -> Result<(), String> {
    let admission = quit_gate.admit_resource_operation(window.label())?;
    let admission = Arc::new(Mutex::new(Some(admission)));
    let sink: lsp_manager::LspEventSink = Arc::new(move |event| {
        if matches!(&event, lsp_manager::LspEvent::State { state, .. }
            if matches!(state.as_str(), "started" | "startFailed" | "stopped"))
        {
            admission
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
        }
        let _ = events.send(event);
    });
    let manager = state.manager.clone();
    let owner_window = window.label().to_string();
    run_lsp_blocking("start the LSP server", move || {
        manager.start(request, &owner_window, sink)
    })
    .await
}

#[tauri::command(async, rename = "lsp_send_message")]
async fn lsp_send_message_async(
    window: tauri::WebviewWindow,
    quit_gate: State<'_, QuitGateState>,
    state: State<'_, lsp_manager::LspState>,
    request: lsp_manager::LspMessageRequest,
) -> Result<(), String> {
    // Lock acquisition plus a bounded try_send: safe to run on the async
    // runtime without a blocking hop.
    let _admission = quit_gate.admit_resource_operation(window.label())?;
    state.manager.send(request, window.label())
}

#[tauri::command(async, rename = "lsp_cancel_request")]
async fn lsp_cancel_request_async(
    window: tauri::WebviewWindow,
    quit_gate: State<'_, QuitGateState>,
    state: State<'_, lsp_manager::LspState>,
    request: lsp_manager::LspCancelRequest,
) -> Result<(), String> {
    let _admission = quit_gate.admit_resource_operation(window.label())?;
    state.manager.cancel(request, window.label())
}

#[tauri::command(async, rename = "lsp_stop_server")]
async fn lsp_stop_server_async(
    window: tauri::WebviewWindow,
    state: State<'_, lsp_manager::LspState>,
    plugin_id: String,
    plugin_version: String,
    workspace_root: String,
    language: String,
) -> Result<(), String> {
    let manager = state.manager.clone();
    let owner_window = window.label().to_string();
    run_lsp_blocking("stop the LSP server", move || {
        manager.stop(
            &plugin_id,
            &plugin_version,
            &workspace_root,
            &language,
            &owner_window,
        )
    })
    .await
}

#[tauri::command(async, rename = "lsp_stop_plugin")]
async fn lsp_stop_plugin_async(
    state: State<'_, lsp_manager::LspState>,
    plugin_id: String,
) -> Result<(), String> {
    let manager = state.manager.clone();
    run_lsp_blocking("stop the plugin LSP servers", move || {
        manager.stop_plugin(&plugin_id)
    })
    .await
}

#[tauri::command(async, rename = "lsp_stop_workspace")]
async fn lsp_stop_workspace_async(
    window: tauri::WebviewWindow,
    state: State<'_, lsp_manager::LspState>,
    workspace_root: String,
) -> Result<(), String> {
    let manager = state.manager.clone();
    let owner_window = window.label().to_string();
    run_lsp_blocking("stop the workspace LSP servers", move || {
        manager.stop_workspace_for_window(&workspace_root, &owner_window)
    })
    .await
}

fn main() {
    startup_timeline::init();
    // SB-05: retain only source location and thread name. The default hook
    // includes the arbitrary panic payload, which may contain private data.
    std::panic::set_hook(Box::new(|info| {
        let thread = std::thread::current();
        let thread_name = thread.name().unwrap_or("unknown");
        let location = info
            .location()
            .map(|location| (location.file(), location.line()));
        app_log::log_panic(thread_name, location);
    }));
    #[cfg(windows)]
    if lsp_manager::run_bootstrap_if_requested() {
        return;
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let app = app.clone();
            // WebView2 creation must run off the UI thread. Tauri's builder
            // waits for a callback which needs that thread to keep dispatching.
            tauri::async_runtime::spawn_blocking(move || {
                let workspace = match secondary_launch_workspace(&args, Path::new(&cwd)) {
                    Ok(workspace) => workspace,
                    Err(error) => {
                        app_log::log_error(&error);
                        None
                    }
                };
                #[cfg(target_os = "macos")]
                if workspace.is_none() {
                    let existing = app
                        .get_webview_window("main")
                        .or_else(|| app.webview_windows().into_values().next());
                    if let Some(window) = existing {
                        let _ = app.show();
                        if window.is_minimized().unwrap_or(false) {
                            let _ = window.unminimize();
                        }
                        if !window.is_visible().unwrap_or(true) {
                            let _ = window.show();
                        }
                        return;
                    }
                }
                if let Err(error) = create_editor_window(&app, workspace.as_deref()) {
                    app_log::log_error(&error);
                }
            });
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .manage(lsp_manager::LspState::default())
        .manage(WindowCleanupRegistry::default())
        .manage(QuitGateState::default())
        .manage(app_update::UpdateState::default())
        .setup(|app| {
            startup_timeline::mark_setup_done();
            if let Ok(dir) = app.path().app_log_dir() {
                app_log::init(dir);
            }
            #[cfg(target_os = "macos")]
            macos_quit::install(app.handle().clone()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler({
            let handler: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> =
                Box::new(tauri::generate_handler![
                    startup_folder,
                    open_folder_dialog,
                    open_file_dialog,
                    save_file_dialog,
                    open_new_window,
                    filesystem::list_directory,
                    filesystem::cancel_directory_listing,
                    filesystem::read_file,
                    filesystem::read_workspace_image,
                    filesystem::path_exists,
                    filesystem::stat_files,
                    filesystem::save_file,
                    filesystem::save_file_as,
                    filesystem::inspect_save_as_destination,
                    filesystem::create_file,
                    filesystem::create_directory,
                    filesystem::rename_path,
                    filesystem::delete_path,
                    git_status,
                    get_git_ignored_paths,
                    git_branches,
                    git_commits,
                    cancel_workspace,
                    git_operation,
                    create_git_worktree,
                    git_diff,
                    git_commit_diff,
                    git_commit_files,
                    watch_workspace,
                    watcher::stop_watcher,
                    terminal::terminal_start,
                    terminal::terminal_write,
                    terminal::terminal_kill,
                    terminal::terminal_resize,
                    terminal::terminal_ack_output,
                    reveal_in_file_manager,
                    app_update::check_for_update,
                    app_update::download_update,
                    app_update::restart_to_update,
                    plugin_installer::inspect_plugin_dialog,
                    plugin_installer::recover_plugin_updates,
                    plugin_installer::commit_plugin_install,
                    plugin_installer::cancel_plugin_install,
                    plugin_installer::rollback_plugin_update,
                    plugin_installer::uninstall_plugin,
                    plugin_installer::retry_plugin_cleanup,
                    plugin_installer::read_plugin_entry,
                    plugin_security::plugin_network_authorize,
                    plugin_security::plugin_network_request,
                    plugin_security::plugin_network_cancel,
                    plugin_security::plugin_network_revoke,
                    plugin_workspace::plugin_workspace_canonicalize,
                    plugin_workspace::plugin_git_diff,
                    plugin_workspace::plugin_workspace_list,
                    plugin_workspace::plugin_workspace_read_file,
                    plugin_workspace::plugin_workspace_file_info,
                    plugin_workspace::plugin_workspace_read_file_range,
                    plugin_workspace::plugin_workspace_release_file_read,
                    plugin_workspace::cancel_plugin_workspace_file_read,
                    plugin_workspace::plugin_workspace_write_file,
                    lsp_resolve_server_async,
                    lsp_approve_server_async,
                    lsp_revoke_server_async,
                    lsp_start_server_async,
                    lsp_send_message_async,
                    lsp_cancel_request_async,
                    lsp_stop_server_async,
                    lsp_stop_plugin_async,
                    lsp_stop_workspace_async,
                    mark_window_shown,
                    log_frontend_error,
                    get_startup_timing,
                    report_startup_event,
                    app_quit_events_ready,
                    app_quit_prepare_reply,
                    app_quit_commit_ready
                ]);
            move |invoke: tauri::ipc::Invoke<tauri::Wry>| -> bool {
                startup_timeline::record_first_command();
                handler(invoke)
            }
        })
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            app_log::log_error(&format!("Unable to start pude. {error}"));
            rfd::MessageDialog::new()
                .set_title("pude — startup error")
                .set_description(format!(
                    "pude could not start. The error was logged to the app log.\n\n{error}"
                ))
                .show();
            return;
        }
    };
    app.run(|app, event| match event {
        tauri::RunEvent::Ready => {
            for label in app.webview_windows().keys() {
                install_show_fallback_timer(app, label);
            }
        }
        tauri::RunEvent::Exit => {
            join_window_cleanups(&app.state::<WindowCleanupRegistry>());
            app_update::install_on_exit(app);
        }
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            handle_exit_requested(app, code, api);
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } => {
            window_visibility_registry().remove(&label);
            let quit_gate = app.state::<QuitGateState>();
            quit_gate.remove_window(&label);
            let should_start_cleanup = quit_gate.start_window_cleanup(&label);
            let (aborted, _) = quit_gate.window_destroyed(&label);
            if let Some((request_id, participants)) = aborted {
                emit_quit_abort_with_error(
                    app,
                    &request_id,
                    &participants,
                    Some("A window closed before every window approved app quit."),
                );
            }

            if should_start_cleanup {
                let cleanup_app = app.clone();
                let cleanup_label = label.clone();
                let cleanup = thread::Builder::new()
                    .name(format!("pude-window-cleanup-{cleanup_label}"))
                    .spawn(move || {
                        let cleanup_result = cleanup_window_resources_with_gate(
                            &cleanup_app.state::<AppState>(),
                            &cleanup_app.state::<lsp_manager::LspState>(),
                            &cleanup_app.state::<QuitGateState>(),
                            &cleanup_label,
                        );
                        if let Err(error) = cleanup_result {
                            eprintln!("Unable to clean up window {cleanup_label}: {error}");
                            cleanup_app
                                .state::<QuitGateState>()
                                .cleanup_failed(&cleanup_label);
                            return;
                        }
                        let no_windows = cleanup_app.webview_windows().is_empty();
                        let (should_exit, aborted) = cleanup_app
                            .state::<QuitGateState>()
                            .cleanup_completed(&cleanup_label, no_windows);
                        if should_exit {
                            cleanup_app.exit(0);
                        }
                        if let Some((request_id, participants)) = aborted {
                            emit_quit_abort_with_error(
                                &cleanup_app,
                                &request_id,
                                &participants,
                                Some("A window remained open after app quit was approved."),
                            );
                        }
                    });
                match cleanup {
                    Ok(handle) => app.state::<WindowCleanupRegistry>().track(handle),
                    Err(error) => {
                        eprintln!("Unable to schedule window cleanup for {label}: {error}");
                        quit_gate.cleanup_failed(&label);
                    }
                }
            } else {
                let (should_exit, aborted) =
                    quit_gate.cleanup_completed(&label, app.webview_windows().is_empty());
                if should_exit {
                    app.exit(0);
                }
                if let Some((request_id, participants)) = aborted {
                    emit_quit_abort_with_error(
                        app,
                        &request_id,
                        &participants,
                        Some("A window remained open after app quit was approved."),
                    );
                }
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod quit_gate_tests {
    use std::sync::Arc;
    use std::time::Duration;

    use super::{
        QuitCommitProgress, QuitDecision, QuitGateState, QuitPrepareProgress, QuitReadyProgress,
        QuitStart,
    };

    fn start_two_windows(gate: &QuitGateState) -> String {
        assert!(matches!(
            gate.events_ready("main"),
            QuitReadyProgress::Ignored
        ));
        assert!(matches!(
            gate.events_ready("secondary"),
            QuitReadyProgress::Ignored
        ));
        match gate.begin(["main".to_string(), "secondary".to_string()]) {
            QuitStart::Started { request_id, .. } => request_id,
            _ => panic!("expected a new quit request"),
        }
    }

    fn approve_two_windows(gate: &QuitGateState) -> String {
        let request_id = start_two_windows(gate);
        assert!(matches!(
            gate.prepare_reply(&request_id, "main", Some(QuitDecision::Save)),
            Ok(QuitPrepareProgress::Waiting)
        ));
        assert!(matches!(
            gate.prepare_reply(&request_id, "secondary", Some(QuitDecision::Discard)),
            Ok(QuitPrepareProgress::Commit { .. })
        ));
        request_id
    }

    #[test]
    fn prepare_is_not_emitted_until_every_window_registers_all_listeners() {
        let gate = QuitGateState::default();
        let QuitStart::Started {
            request_id,
            listeners_ready,
            ..
        } = gate.begin(["main".to_string(), "secondary".to_string()])
        else {
            panic!("expected a new quit request");
        };
        assert!(!listeners_ready);
        assert!(matches!(
            gate.events_ready("main"),
            QuitReadyProgress::Waiting
        ));
        assert!(matches!(
            gate.prepare_reply(&request_id, "main", Some(QuitDecision::Save)),
            Ok(QuitPrepareProgress::Ignored)
        ));
        assert!(matches!(
            gate.events_ready("secondary"),
            QuitReadyProgress::Prepare { .. }
        ));
        assert!(matches!(
            gate.prepare_reply(&request_id, "main", Some(QuitDecision::Save)),
            Ok(QuitPrepareProgress::Waiting)
        ));
    }

    #[test]
    fn duplicate_requests_coalesce_and_cancel_resets_for_retry() {
        let gate = QuitGateState::default();
        let first_request = start_two_windows(&gate);
        assert!(matches!(
            gate.begin(["main".to_string(), "secondary".to_string()]),
            QuitStart::AlreadyPending
        ));
        assert!(matches!(
            gate.prepare_reply(&first_request, "main", Some(QuitDecision::Save)),
            Ok(QuitPrepareProgress::Waiting)
        ));
        assert!(matches!(
            gate.prepare_reply(&first_request, "secondary", None),
            Ok(QuitPrepareProgress::Aborted { .. })
        ));
        assert!(matches!(
            gate.prepare_reply(&first_request, "main", Some(QuitDecision::Save)),
            Ok(QuitPrepareProgress::Ignored)
        ));

        let retry_request = start_two_windows(&gate);
        assert_ne!(first_request, retry_request);
    }

    #[test]
    fn precleaned_windows_complete_exit_only_after_every_destroyed_event_and_no_live_windows() {
        let gate = QuitGateState::default();
        let request_id = approve_two_windows(&gate);
        assert!(matches!(
            gate.commit_ready(&request_id, "main"),
            Ok(QuitCommitProgress::Waiting)
        ));
        assert!(matches!(
            gate.commit_ready(&request_id, "secondary"),
            Ok(QuitCommitProgress::Cleanup { .. })
        ));
        gate.close_resource_admission(&request_id, &["main".to_string(), "secondary".to_string()])
            .expect("cleanup should close resource admission");
        gate.finish_cleanup(&request_id)
            .expect("all native resources should be clean");

        assert!(!gate.start_window_cleanup("main"));
        assert_eq!(gate.window_destroyed("main"), (None, false));
        assert_eq!(gate.cleanup_completed("main", false), (false, None));
        assert!(!gate.take_exit_permit());

        assert!(!gate.start_window_cleanup("secondary"));
        assert_eq!(gate.window_destroyed("secondary"), (None, false));
        assert_eq!(gate.cleanup_completed("secondary", true), (true, None));
        assert!(gate.take_exit_permit());
        assert!(!gate.take_exit_permit());
    }

    #[test]
    fn cleanup_failure_with_no_windows_never_grants_exit_permit() {
        let gate = QuitGateState::default();
        assert!(matches!(
            gate.begin(Vec::<String>::new()),
            QuitStart::NoWindows
        ));
        assert!(gate.start_window_cleanup("main"));
        assert!(!gate.exit_after_window_cleanup());
        gate.cleanup_failed("main");
        assert!(!gate.take_exit_permit());
        assert!(matches!(
            gate.begin(Vec::<String>::new()),
            QuitStart::NoWindows
        ));
        assert!(!gate.exit_after_window_cleanup());
        assert!(!gate.take_exit_permit());

        // A later no-window retry can exit only after the failed resources
        // have actually cleaned successfully.
        assert_eq!(gate.cleanup_completed("main", true), (true, None));
        assert!(gate.take_exit_permit());
    }

    #[test]
    fn quit_decision_preserve_round_trips_without_discarding() {
        assert_eq!(QuitDecision::parse("preserve"), Ok(QuitDecision::Preserve));
        assert_eq!(QuitDecision::Preserve.as_str(), "preserve");
        assert_ne!(QuitDecision::Preserve, QuitDecision::Discard);
    }

    #[test]
    fn app_quit_retries_native_cleanup_left_by_a_previously_closed_window() {
        let gate = QuitGateState::default();
        let request_id = approve_two_windows(&gate);
        gate.commit_ready(&request_id, "main").unwrap();
        gate.commit_ready(&request_id, "secondary").unwrap();
        gate.close_resource_admission(&request_id, &["main".to_string(), "secondary".to_string()])
            .unwrap();

        gate.cleanup_failed("already-closed");
        assert!(gate.finish_cleanup(&request_id).is_err());
        assert!(!gate.take_exit_permit());

        gate.cleanup_succeeded("already-closed");
        gate.finish_cleanup(&request_id)
            .expect("app quit can continue after the old cleanup succeeds");
    }

    #[test]
    fn app_quit_waits_for_in_progress_normal_window_cleanup_before_retrying() {
        let gate = Arc::new(QuitGateState::default());
        assert!(gate.start_window_cleanup("already-closed"));

        let cleanup_gate = Arc::clone(&gate);
        let cleanup = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(5));
            cleanup_gate.cleanup_failed("already-closed");
        });

        gate.wait_for_pending_cleanup(Duration::from_secs(1))
            .expect("the normal close cleanup should complete or fail within the bound");
        cleanup.join().expect("cleanup worker should finish");
        assert_eq!(gate.failed_cleanup_windows(), ["already-closed"]);
    }

    #[test]
    fn repeated_no_window_quit_requests_coalesce_failed_cleanup_retries() {
        let gate = QuitGateState::default();
        gate.cleanup_failed("already-closed");
        assert!(matches!(
            gate.begin(Vec::<String>::new()),
            QuitStart::NoWindows
        ));
        assert!(!gate.exit_after_window_cleanup());

        assert_eq!(
            gate.claim_failed_cleanup_retries(),
            vec!["already-closed".to_string()]
        );
        assert_eq!(gate.claim_failed_cleanup_retries(), Vec::<String>::new());
        assert_eq!(
            gate.failed_cleanup_windows(),
            vec!["already-closed".to_string()]
        );

        // A failed attempt releases its claim but keeps the failure marker, so
        // a later Cmd+Q can retry it without overlapping the first worker.
        gate.cleanup_failed("already-closed");
        assert!(matches!(
            gate.begin(Vec::<String>::new()),
            QuitStart::NoWindows
        ));
        assert!(!gate.exit_after_window_cleanup());
        assert_eq!(
            gate.claim_failed_cleanup_retries(),
            vec!["already-closed".to_string()]
        );
        assert_eq!(gate.claim_failed_cleanup_retries(), Vec::<String>::new());
        assert_eq!(gate.cleanup_completed("already-closed", true), (true, None));
    }

    #[test]
    fn no_window_exit_claim_blocks_window_creation_until_the_exit_decision() {
        let gate = QuitGateState::default();
        assert!(matches!(
            gate.begin(Vec::<String>::new()),
            QuitStart::NoWindows
        ));
        assert!(gate.reserve_window_creation().is_err());
        assert!(gate.exit_after_window_cleanup());
        assert!(gate.take_exit_permit());
    }

    #[test]
    fn stale_no_window_snapshot_promotes_to_a_live_window_quit_request() {
        let gate = QuitGateState::default();
        assert!(matches!(
            gate.begin(Vec::<String>::new()),
            QuitStart::NoWindows
        ));

        // The app-level recheck found a live window after the empty snapshot.
        gate.cancel_no_window_exit();
        assert!(matches!(
            gate.begin(["created-during-snapshot".to_string()]),
            QuitStart::Started { .. }
        ));
        assert!(gate.reserve_window_creation().is_err());
    }

    #[test]
    fn quit_waits_for_a_window_creation_already_reserved_before_the_empty_snapshot() {
        let gate = QuitGateState::default();
        gate.reserve_window_creation()
            .expect("window creation started before the quit request");
        assert!(matches!(
            gate.begin(Vec::<String>::new()),
            QuitStart::WindowCreationInFlight
        ));
        assert!(gate.finish_window_creation());
        assert!(matches!(
            gate.begin(["created-before-quit".to_string()]),
            QuitStart::Started { .. }
        ));
    }

    #[test]
    fn resource_admission_closes_atomically_and_waits_for_existing_operations() {
        let gate = QuitGateState::default();
        let request_id = approve_two_windows(&gate);
        let operation = gate
            .admit_resource_operation("main")
            .expect("window is active before commit-ready");
        gate.commit_ready(&request_id, "main").unwrap();
        gate.commit_ready(&request_id, "secondary").unwrap();
        assert!(gate.admit_resource_operation("main").is_err());
        gate.close_resource_admission(&request_id, &["main".to_string(), "secondary".to_string()])
            .unwrap();
        assert!(gate
            .wait_for_resource_operations("main", Duration::from_millis(1))
            .is_err());
        drop(operation);
        gate.wait_for_resource_operations("main", Duration::from_millis(20))
            .unwrap();
    }

    #[test]
    fn destroyed_window_labels_stay_blocked_while_other_windows_remain_active() {
        let gate = QuitGateState::default();
        gate.admit_resource_operation("live")
            .expect("another live window remains admissible");
        gate.remove_window("destroyed");
        assert!(gate.admit_resource_operation("destroyed").is_err());
        assert!(gate.start_window_cleanup("destroyed"));
        assert_eq!(gate.cleanup_completed("destroyed", false), (false, None));
        assert!(gate.admit_resource_operation("destroyed").is_err());
        gate.admit_resource_operation("live")
            .expect("cleanup for one window does not block its surviving sibling");
    }

    #[test]
    fn normal_destroy_cleanup_waits_for_admitted_operations_before_exit() {
        let gate = QuitGateState::default();
        let operation = gate
            .admit_resource_operation("main")
            .expect("window is active before destruction");
        gate.remove_window("main");
        assert!(gate.start_window_cleanup("main"));
        assert!(matches!(
            gate.begin(Vec::<String>::new()),
            QuitStart::NoWindows
        ));
        assert!(!gate.exit_after_window_cleanup());
        assert!(gate
            .wait_for_resource_operations("main", Duration::from_millis(1))
            .is_err());
        assert!(!gate.take_exit_permit());

        drop(operation);
        gate.wait_for_resource_operations("main", Duration::from_millis(20))
            .unwrap();
        assert_eq!(gate.cleanup_completed("main", true), (true, None));
        assert!(gate.take_exit_permit());
    }

    #[test]
    fn a_closed_participant_before_commit_aborts_the_request() {
        let gate = QuitGateState::default();
        let request_id = start_two_windows(&gate);
        let (aborted, should_exit) = gate.window_destroyed("main");
        assert!(!should_exit);
        assert_eq!(
            aborted.map(|(id, labels)| (id, labels.len())),
            Some((request_id, 2))
        );
    }
}

#[cfg(all(test, unix))]
mod path_wire_tests {
    use super::{decode_wire_path, wire_path, WIRE_PATH_MARKER};
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;
    use std::path::PathBuf;

    #[test]
    fn invalid_utf8_components_round_trip_without_changing_separators() {
        let original = PathBuf::from(OsString::from_vec(
            b"/tmp/pude-invalid-\xff/file\xfe.ts".to_vec(),
        ));
        let encoded = wire_path(&original);

        assert!(encoded.contains(WIRE_PATH_MARKER));
        assert!(encoded.starts_with("/tmp/"));
        assert_eq!(decode_wire_path(&encoded), original);
    }

    #[test]
    fn marker_like_names_are_escaped() {
        let original = PathBuf::from(format!("/tmp/{WIRE_PATH_MARKER}literal"));
        let encoded = wire_path(&original);

        assert_ne!(encoded, original.to_string_lossy());
        assert_eq!(decode_wire_path(&encoded), original);
    }
}

#[cfg(all(test, windows))]
mod windows_path_tests {
    use super::checked_wire_path;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::path::Path;

    #[test]
    fn unpaired_surrogate_path_returns_a_recognizable_error() {
        let path = OsString::from_wide(&[b'C' as u16, b':' as u16, b'\\' as u16, 0xd800]);
        let error = checked_wire_path(Path::new(&path))
            .expect_err("an unpaired UTF-16 surrogate cannot be represented by the editor");

        assert!(error.contains("cannot be represented by the editor"));
    }
}

#[cfg(test)]
mod save_lock_tests {
    use super::path_lock;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::mpsc::sync_channel;
    use std::sync::{Arc, Mutex, Weak};

    #[test]
    fn dead_path_locks_are_reaped_without_replacing_live_lock() {
        let locks = Mutex::new(HashMap::<PathBuf, Weak<Mutex<()>>>::new());
        let path = PathBuf::from("pude-test-live-file");
        let owner = path_lock(&locks, &path).expect("first lock should be created");
        let owner_guard = owner.lock().expect("owner should lock the path");
        let (waiter_ready_sender, waiter_ready_receiver) = sync_channel(0);
        let (waiter_locked_sender, waiter_locked_receiver) = sync_channel(0);
        let waiter_locks = Arc::new(locks);
        let waiter_registry = Arc::clone(&waiter_locks);
        let owner_for_thread = Arc::clone(&owner);
        let waiter_path = path.clone();
        let waiter = std::thread::spawn(move || {
            let waiter =
                path_lock(&waiter_registry, &waiter_path).expect("waiter should reuse the path");
            assert!(Arc::ptr_eq(&owner_for_thread, &waiter));
            waiter_ready_sender
                .send(())
                .expect("main test should still be listening");
            let waiter_guard = waiter.lock().expect("waiter should lock the shared path");
            waiter_locked_sender
                .send(())
                .expect("main test should observe waiter");
            drop(waiter_guard);
            waiter
        });
        waiter_ready_receiver
            .recv()
            .expect("waiter should register while owner is active");

        for index in 0..256 {
            let stale_path = PathBuf::from(format!("pude-test-stale-{index}"));
            let stale =
                path_lock(&waiter_locks, &stale_path).expect("stale lock should be created");
            drop(stale);
        }
        let live = path_lock(&waiter_locks, &path).expect("live path should still be registered");
        assert!(Arc::ptr_eq(&owner, &live));
        let registry = waiter_locks.lock().expect("registry should be available");
        assert_eq!(
            registry.len(),
            1,
            "dead path entries should be reaped in one pass"
        );
        assert!(registry.contains_key(&path));
        drop(registry);
        drop(live);
        drop(owner_guard);
        waiter_locked_receiver
            .recv()
            .expect("waiter should acquire the path after owner releases it");
        let waiter = waiter.join().expect("waiter should exit cleanly");
        assert!(Arc::ptr_eq(&owner, &waiter));
        drop(waiter);
        drop(owner);
    }
}
