//! Workspace file watcher: notify-based watch sessions, debounce and
//! pending-change reconciliation, root loss/recovery tracking, and git
//! invalidation. Extracted from main.rs. Shared helpers (wire paths,
//! path comparison, git runtime, file identity) stay in main.rs and are used
//! via `crate::` paths.

use notify::event::{ModifyKind, RenameMode};
use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::State;

use crate::blocking::BlockingClass;
#[cfg(test)]
use crate::git_read_shared;
use crate::git_runtime::{CancellationToken, GitCoordinator, GitDirtyScope};
#[cfg(test)]
use crate::git_runtime::{GitErrorKind, GitReadKind};
use crate::{
    checked_wire_path, decode_wire_path, is_windows_reparse_point, normalize_watch_path, path_eq,
    path_file_identity, run_blocking, wire_path, AppState, FileIdentity,
};
#[cfg(test)]
use std::ffi::OsString;
#[cfg(test)]
use uuid::Uuid;

pub(crate) const WATCHER_CHANNEL_CAPACITY: usize = 256;
const MAX_PENDING_WATCH_CHANGES: usize = 512;
const WATCH_DEBOUNCE: Duration = Duration::from_millis(180);
// While idle, root reconciliation only needs to catch roots whose
// delete/recreate events were somehow missed; the recovery parent is watched
// non-recursively, so those events normally arrive on the channel and trigger
// an immediate reconcile. A 1 s idle cadence is enough and cuts the per-window
// idle wakeups from 10/s to 1/s.
const WATCH_ROOT_RECONCILE_IDLE: Duration = Duration::from_millis(1000);

#[cfg(test)]
thread_local! {
    static IDLE_TIMEOUTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
const MAX_WATCHER_STOP_WAIT: Duration = Duration::from_secs(2);
const WATCHER_STOP_POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum FileChangeKind {
    Create,
    Remove,
    Rename,
    Modify,
    Rescan,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WatchRootKind {
    Workspace,
    Worktree,
    GitDir,
    CommonDir,
    External,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum GitScope {
    Worktree,
    Index,
    Refs,
    Head,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WatchRoot {
    path: String,
    kind: WatchRootKind,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct FileChange {
    kind: FileChangeKind,
    path: String,
    old_path: Option<String>,
    is_directory: Option<bool>,
    source: Option<WatchRootKind>,
    git_scopes: Vec<GitScope>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileChangedEvent {
    session_id: String,
    sequence: u64,
    paths: Vec<String>,
    changes: Vec<FileChange>,
    needs_rescan: bool,
    error: Option<String>,
    watch_roots: Vec<WatchRoot>,
}

pub(crate) enum WatcherMessage {
    Event(notify::Result<Event>),
    Stop,
}

pub(crate) struct WatcherSession {
    pub(crate) session_id: String,
    pub(crate) control: SyncSender<WatcherMessage>,
    pub(crate) stop_requested: Arc<AtomicBool>,
    pub(crate) finished: Arc<AtomicBool>,
}

#[derive(Clone)]
pub(crate) struct WatcherConfig {
    pub(crate) workspace: PathBuf,
    pub(crate) watch_roots: Vec<WatchRootPath>,
    pub(crate) git_dir: Option<PathBuf>,
    pub(crate) common_dir: Option<PathBuf>,
    pub(crate) repository_root: Option<PathBuf>,
    pub(crate) git_runtime: GitCoordinator,
    pub(crate) excludes: Vec<PathBuf>,
    pub(crate) open_files: Vec<PathBuf>,
}

pub(crate) struct WatchRootRegistration {
    pub(crate) path: PathBuf,
    pub(crate) attached: bool,
    pub(crate) failure_reported: bool,
    pub(crate) identity: Option<FileIdentity>,
}

#[derive(Clone)]
pub(crate) struct WatchRootPath {
    pub(crate) path: PathBuf,
    pub(crate) kind: WatchRootKind,
}

#[tauri::command]
pub(crate) async fn stop_watcher(
    window: tauri::WebviewWindow,
    session_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let watchers = Arc::clone(&state.watchers);
    run_blocking(
        "Unable to stop file watcher",
        BlockingClass::Misc,
        move || stop_watcher_sync(window, session_id, watchers),
    )
    .await
}

fn stop_watcher_sync(
    window: tauri::WebviewWindow,
    session_id: Option<String>,
    watchers: Arc<Mutex<HashMap<String, WatcherSession>>>,
) -> Result<(), String> {
    let window_label = window.label().to_string();
    let session = {
        let mut watchers = watchers
            .lock()
            .map_err(|_| "Unable to lock watcher state.".to_string())?;
        let should_remove = session_id.as_ref().is_none_or(|expected| {
            watchers
                .get(&window_label)
                .is_some_and(|current| &current.session_id == expected)
        });
        if should_remove {
            watchers.remove(&window_label)
        } else {
            None
        }
    };
    if let Some(session) = session {
        stop_watcher_session(&session);
    }
    Ok(())
}

pub(crate) fn stop_watcher_session(session: &WatcherSession) {
    session.stop_requested.store(true, Ordering::Release);
    // The receiver also polls stop_requested, so stopping never waits behind
    // a full event queue. A best-effort wake-up makes the common path instant.
    let _ = session.control.try_send(WatcherMessage::Stop);
}

pub(crate) fn stop_watcher_session_and_wait(
    session: &WatcherSession,
    timeout: Duration,
) -> Result<(), String> {
    stop_watcher_session(session);

    let wait = timeout.min(MAX_WATCHER_STOP_WAIT);
    let deadline = Instant::now() + wait;
    loop {
        if session.finished.load(Ordering::Acquire) {
            return Ok(());
        }

        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!(
                "Timed out waiting for the file watcher to stop after {} ms.",
                wait.as_millis()
            ));
        }
        std::thread::sleep(remaining.min(WATCHER_STOP_POLL_INTERVAL));
    }
}

#[derive(Default)]
struct PendingWatcherChanges {
    changes: BTreeMap<String, FileChange>,
    needs_rescan: bool,
    error: Option<String>,
    pending_rename_from: BTreeMap<usize, PathBuf>,
}

impl PendingWatcherChanges {
    fn add_result(&mut self, result: notify::Result<Event>, config: &WatcherConfig) {
        match result {
            Ok(event) => {
                for path in &event.paths {
                    if let Err(error) = checked_wire_path(path) {
                        self.needs_rescan = true;
                        self.set_error(error);
                    }
                }
                if event.need_rescan() {
                    self.flush_pending_renames(config);
                    self.needs_rescan = true;
                }
                if let EventKind::Modify(ModifyKind::Name(mode)) = &event.kind {
                    if matches!(mode, &RenameMode::Both) && event.paths.len() == 2 {
                        for change in classify_notify_event(&event, config) {
                            self.add_change(change);
                        }
                        return;
                    }
                    if event.paths.len() == 1 && matches!(mode, &RenameMode::From) {
                        if let Some(tracker) = event.tracker() {
                            if let Some(previous) = self
                                .pending_rename_from
                                .insert(tracker, event.paths[0].clone())
                            {
                                self.add_unpaired_rename(&previous, config);
                                self.needs_rescan = true;
                            }
                            if self.pending_rename_from.len() > MAX_PENDING_WATCH_CHANGES {
                                self.flush_pending_renames(config);
                            }
                        } else {
                            self.add_unpaired_rename(&event.paths[0], config);
                        }
                        return;
                    }
                    if event.paths.len() == 1 && matches!(mode, &RenameMode::To) {
                        if let Some(tracker) = event.tracker() {
                            if let Some(old_path) = self.pending_rename_from.remove(&tracker) {
                                if let Some(change) =
                                    classify_rename_pair(&old_path, &event.paths[0], config)
                                {
                                    self.add_change(change);
                                }
                            } else {
                                self.add_unpaired_rename(&event.paths[0], config);
                            }
                        } else {
                            self.add_unpaired_rename(&event.paths[0], config);
                        }
                        return;
                    }
                    self.flush_pending_renames(config);
                    self.needs_rescan = true;
                }
                for change in classify_notify_event(&event, config) {
                    self.add_change(change);
                }
            }
            Err(error) => {
                self.flush_pending_renames(config);
                self.needs_rescan = true;
                self.set_error(error.to_string());
            }
        }
    }

    fn add_change(&mut self, change: FileChange) {
        if change.kind == FileChangeKind::Rescan {
            self.needs_rescan = true;
        }
        if self.changes.contains_key(&change.path) {
            if let Some(existing) = self.changes.get_mut(&change.path) {
                merge_file_change(existing, change);
            }
            return;
        }
        if self.changes.len() >= MAX_PENDING_WATCH_CHANGES {
            self.needs_rescan = true;
            return;
        }
        self.changes.insert(change.path.clone(), change);
    }

    fn set_error(&mut self, message: impl AsRef<str>) {
        if self.error.is_none() {
            self.error = Some(message.as_ref().chars().take(1024).collect());
        }
    }

    fn record_root_rescan(&mut self, path: &Path, config: &WatcherConfig, error: Option<String>) {
        self.needs_rescan = true;
        if let Some(error) = error {
            self.set_error(error);
        }
        match checked_wire_path(path) {
            Ok(wire) => {
                let source = watch_source(path, config);
                self.add_change(FileChange {
                    kind: FileChangeKind::Rescan,
                    path: wire,
                    old_path: None,
                    is_directory: Some(path.is_dir()),
                    source,
                    git_scopes: git_scopes(path, source, config),
                });
            }
            Err(error) => self.set_error(error),
        }
    }

    fn has_work(&self) -> bool {
        self.needs_rescan
            || self.error.is_some()
            || !self.changes.is_empty()
            || !self.pending_rename_from.is_empty()
    }

    fn take_event(
        &mut self,
        session_id: &str,
        sequence: u64,
        config: &WatcherConfig,
    ) -> FileChangedEvent {
        self.flush_pending_renames(config);
        let changes: Vec<FileChange> = std::mem::take(&mut self.changes).into_values().collect();
        let mut paths = Vec::with_capacity(changes.len() * 2);
        for change in &changes {
            paths.push(change.path.clone());
            if let Some(old_path) = &change.old_path {
                paths.push(old_path.clone());
            }
        }
        paths.sort();
        paths.dedup();
        FileChangedEvent {
            session_id: session_id.to_string(),
            sequence,
            paths,
            changes,
            needs_rescan: self.needs_rescan,
            error: self.error.take(),
            watch_roots: config.watch_roots.iter().map(public_watch_root).collect(),
        }
    }

    fn flush_pending_renames(&mut self, config: &WatcherConfig) {
        let pending = std::mem::take(&mut self.pending_rename_from);
        if !pending.is_empty() {
            self.needs_rescan = true;
        }
        for path in pending.values() {
            self.add_unpaired_rename(path, config);
        }
    }

    fn add_unpaired_rename(&mut self, path: &Path, config: &WatcherConfig) {
        if let Some(change) = make_file_change(FileChangeKind::Rescan, path, None, config) {
            self.add_change(change);
        }
    }
}

fn consume_watcher_overflow(overflowed: &AtomicBool, pending: &mut PendingWatcherChanges) -> bool {
    if overflowed.swap(false, Ordering::AcqRel) {
        pending.needs_rescan = true;
        true
    } else {
        false
    }
}

fn reconcile_watcher_roots<W: Watcher>(
    watcher: &mut W,
    registrations: &mut [WatchRootRegistration],
    pending: &mut PendingWatcherChanges,
    config: &WatcherConfig,
) -> bool {
    let mut changed = false;
    for registration in registrations {
        let identity = watch_root_identity(&registration.path);
        match root_presence_transition(registration, identity.clone()) {
            Some(false) => {
                changed = true;
                let error = watcher.unwatch(&registration.path).err().map(|error| {
                    format!(
                        "Watched folder {} disappeared or was replaced, and its operating-system watch could not be removed cleanly: {error}",
                        registration.path.display()
                    )
                });
                let error = error.or_else(|| {
                    Some(format!(
                        "Watched folder {} disappeared or was replaced; waiting for it to return.",
                        registration.path.display()
                    ))
                });
                pending.record_root_rescan(&registration.path, config, error);
            }
            Some(true) => {
                let first_watch = watcher.watch(&registration.path, RecursiveMode::Recursive);
                let restored = if first_watch.is_ok() {
                    Ok(())
                } else {
                    let _ = watcher.unwatch(&registration.path);
                    watcher.watch(&registration.path, RecursiveMode::Recursive)
                };
                match restored {
                    Ok(()) => {
                        registration.attached = true;
                        registration.failure_reported = false;
                        registration.identity = identity;
                        pending.record_root_rescan(&registration.path, config, None);
                        changed = true;
                    }
                    Err(error) => {
                        if !registration.failure_reported {
                            pending.record_root_rescan(
                                &registration.path,
                                config,
                                Some(format!(
                                    "Unable to restore file watching for {}. {error}",
                                    registration.path.display()
                                )),
                            );
                            registration.failure_reported = true;
                            changed = true;
                        }
                    }
                }
            }
            None => {}
        }
    }
    changed
}

fn detach_roots_from_remove_event<W: Watcher>(
    watcher: &mut W,
    result: &notify::Result<Event>,
    registrations: &mut [WatchRootRegistration],
    pending: &mut PendingWatcherChanges,
    config: &WatcherConfig,
) -> bool {
    let Ok(event) = result else {
        return false;
    };
    let is_removal = matches!(&event.kind, EventKind::Remove(_))
        || matches!(
            &event.kind,
            EventKind::Modify(ModifyKind::Name(RenameMode::From | RenameMode::Both))
        );
    if !is_removal {
        return false;
    }
    let mut changed = false;
    for registration in registrations {
        if registration.attached
            && event
                .paths
                .iter()
                .any(|path| path_eq(path, &registration.path))
        {
            registration.attached = false;
            let _ = watcher.unwatch(&registration.path);
            registration.failure_reported = false;
            pending.record_root_rescan(
                &registration.path,
                config,
                Some(format!(
                    "Watched folder {} was removed or renamed; checking whether it returns.",
                    registration.path.display()
                )),
            );
            changed = true;
        }
    }
    changed
}

pub(crate) fn run_watcher<W: Watcher + Send>(
    watcher: W,
    receiver: Receiver<WatcherMessage>,
    events: Channel<FileChangedEvent>,
    config: WatcherConfig,
    session_id: String,
    stop_requested: Arc<AtomicBool>,
    overflowed: Arc<AtomicBool>,
    registrations: Vec<WatchRootRegistration>,
    request_token: CancellationToken,
    watchers: Arc<Mutex<HashMap<String, WatcherSession>>>,
) {
    run_watcher_loop(
        watcher,
        receiver,
        config,
        session_id,
        stop_requested,
        overflowed,
        registrations,
        request_token,
        watchers,
        move |event| {
            let _ = events.send(event);
        },
    );
}

fn run_watcher_loop<W, E>(
    mut watcher: W,
    receiver: Receiver<WatcherMessage>,
    config: WatcherConfig,
    session_id: String,
    stop_requested: Arc<AtomicBool>,
    overflowed: Arc<AtomicBool>,
    mut registrations: Vec<WatchRootRegistration>,
    request_token: CancellationToken,
    watchers: Arc<Mutex<HashMap<String, WatcherSession>>>,
    mut emit_event: E,
) where
    W: Watcher + Send,
    E: FnMut(FileChangedEvent),
{
    let mut pending = PendingWatcherChanges::default();
    let mut deadline: Option<Instant> = None;
    let mut sequence = 0_u64;
    let mut next_root_reconcile = Instant::now();

    loop {
        if stop_requested.load(Ordering::Acquire) || request_token.is_cancelled() {
            break;
        }
        if Instant::now() >= next_root_reconcile {
            if reconcile_watcher_roots(&mut watcher, &mut registrations, &mut pending, &config) {
                let root_deadline = Instant::now() + WATCH_DEBOUNCE;
                deadline =
                    Some(deadline.map_or(root_deadline, |current| current.min(root_deadline)));
            }
            next_root_reconcile = Instant::now() + WATCH_ROOT_RECONCILE_IDLE;
        }
        let message = match deadline {
            Some(deadline_at) => match receiver
                .recv_timeout(deadline_at.saturating_duration_since(Instant::now()))
            {
                Ok(message) => Some(message),
                Err(RecvTimeoutError::Timeout) => {
                    drain_watcher_messages(&receiver, &mut pending, &config);
                    let _ = reconcile_watcher_roots(
                        &mut watcher,
                        &mut registrations,
                        &mut pending,
                        &config,
                    );
                    consume_watcher_overflow(&overflowed, &mut pending);
                    if stop_requested.load(Ordering::Acquire) || request_token.is_cancelled() {
                        break;
                    }
                    if pending.has_work() {
                        sequence = sequence.wrapping_add(1);
                        let event = pending.take_event(&session_id, sequence, &config);
                        invalidate_git_changes(&event, &config);
                        emit_event(event);
                    }
                    pending = PendingWatcherChanges::default();
                    deadline = None;
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => {
                    if !stop_requested.load(Ordering::Acquire) && !request_token.is_cancelled() {
                        let event = watcher_failure_event(
                            &session_id,
                            &mut sequence,
                            &config,
                            "File watcher stopped unexpectedly.",
                        );
                        invalidate_git_changes(&event, &config);
                        emit_event(event);
                    }
                    break;
                }
            },
            None => match receiver
                .recv_timeout(next_root_reconcile.saturating_duration_since(Instant::now()))
            {
                Ok(message) => Some(message),
                Err(RecvTimeoutError::Timeout) => {
                    #[cfg(test)]
                    IDLE_TIMEOUTS.with(|count| count.set(count.get() + 1));
                    if stop_requested.load(Ordering::Acquire) || request_token.is_cancelled() {
                        break;
                    }
                    if consume_watcher_overflow(&overflowed, &mut pending) {
                        deadline = Some(Instant::now());
                    }
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => {
                    if !stop_requested.load(Ordering::Acquire) && !request_token.is_cancelled() {
                        let event = watcher_failure_event(
                            &session_id,
                            &mut sequence,
                            &config,
                            "File watcher stopped unexpectedly.",
                        );
                        invalidate_git_changes(&event, &config);
                        emit_event(event);
                    }
                    break;
                }
            },
        };

        match message {
            Some(WatcherMessage::Stop) | None => break,
            Some(WatcherMessage::Event(result)) => {
                let root_removed = detach_roots_from_remove_event(
                    &mut watcher,
                    &result,
                    &mut registrations,
                    &mut pending,
                    &config,
                );
                pending.add_result(result, &config);
                let root_restored = reconcile_watcher_roots(
                    &mut watcher,
                    &mut registrations,
                    &mut pending,
                    &config,
                );
                if root_removed || root_restored {
                    let root_deadline = Instant::now() + WATCH_DEBOUNCE;
                    deadline =
                        Some(deadline.map_or(root_deadline, |current| current.min(root_deadline)));
                }
                consume_watcher_overflow(&overflowed, &mut pending);
                if deadline.is_none() {
                    deadline = Some(Instant::now() + WATCH_DEBOUNCE);
                }
            }
        }
    }
    if request_token.is_cancelled() {
        let own_session = watchers.lock().ok().and_then(|mut watchers| {
            let window_label = watchers
                .iter()
                .find(|(_, session)| session.session_id == session_id)
                .map(|(window_label, _)| window_label.clone())?;
            watchers.remove(&window_label)
        });
        if let Some(session) = own_session {
            stop_watcher_session(&session);
        }
    }
}

fn invalidate_git_changes(event: &FileChangedEvent, config: &WatcherConfig) {
    let Some(repository_root) = config.repository_root.as_ref() else {
        return;
    };
    if event.needs_rescan || event.error.is_some() || event.changes.is_empty() {
        config
            .git_runtime
            .invalidate(repository_root, GitDirtyScope::ALL);
        return;
    }
    let mut dirty = GitDirtyScope::default();
    for change in &event.changes {
        for scope in &change.git_scopes {
            dirty |= match scope {
                GitScope::Worktree => GitDirtyScope::WORKTREE,
                GitScope::Index => GitDirtyScope::INDEX,
                GitScope::Refs => GitDirtyScope::REFS,
                GitScope::Head => GitDirtyScope::HEAD,
            };
        }
    }
    if dirty != GitDirtyScope::default() {
        config.git_runtime.invalidate(repository_root, dirty);
    }
}

fn watcher_failure_event(
    session_id: &str,
    sequence: &mut u64,
    config: &WatcherConfig,
    error: &str,
) -> FileChangedEvent {
    *sequence = sequence.wrapping_add(1);
    let paths = if config.workspace.as_os_str().is_empty() {
        Vec::new()
    } else {
        vec![wire_path(&config.workspace)]
    };
    FileChangedEvent {
        session_id: session_id.to_string(),
        sequence: *sequence,
        paths,
        changes: Vec::new(),
        needs_rescan: true,
        error: Some(error.to_string()),
        watch_roots: config.watch_roots.iter().map(public_watch_root).collect(),
    }
}

fn drain_watcher_messages(
    receiver: &Receiver<WatcherMessage>,
    pending: &mut PendingWatcherChanges,
    config: &WatcherConfig,
) {
    let started = Instant::now();
    let mut drained = 0_usize;
    loop {
        if drained >= MAX_PENDING_WATCH_CHANGES || started.elapsed() >= Duration::from_millis(12) {
            pending.needs_rescan = true;
            break;
        }
        match receiver.try_recv() {
            Ok(WatcherMessage::Event(result)) => {
                pending.add_result(result, config);
                drained += 1;
            }
            Ok(WatcherMessage::Stop) | Err(TryRecvError::Disconnected) => break,
            Err(TryRecvError::Empty) => break,
        }
    }
}

pub(crate) fn resolve_watch_input(value: &str, workspace: &Path) -> PathBuf {
    let path = decode_wire_path(value);
    if path.is_absolute() || workspace.as_os_str().is_empty() {
        path
    } else {
        workspace.join(path)
    }
}

fn path_is_same_or_descendant(path: &Path, root: &Path) -> bool {
    if path_eq(path, root) || path.starts_with(root) {
        return true;
    }
    #[cfg(windows)]
    {
        let path = path
            .to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase();
        let root = root
            .to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase();
        path == root
            || path
                .strip_prefix(&root)
                .is_some_and(|rest| rest.starts_with('\\'))
    }
    #[cfg(not(windows))]
    {
        false
    }
}

pub(crate) fn add_watch_root(roots: &mut Vec<WatchRootPath>, path: PathBuf, kind: WatchRootKind) {
    if !path.is_dir() {
        return;
    }
    let path = normalize_watch_path(path);
    if let Some(existing) = roots.iter_mut().find(|root| path_eq(&root.path, &path)) {
        if watch_root_rank(kind) < watch_root_rank(existing.kind) {
            existing.kind = kind;
        }
        return;
    }
    roots.push(WatchRootPath { path, kind });
}

fn watch_root_rank(kind: WatchRootKind) -> u8 {
    match kind {
        WatchRootKind::Workspace => 0,
        WatchRootKind::Worktree => 1,
        WatchRootKind::GitDir => 2,
        WatchRootKind::CommonDir => 3,
        WatchRootKind::External => 4,
    }
}

pub(crate) fn minimize_watch_roots(logical_roots: &[WatchRootPath]) -> Vec<WatchRootPath> {
    let mut candidates = logical_roots.to_vec();
    candidates.sort_by_key(|root| (root.path.components().count(), watch_root_rank(root.kind)));
    let mut registration = Vec::new();
    for candidate in candidates {
        if registration
            .iter()
            .any(|root: &WatchRootPath| path_is_same_or_descendant(&candidate.path, &root.path))
        {
            continue;
        }
        registration.push(candidate);
    }
    registration
}

pub(crate) fn watcher_recovery_parents(roots: &[WatchRootPath]) -> Vec<PathBuf> {
    let mut parents: Vec<PathBuf> = Vec::new();
    for root in roots {
        let Some(parent) = root.path.parent().filter(|parent| parent.is_dir()) else {
            continue;
        };
        if roots
            .iter()
            .any(|watched| path_is_same_or_descendant(parent, &watched.path))
        {
            continue;
        }
        if !parents.iter().any(|watched| path_eq(watched, parent)) {
            parents.push(parent.to_path_buf());
        }
    }
    parents
}

pub(crate) fn watch_root_identity(path: &Path) -> Option<FileIdentity> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || is_windows_reparse_point(&metadata)
    {
        return None;
    }
    path_file_identity(path, &metadata).ok()
}

fn root_presence_transition(
    registration: &mut WatchRootRegistration,
    current_identity: Option<FileIdentity>,
) -> Option<bool> {
    if registration.attached && registration.identity != current_identity {
        registration.attached = false;
        return Some(false);
    }
    if !registration.attached && current_identity.is_some() {
        return Some(true);
    }
    None
}

fn public_watch_root(root: &WatchRootPath) -> WatchRoot {
    WatchRoot {
        path: wire_path(&root.path),
        kind: root.kind,
    }
}

fn watch_source(path: &Path, config: &WatcherConfig) -> Option<WatchRootKind> {
    if config
        .git_dir
        .as_deref()
        .is_some_and(|root| path_is_same_or_descendant(path, root))
    {
        return Some(WatchRootKind::GitDir);
    }
    if config
        .common_dir
        .as_deref()
        .is_some_and(|root| path_is_same_or_descendant(path, root))
    {
        return Some(WatchRootKind::CommonDir);
    }
    config
        .watch_roots
        .iter()
        .filter(|root| path_is_same_or_descendant(path, &root.path))
        .max_by_key(|root| {
            (
                root.path.components().count(),
                u8::MAX - watch_root_rank(root.kind),
            )
        })
        .map(|root| root.kind)
}

fn git_scopes(path: &Path, source: Option<WatchRootKind>, config: &WatcherConfig) -> Vec<GitScope> {
    let mut scopes = Vec::new();
    match source {
        Some(WatchRootKind::Workspace | WatchRootKind::Worktree) => {
            scopes.push(GitScope::Worktree);
        }
        Some(WatchRootKind::GitDir | WatchRootKind::CommonDir) => {
            let metadata_root = [config.git_dir.as_deref(), config.common_dir.as_deref()]
                .into_iter()
                .flatten()
                .find(|root| path_is_same_or_descendant(path, root));
            let relative = metadata_root
                .and_then(|root| path.strip_prefix(root).ok())
                .unwrap_or(path);
            let components: Vec<String> = relative
                .components()
                .filter_map(|component| match component {
                    Component::Normal(name) => Some(name.to_string_lossy().to_ascii_lowercase()),
                    _ => None,
                })
                .collect();
            match components.first().map(String::as_str) {
                Some("head") => scopes.push(GitScope::Head),
                Some(value) if value == "index" || value.starts_with("index.") => {
                    scopes.push(GitScope::Index)
                }
                Some(value) if value.starts_with("sharedindex.") => scopes.push(GitScope::Index),
                Some("refs" | "logs") | Some("packed-refs") => scopes.push(GitScope::Refs),
                Some("objects") => {}
                Some(_) | None => scopes.push(GitScope::Refs),
            }
        }
        Some(WatchRootKind::External) | None => {}
    }
    scopes
}

fn classify_notify_event(event: &Event, config: &WatcherConfig) -> Vec<FileChange> {
    if event.kind.is_access() {
        return Vec::new();
    }
    let paths = &event.paths;
    match &event.kind {
        EventKind::Access(_) => Vec::new(),
        EventKind::Create(_) => paths
            .iter()
            .filter_map(|path| make_file_change(FileChangeKind::Create, path, None, config))
            .collect(),
        EventKind::Remove(_) => paths
            .iter()
            .filter_map(|path| make_file_change(FileChangeKind::Remove, path, None, config))
            .collect(),
        EventKind::Modify(ModifyKind::Name(mode)) => {
            if matches!(mode, &RenameMode::Both) && paths.len() == 2 {
                let old_path = &paths[0];
                let new_path = &paths[1];
                classify_rename_pair(old_path, new_path, config)
                    .into_iter()
                    .collect()
            } else {
                paths
                    .iter()
                    .filter_map(|path| make_file_change(FileChangeKind::Rescan, path, None, config))
                    .collect()
            }
        }
        EventKind::Modify(_) => paths
            .iter()
            .filter_map(|path| make_file_change(FileChangeKind::Modify, path, None, config))
            .collect(),
        EventKind::Any | EventKind::Other => {
            let mut changes: Vec<FileChange> = paths
                .iter()
                .filter_map(|path| make_file_change(FileChangeKind::Rescan, path, None, config))
                .collect();
            if changes.is_empty() {
                changes.push(FileChange {
                    kind: FileChangeKind::Rescan,
                    path: wire_path(&config.workspace),
                    old_path: None,
                    is_directory: Some(true),
                    source: watch_source(&config.workspace, config),
                    git_scopes: git_scopes(
                        &config.workspace,
                        watch_source(&config.workspace, config),
                        config,
                    ),
                });
            }
            changes
        }
    }
}

fn classify_rename_pair(
    old_path: &Path,
    new_path: &Path,
    config: &WatcherConfig,
) -> Option<FileChange> {
    let old_noise = is_watcher_noise(old_path, config);
    let new_noise = is_watcher_noise(new_path, config);
    match (old_noise, new_noise) {
        (true, true) => None,
        (true, false) => make_file_change(FileChangeKind::Create, new_path, None, config),
        (false, true) => make_file_change(FileChangeKind::Remove, old_path, None, config),
        (false, false) => {
            make_file_change(FileChangeKind::Rename, new_path, Some(old_path), config)
        }
    }
}

fn make_file_change(
    kind: FileChangeKind,
    path: &Path,
    old_path_input: Option<&Path>,
    config: &WatcherConfig,
) -> Option<FileChange> {
    let wire = checked_wire_path(path).ok()?;
    let source = watch_source(path, config)?;
    if is_watcher_noise(path, config) {
        return None;
    }
    let old_path_is_noise =
        old_path_input.is_some_and(|old_path| is_watcher_noise(old_path, config));
    let kind = if old_path_is_noise && kind == FileChangeKind::Rename {
        FileChangeKind::Create
    } else {
        kind
    };
    let old_path = old_path_input
        .filter(|path| !is_watcher_noise(path, config))
        .map(wire_path);
    let is_directory = fs::metadata(path)
        .ok()
        .or_else(|| old_path_input.and_then(|old_path| fs::metadata(old_path).ok()))
        .map(|metadata| metadata.is_dir());
    Some(FileChange {
        kind,
        path: wire,
        old_path,
        is_directory,
        git_scopes: git_scopes(path, Some(source), config),
        source: Some(source),
    })
}

fn merge_file_change(existing: &mut FileChange, incoming: FileChange) {
    let incoming_kind = incoming.kind.clone();
    let incoming_old_path = incoming.old_path.clone();
    let incoming_is_directory = incoming.is_directory;
    match (&existing.kind, &incoming_kind) {
        (FileChangeKind::Create, FileChangeKind::Modify)
        | (FileChangeKind::Create, FileChangeKind::Create) => {}
        // A follow-up modify event must not erase the source path carried by a
        // rename. Keeping the rename lets the frontend move open-tab identity
        // and refresh both parent directories.
        (FileChangeKind::Rename, FileChangeKind::Modify) => {}
        (_, FileChangeKind::Rescan) => existing.kind = FileChangeKind::Rescan,
        (_, FileChangeKind::Rename) => {
            existing.kind = FileChangeKind::Rename;
            existing.old_path = incoming_old_path.clone();
        }
        (_, FileChangeKind::Remove) => existing.kind = FileChangeKind::Remove,
        (_, FileChangeKind::Create) => existing.kind = FileChangeKind::Create,
        _ => existing.kind = incoming_kind,
    }
    if existing.old_path.is_none() {
        existing.old_path = incoming_old_path;
    }
    if existing.is_directory.is_none() {
        existing.is_directory = incoming_is_directory;
    }
    match (existing.source, incoming.source) {
        (None, Some(source)) => existing.source = Some(source),
        (Some(existing_source), Some(incoming_source)) if existing_source != incoming_source => {
            existing.source = None;
        }
        _ => {}
    }
    for scope in incoming.git_scopes {
        if !existing.git_scopes.contains(&scope) {
            existing.git_scopes.push(scope);
        }
    }
}

fn is_watcher_noise(path: &Path, config: &WatcherConfig) -> bool {
    if config
        .open_files
        .iter()
        .any(|open_file| path_eq(path, open_file))
    {
        return false;
    }
    if config
        .excludes
        .iter()
        .any(|exclude| path_is_same_or_descendant(path, exclude))
    {
        return true;
    }
    let components: Vec<String> = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(name) => Some(name.to_string_lossy().to_ascii_lowercase()),
            _ => None,
        })
        .collect();
    let is_git_object = [config.git_dir.as_deref(), config.common_dir.as_deref()]
        .into_iter()
        .flatten()
        .any(|metadata_root| {
            let Ok(relative) = path.strip_prefix(metadata_root) else {
                return false;
            };
            relative.components().next().is_some_and(|component| {
                component
                    .as_os_str()
                    .to_string_lossy()
                    .eq_ignore_ascii_case("objects")
            })
        });
    if is_git_object {
        return true;
    }
    if components
        .windows(2)
        .any(|window| matches!(window[0].as_str(), ".git") && window[1] == "objects")
    {
        return true;
    }
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if file_name.starts_with(".pude-tmp-") || file_name == ".tspude-tmp" {
        return true;
    }
    false
}

#[cfg(test)]
mod watcher_tests {
    use super::*;

    #[test]
    fn stopping_watcher_waits_for_worker_completion_not_the_stop_request() {
        let (control, _receiver) = std::sync::mpsc::sync_channel(1);
        let session = WatcherSession {
            session_id: "test-watcher".to_string(),
            control,
            stop_requested: Arc::new(AtomicBool::new(false)),
            finished: Arc::new(AtomicBool::new(false)),
        };

        let timeout = stop_watcher_session_and_wait(&session, Duration::from_millis(25))
            .expect_err("a stop request must not be mistaken for worker completion");
        assert!(timeout.contains("Timed out waiting"));
        assert!(session.stop_requested.load(Ordering::Acquire));
        assert!(!session.finished.load(Ordering::Acquire));

        session.finished.store(true, Ordering::Release);
        stop_watcher_session_and_wait(&session, Duration::from_millis(25))
            .expect("the helper should return after the worker reports completion");
    }

    fn config() -> WatcherConfig {
        WatcherConfig {
            workspace: PathBuf::from("workspace"),
            watch_roots: vec![WatchRootPath {
                path: PathBuf::from("workspace"),
                kind: WatchRootKind::Workspace,
            }],
            git_dir: Some(PathBuf::from("workspace/.git")),
            common_dir: Some(PathBuf::from("shared-git")),
            repository_root: Some(PathBuf::from("repository")),
            git_runtime: GitCoordinator::new(),
            excludes: Vec::new(),
            open_files: Vec::new(),
        }
    }

    #[test]
    fn idle_loop_wakes_once_per_second_and_stop_interrupts_the_wait() {
        let (sender, receiver) = std::sync::mpsc::sync_channel(8);
        let worker = std::thread::spawn(move || {
            let watcher = notify::recommended_watcher(|_: notify::Result<Event>| {}).unwrap();
            let runtime = GitCoordinator::new();
            let request = runtime.begin_request(Path::new("workspace"), Some("idle-test"));
            run_watcher(
                watcher,
                receiver,
                Channel::new(|_| Ok(())),
                config(),
                "idle-test".into(),
                Arc::new(AtomicBool::new(false)),
                Arc::new(AtomicBool::new(false)),
                Vec::new(),
                request.token(),
                Arc::new(Mutex::new(HashMap::new())),
            );
            IDLE_TIMEOUTS.with(std::cell::Cell::get)
        });
        std::thread::sleep(Duration::from_millis(2250));
        let stop_started = Instant::now();
        sender.send(WatcherMessage::Stop).unwrap();
        let timeouts = worker.join().unwrap();
        assert!(
            (2..=3).contains(&timeouts),
            "Unexpected idle wakeup count: {timeouts}"
        );
        assert!(
            stop_started.elapsed() < Duration::from_millis(250),
            "Stop must interrupt the one-second receive wait."
        );
    }

    fn rename_event(mode: RenameMode, path: &str, tracker: Option<usize>) -> Event {
        let event =
            Event::new(EventKind::Modify(ModifyKind::Name(mode))).add_path(PathBuf::from(path));
        match tracker {
            Some(tracker) => event.set_tracker(tracker),
            None => event,
        }
    }

    #[test]
    fn interleaved_tracked_renames_pair_by_tracker() {
        let config = config();
        let mut pending = PendingWatcherChanges::default();
        pending.add_result(
            Ok(rename_event(RenameMode::From, "workspace/a.txt", Some(11))),
            &config,
        );
        pending.add_result(
            Ok(rename_event(RenameMode::From, "workspace/b.txt", Some(22))),
            &config,
        );
        pending.add_result(
            Ok(rename_event(
                RenameMode::To,
                "workspace/b-renamed.txt",
                Some(22),
            )),
            &config,
        );
        pending.add_result(
            Ok(rename_event(
                RenameMode::To,
                "workspace/a-renamed.txt",
                Some(11),
            )),
            &config,
        );

        let event = pending.take_event("test", 1, &config);
        assert!(!event.needs_rescan);
        assert!(event.changes.iter().any(|change| {
            change.kind == FileChangeKind::Rename
                && change.path == wire_path(Path::new("workspace/b-renamed.txt"))
                && change.old_path.as_deref()
                    == Some(wire_path(Path::new("workspace/b.txt")).as_str())
        }));
        assert!(event.changes.iter().any(|change| {
            change.kind == FileChangeKind::Rename
                && change.path == wire_path(Path::new("workspace/a-renamed.txt"))
                && change.old_path.as_deref()
                    == Some(wire_path(Path::new("workspace/a.txt")).as_str())
        }));
    }

    #[test]
    fn missing_rename_tracker_forces_rescan() {
        let config = config();
        let mut pending = PendingWatcherChanges::default();
        pending.add_result(
            Ok(rename_event(RenameMode::From, "workspace/file.txt", None)),
            &config,
        );
        let event = pending.take_event("test", 1, &config);
        assert!(event.needs_rescan);
        assert!(event
            .changes
            .iter()
            .any(|change| change.kind == FileChangeKind::Rescan));
    }

    #[test]
    fn rename_overflow_forces_rescan_and_invalidates_all_git_revisions() {
        let config = config();
        let mut pending = PendingWatcherChanges::default();
        for index in 0..=MAX_PENDING_WATCH_CHANGES {
            let path = format!("workspace/overflow-{index}.txt");
            pending.add_result(
                Ok(rename_event(RenameMode::From, &path, Some(index))),
                &config,
            );
        }

        let event = pending.take_event("session", 1, &config);
        assert!(event.needs_rescan);
        assert!(event
            .changes
            .iter()
            .any(|change| change.kind == FileChangeKind::Rescan));
        let before = config
            .git_runtime
            .revisions(config.repository_root.as_ref().unwrap());
        invalidate_git_changes(&event, &config);
        let after = config
            .git_runtime
            .revisions(config.repository_root.as_ref().unwrap());
        assert!(after.worktree > before.worktree);
        assert!(after.index > before.index);
        assert!(after.refs > before.refs);
        assert!(after.head > before.head);
    }

    #[test]
    fn excludes_are_overridden_by_open_file_exception() {
        let mut config = config();
        config.excludes.push(PathBuf::from("workspace/ignored"));
        config
            .open_files
            .push(PathBuf::from("workspace/ignored/open.txt"));
        assert!(is_watcher_noise(
            Path::new("workspace/ignored/other.txt"),
            &config
        ));
        assert!(!is_watcher_noise(
            Path::new("workspace/ignored/open.txt"),
            &config
        ));
        let event = Event::new(EventKind::Create(notify::event::CreateKind::File))
            .add_path(PathBuf::from("workspace/ignored/open.txt"));
        let changes = classify_notify_event(&event, &config);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "workspace/ignored/open.txt");
    }

    #[test]
    fn git_metadata_source_and_scope_are_explicit() {
        let config = config();
        let index = make_file_change(
            FileChangeKind::Modify,
            Path::new("workspace/.git/index.lock"),
            None,
            &config,
        )
        .expect("index event should be visible");
        assert_eq!(index.source, Some(WatchRootKind::GitDir));
        assert_eq!(index.git_scopes, vec![GitScope::Index]);

        let ref_event = make_file_change(
            FileChangeKind::Modify,
            Path::new("shared-git/refs/heads/main"),
            None,
            &config,
        )
        .expect("ref event should be visible");
        assert_eq!(ref_event.source, Some(WatchRootKind::CommonDir));
        assert_eq!(ref_event.git_scopes, vec![GitScope::Refs]);
    }

    #[test]
    fn rescan_event_invalidates_all_git_revisions() {
        let config = config();
        let before = config
            .git_runtime
            .revisions(config.repository_root.as_ref().unwrap());
        let event = FileChangedEvent {
            session_id: "test".to_string(),
            sequence: 1,
            paths: vec![wire_path(&config.workspace)],
            changes: Vec::new(),
            needs_rescan: true,
            error: None,
            watch_roots: Vec::new(),
        };
        invalidate_git_changes(&event, &config);
        let after = config
            .git_runtime
            .revisions(config.repository_root.as_ref().unwrap());
        assert!(after.worktree > before.worktree);
        assert!(after.index > before.index);
        assert!(after.refs > before.refs);
        assert!(after.head > before.head);
    }

    #[test]
    fn bounded_callback_queue_overflow_emits_a_full_rescan_signal() {
        let config = config();
        let overflowed = AtomicBool::new(true);
        let mut pending = PendingWatcherChanges::default();

        assert!(consume_watcher_overflow(&overflowed, &mut pending));
        assert!(!consume_watcher_overflow(&overflowed, &mut pending));
        let event = pending.take_event("test", 1, &config);

        assert!(event.needs_rescan);
        assert!(event.changes.is_empty());
    }

    #[test]
    fn recovery_parents_are_deduplicated_for_independent_roots() {
        let parent = std::env::temp_dir().join(format!("pude-watch-parent-{}", Uuid::new_v4()));
        let first = parent.join("first");
        let second = parent.join("second");
        fs::create_dir_all(&first).expect("first watched root should exist");
        fs::create_dir_all(&second).expect("second watched root should exist");
        let roots = vec![
            WatchRootPath {
                path: first,
                kind: WatchRootKind::Workspace,
            },
            WatchRootPath {
                path: second,
                kind: WatchRootKind::External,
            },
        ];

        let parents = watcher_recovery_parents(&roots);

        assert_eq!(parents, vec![parent.clone()]);
        fs::remove_dir_all(parent).expect("temporary watch roots should be removed");
    }

    #[test]
    fn watcher_detects_a_root_replaced_at_the_same_path() {
        let base = std::env::temp_dir().join(format!("pude-watch-replace-{}", Uuid::new_v4()));
        let root = base.join("workspace");
        let moved_root = base.join("workspace-old");
        fs::create_dir_all(&root).expect("workspace should be created");
        let original_identity =
            watch_root_identity(&root).expect("workspace identity should exist");
        let mut registration = WatchRootRegistration {
            path: root.clone(),
            attached: true,
            failure_reported: false,
            identity: Some(original_identity.clone()),
        };

        fs::rename(&root, &moved_root).expect("original workspace should be moved aside");
        fs::create_dir(&root).expect("replacement workspace should be created");
        let replacement_identity =
            watch_root_identity(&root).expect("replacement workspace identity should exist");
        assert_ne!(replacement_identity, original_identity);
        assert_eq!(
            root_presence_transition(&mut registration, Some(replacement_identity.clone())),
            Some(false),
            "the old watch must detach when a different directory occupies the path"
        );
        assert_eq!(
            root_presence_transition(&mut registration, Some(replacement_identity)),
            Some(true),
            "the replacement directory should then be watched"
        );

        fs::remove_dir_all(base).expect("temporary watcher roots should be removed");
    }

    #[test]
    fn watcher_recovers_after_a_registered_root_disappears_and_returns() {
        let base = std::env::temp_dir().join(format!("pude-watch-recover-{}", Uuid::new_v4()));
        let root = base.join("workspace");
        fs::create_dir_all(&root).expect("workspace should be created");
        let mut watcher = notify::recommended_watcher(|_: notify::Result<Event>| {})
            .expect("native watcher should be created");
        watcher
            .watch(&base, RecursiveMode::NonRecursive)
            .expect("parent should be watched for recovery");
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .expect("workspace root should be watched");
        let config = WatcherConfig {
            workspace: root.clone(),
            watch_roots: vec![WatchRootPath {
                path: root.clone(),
                kind: WatchRootKind::Workspace,
            }],
            git_dir: None,
            common_dir: None,
            repository_root: None,
            git_runtime: GitCoordinator::new(),
            excludes: Vec::new(),
            open_files: Vec::new(),
        };
        let mut registrations = vec![WatchRootRegistration {
            path: root.clone(),
            attached: true,
            failure_reported: false,
            identity: watch_root_identity(&root),
        }];
        let mut pending = PendingWatcherChanges::default();

        fs::remove_dir(&root).expect("workspace should disappear");
        assert!(reconcile_watcher_roots(
            &mut watcher,
            &mut registrations,
            &mut pending,
            &config,
        ));
        assert!(!registrations[0].attached);
        assert!(pending.needs_rescan);
        assert!(pending
            .error
            .as_deref()
            .is_some_and(|error| error.contains("disappeared")));

        fs::create_dir(&root).expect("workspace should return");
        assert!(reconcile_watcher_roots(
            &mut watcher,
            &mut registrations,
            &mut pending,
            &config,
        ));
        assert!(registrations[0].attached);
        assert!(pending.take_event("test", 1, &config).needs_rescan);
        drop(watcher);
        fs::remove_dir_all(base).expect("temporary watcher roots should be removed");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_fsevents_overflow_and_root_recreation_recover_through_the_watcher_loop() {
        use std::sync::atomic::AtomicUsize;
        use std::sync::mpsc::{self, TrySendError};
        use std::thread::{self, JoinHandle};

        struct TemporaryWatchTree(PathBuf);

        impl TemporaryWatchTree {
            fn new() -> Self {
                let path = PathBuf::from("/private/tmp")
                    .join(format!("pude-native-watch-{}", Uuid::new_v4()));
                fs::create_dir_all(&path).expect("temporary watcher fixture should be created");
                Self(path)
            }
        }

        impl Drop for TemporaryWatchTree {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        struct WatcherRunner {
            stop_requested: Arc<AtomicBool>,
            control: SyncSender<WatcherMessage>,
            finished: Receiver<()>,
            handle: Option<JoinHandle<()>>,
        }

        impl WatcherRunner {
            fn stop_and_join(&mut self) -> Result<(), String> {
                if self.handle.is_none() {
                    return Ok(());
                }
                self.stop_requested.store(true, Ordering::Release);
                let _ = self.control.try_send(WatcherMessage::Stop);
                if self.finished.recv_timeout(Duration::from_secs(2)).is_err() {
                    self.handle.take();
                    return Err(
                        "watcher loop did not stop within the 2-second test deadline".into(),
                    );
                }
                self.handle
                    .take()
                    .expect("watcher thread handle should still be present")
                    .join()
                    .map_err(|_| "watcher loop panicked during shutdown".to_string())
            }
        }

        impl Drop for WatcherRunner {
            fn drop(&mut self) {
                let _ = self.stop_and_join();
            }
        }

        fn receive_until(
            events: &Receiver<FileChangedEvent>,
            timeout: Duration,
            description: &str,
            mut matches: impl FnMut(&FileChangedEvent) -> bool,
        ) -> FileChangedEvent {
            let deadline = Instant::now() + timeout;
            let mut last_event = String::from("none");
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                assert!(
                    !remaining.is_zero(),
                    "expected {description} watcher event did not arrive; last event: {last_event}"
                );
                match events.recv_timeout(remaining) {
                    Ok(event) if matches(&event) => return event,
                    Ok(event) => {
                        last_event = format!(
                            "sequence={}, rescan={}, error={:?}, paths={:?}",
                            event.sequence, event.needs_rescan, event.error, event.paths
                        );
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        panic!(
                            "expected {description} watcher event did not arrive before timeout; last event: {last_event}"
                        )
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        panic!("watcher event loop stopped before the expected event")
                    }
                }
            }
        }

        let fixture = TemporaryWatchTree::new();
        let canonical_fixture =
            fs::canonicalize(&fixture.0).expect("temporary watcher root should canonicalize");
        let root = canonical_fixture.join("workspace");
        let moved_root = canonical_fixture.join("workspace-moved");
        fs::create_dir(&root).expect("workspace fixture should be created");

        let (control, receiver) = mpsc::sync_channel::<WatcherMessage>(WATCHER_CHANNEL_CAPACITY);
        let overflowed = Arc::new(AtomicBool::new(false));
        let callback_overflowed = Arc::clone(&overflowed);
        let callback_count = Arc::new(AtomicUsize::new(0));
        let callback_counter = Arc::clone(&callback_count);
        let callback_control = control.clone();
        let mut watcher = notify::recommended_watcher(move |result| {
            callback_counter.fetch_add(1, Ordering::Relaxed);
            if let Err(error) = callback_control.try_send(WatcherMessage::Event(result)) {
                if matches!(error, TrySendError::Full(_)) {
                    callback_overflowed.store(true, Ordering::Release);
                }
            }
        })
        .expect("native macOS filesystem watcher should start");
        watcher
            .watch(&canonical_fixture, RecursiveMode::NonRecursive)
            .expect("parent should be watched for root recovery");
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .expect("workspace should be recursively watched");

        let config = WatcherConfig {
            workspace: root.clone(),
            watch_roots: vec![WatchRootPath {
                path: root.clone(),
                kind: WatchRootKind::Workspace,
            }],
            git_dir: None,
            common_dir: None,
            repository_root: None,
            git_runtime: GitCoordinator::new(),
            excludes: Vec::new(),
            open_files: Vec::new(),
        };
        let root_wire_path = wire_path(&root);
        let registrations = vec![WatchRootRegistration {
            path: root.clone(),
            attached: true,
            failure_reported: false,
            identity: watch_root_identity(&root),
        }];

        for index in 0_u32..2_000 {
            fs::write(
                root.join(format!("burst-{index:04}.txt")),
                index.to_le_bytes(),
            )
            .expect("filesystem event storm fixture should be written");
        }
        let callback_deadline = Instant::now() + Duration::from_secs(12);
        while !overflowed.load(Ordering::Acquire) && Instant::now() < callback_deadline {
            thread::sleep(Duration::from_millis(20));
        }
        let callbacks_before_runner = callback_count.load(Ordering::Relaxed);
        assert!(
            overflowed.load(Ordering::Acquire),
            "real FSEvents callback storm should overflow the production bounded queue; callbacks={callbacks_before_runner}"
        );
        assert!(callbacks_before_runner > WATCHER_CHANNEL_CAPACITY);
        eprintln!(
            "native FSEvents storm delivered {callbacks_before_runner} callbacks into a queue of capacity {WATCHER_CHANNEL_CAPACITY}"
        );

        let (event_sender, event_receiver) = mpsc::channel();
        let (finished_sender, finished_receiver) = mpsc::channel();
        let stop_requested = Arc::new(AtomicBool::new(false));
        let thread_stop_requested = Arc::clone(&stop_requested);
        let thread_watchers = Arc::new(Mutex::new(HashMap::new()));
        let handle = thread::spawn(move || {
            run_watcher_loop(
                watcher,
                receiver,
                config,
                "native-fsevents-test".to_string(),
                thread_stop_requested,
                overflowed,
                registrations,
                CancellationToken::new(),
                thread_watchers,
                move |event| {
                    let _ = event_sender.send(event);
                },
            );
            let _ = finished_sender.send(());
        });
        let mut runner = WatcherRunner {
            stop_requested: Arc::clone(&stop_requested),
            control: control.clone(),
            finished: finished_receiver,
            handle: Some(handle),
        };

        let storm = receive_until(
            &event_receiver,
            Duration::from_secs(12),
            "overflow rescan",
            |event| event.needs_rescan,
        );
        assert!(storm.needs_rescan);

        let callback_count_before_remove = callback_count.load(Ordering::Relaxed);
        fs::rename(&root, &moved_root).expect("workspace root should disappear by rename");
        let removed = receive_until(
            &event_receiver,
            Duration::from_secs(8),
            "root removal",
            |event| {
                event.error.as_deref().is_some_and(|error| {
                    error.contains("disappeared") || error.contains("removed or renamed")
                })
            },
        );
        assert!(removed.needs_rescan);
        assert!(callback_count.load(Ordering::Relaxed) > callback_count_before_remove);

        fs::create_dir(&root).expect("workspace root should be recreated at the same path");
        let restored = receive_until(
            &event_receiver,
            Duration::from_secs(8),
            "root restoration",
            |event| {
                event.error.is_none()
                    && event.needs_rescan
                    && event.paths.iter().any(|path| path == &root_wire_path)
            },
        );
        assert!(restored.needs_rescan);

        let reopened_file = root.join("after-recreate.txt");
        let reopened_file_wire_path = wire_path(&reopened_file);
        let callback_count_before_reopened_file = callback_count.load(Ordering::Relaxed);
        fs::write(&reopened_file, b"new root is watched").expect("new root file should be written");
        let reopened = receive_until(
            &event_receiver,
            Duration::from_secs(8),
            "change under recreated root",
            |event| {
                event
                    .paths
                    .iter()
                    .any(|path| path == &reopened_file_wire_path)
            },
        );
        assert!(reopened.paths.contains(&reopened_file_wire_path));
        assert!(callback_count.load(Ordering::Relaxed) > callback_count_before_reopened_file);

        runner
            .stop_and_join()
            .expect("production watcher loop should stop cleanly after native recovery");
        eprintln!(
            "native FSEvents root lifecycle: removal sequence {}, recovery sequence {}, total callbacks {}",
            removed.sequence,
            restored.sequence,
            callback_count.load(Ordering::Relaxed)
        );
    }

    #[test]
    fn cancelled_request_stops_before_git_process_phase() {
        let runtime = GitCoordinator::new();
        let request = runtime.begin_request(Path::new("workspace"), Some("window"));
        request.cancel();
        let result = git_read_shared(
            &runtime,
            Path::new("repository"),
            GitReadKind::Status,
            vec![OsString::from("status")],
            &request,
        );
        assert_eq!(result.unwrap_err().kind, GitErrorKind::Cancelled);
    }
}
