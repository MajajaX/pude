use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::error::Error;
use std::ffi::OsString;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, Weak};
use std::thread;
use std::time::Duration;
use std::time::Instant;

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt as WindowsCommandExt;

pub const DEFAULT_READ_TIMEOUT: Duration = Duration::from_secs(15);
pub const DEFAULT_MUTATION_TIMEOUT: Duration = Duration::from_secs(120);
pub const DEFAULT_STDOUT_LIMIT: usize = 16 * 1024 * 1024;
pub const DEFAULT_STDERR_LIMIT: usize = 512 * 1024;
pub const MAX_STDIN_BYTES: usize = 1024 * 1024;
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(10);
const FLIGHT_WAIT_INTERVAL: Duration = Duration::from_millis(20);
const SPOOL_CREATE_ATTEMPTS: usize = 32;
const MAX_CACHE_ENTRIES_PER_REPOSITORY: usize = 16;
const MAX_REPOSITORY_STATES: usize = 64;
const MAX_CACHE_BYTES_PER_REPOSITORY: usize = 32 * 1024 * 1024;
const MAX_CACHE_BYTES_GLOBAL: usize = 128 * 1024 * 1024;
const PROCESS_TERMINATION_DEADLINE: Duration = Duration::from_secs(2);
const PROCESS_FORCE_REAP_GRACE: Duration = Duration::from_millis(250);
const FLIGHT_CLEANUP_DEADLINE: Duration = Duration::from_millis(2_270);
const WINDOW_CANCEL_WAIT_MAX: Duration = Duration::from_secs(5);
#[cfg(windows)]
const CREATE_SUSPENDED: u32 = 0x0000_0004;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
static SPOOL_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitErrorKind {
    Unavailable,
    NotRepository,
    Failed,
    TimedOut,
    Cancelled,
    OutputLimit,
    Io,
    Internal,
    CleanupFailed,
    Capacity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitErrorInfo {
    pub kind: GitErrorKind,
    pub message: String,
    pub exit_code: Option<i32>,
    pub stream: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitRuntimeError {
    #[serde(flatten)]
    info: GitErrorInfo,
}

impl GitRuntimeError {
    #[cfg(test)]
    pub fn kind(&self) -> GitErrorKind {
        self.info.kind
    }

    pub fn info(&self) -> GitErrorInfo {
        self.info.clone()
    }

    fn with_detail(mut self, detail: impl fmt::Display) -> Self {
        self.info.message.push_str(" ");
        self.info.message.push_str(&detail.to_string());
        self
    }

    fn new(kind: GitErrorKind, message: impl Into<String>) -> Self {
        Self {
            info: GitErrorInfo {
                kind,
                message: message.into(),
                exit_code: None,
                stream: None,
                limit: None,
            },
        }
    }

    fn failed(output: &GitCommandOutput) -> Self {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let details = if stderr.is_empty() { stdout } else { stderr };
        let kind = if details
            .to_ascii_lowercase()
            .contains("not a git repository")
        {
            GitErrorKind::NotRepository
        } else {
            GitErrorKind::Failed
        };
        let message = if details.is_empty() {
            "Git command failed without an error message.".to_string()
        } else {
            details
        };
        Self {
            info: GitErrorInfo {
                kind,
                message,
                exit_code: output.exit_code,
                stream: None,
                limit: None,
            },
        }
    }

    fn output_limit(stream: &'static str, limit: usize) -> Self {
        Self {
            info: GitErrorInfo {
                kind: GitErrorKind::OutputLimit,
                message: format!("Git {stream} output exceeded the {limit} byte limit."),
                exit_code: None,
                stream: Some(stream.to_string()),
                limit: Some(limit),
            },
        }
    }

    fn io(operation: &'static str, error: impl fmt::Display) -> Self {
        Self::new(GitErrorKind::Io, format!("Unable to {operation}. {error}"))
    }

    fn unavailable(error: impl fmt::Display) -> Self {
        Self::new(
            GitErrorKind::Unavailable,
            format!("Git is unavailable. {error}"),
        )
    }

    fn timed_out(timeout: Duration) -> Self {
        Self::new(
            GitErrorKind::TimedOut,
            format!("Git command timed out after {timeout:?}."),
        )
    }

    fn cancelled() -> Self {
        Self::new(GitErrorKind::Cancelled, "Git command was cancelled.")
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new(GitErrorKind::Internal, message)
    }

    fn cleanup(message: impl Into<String>) -> Self {
        Self::new(GitErrorKind::CleanupFailed, message)
    }

    fn capacity() -> Self {
        Self::new(
            GitErrorKind::Capacity,
            "Git read coordinator capacity is temporarily exhausted.",
        )
    }
}

impl fmt::Display for GitRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.info.message)
    }
}

impl Error for GitRuntimeError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitCommandOutput {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: Arc<[u8]>,
    pub stderr: Arc<[u8]>,
}

impl GitCommandOutput {
    pub fn stdout_lossy(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    pub fn stderr_lossy(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }

    pub fn into_success(self) -> Result<Self, GitRuntimeError> {
        if self.success {
            Ok(self)
        } else {
            Err(GitRuntimeError::failed(&self))
        }
    }
}

#[derive(Debug, Clone)]
pub struct GitCommandSpec {
    pub program: OsString,
    pub cwd: PathBuf,
    pub args: Vec<OsString>,
    pub stdin: Option<Arc<[u8]>>,
    pub no_optional_locks: bool,
    pub timeout: Duration,
    pub stdout_limit: usize,
    pub stderr_limit: usize,
    pub poll_interval: Duration,
}

impl GitCommandSpec {
    pub fn new(cwd: impl Into<PathBuf>, args: Vec<OsString>) -> Self {
        Self {
            program: OsString::from("git"),
            cwd: cwd.into(),
            args,
            stdin: None,
            no_optional_locks: false,
            timeout: DEFAULT_MUTATION_TIMEOUT,
            stdout_limit: DEFAULT_STDOUT_LIMIT,
            stderr_limit: DEFAULT_STDERR_LIMIT,
            poll_interval: PROCESS_POLL_INTERVAL,
        }
    }

    pub fn read(cwd: impl Into<PathBuf>, args: Vec<OsString>) -> Self {
        let mut spec = Self::new(cwd, args);
        spec.no_optional_locks = true;
        spec.timeout = DEFAULT_READ_TIMEOUT;
        spec
    }

    #[cfg(test)]
    pub fn with_program(mut self, program: impl Into<OsString>) -> Self {
        self.program = program.into();
        self
    }

    #[cfg(test)]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    #[cfg(test)]
    pub fn with_output_limits(mut self, stdout_limit: usize, stderr_limit: usize) -> Self {
        self.stdout_limit = stdout_limit;
        self.stderr_limit = stderr_limit;
        self
    }

    #[cfg(test)]
    pub fn with_poll_interval(mut self, poll_interval: Duration) -> Self {
        self.poll_interval = poll_interval.max(Duration::from_millis(1));
        self
    }
}

#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    state: Arc<CancelState>,
}

#[derive(Debug, Default)]
struct CancelState {
    cancelled: AtomicBool,
    cleanup_failures: Mutex<Vec<String>>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.state.cancelled.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.state.cancelled.load(Ordering::Acquire)
    }

    fn record_cleanup_failure(&self, error: &GitRuntimeError) {
        if error.info.kind == GitErrorKind::CleanupFailed {
            let mut failures = lock_unpoison(&self.state.cleanup_failures);
            if !failures.contains(&error.info.message) {
                failures.push(error.info.message.clone());
            }
        }
    }

    fn cleanup_failures(&self) -> Vec<String> {
        lock_unpoison(&self.state.cleanup_failures).clone()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitReadKind {
    Status,
    Refs,
    History,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRevisions {
    pub worktree: u64,
    pub index: u64,
    pub refs: u64,
    pub head: u64,
}

impl GitRevisions {
    pub fn for_kind(self, kind: GitReadKind) -> GitRevision {
        match kind {
            GitReadKind::Status => GitRevision {
                worktree: self.worktree,
                index: self.index,
                refs: 0,
                head: self.head,
            },
            GitReadKind::Refs | GitReadKind::History => GitRevision {
                worktree: 0,
                index: 0,
                refs: self.refs,
                head: self.head,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRevision {
    pub worktree: u64,
    pub index: u64,
    pub refs: u64,
    pub head: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct GitDirtyScope(u8);

impl GitDirtyScope {
    pub const WORKTREE: Self = Self(1 << 0);
    pub const INDEX: Self = Self(1 << 1);
    pub const REFS: Self = Self(1 << 2);
    pub const HEAD: Self = Self(1 << 3);
    pub const ALL: Self = Self(Self::WORKTREE.0 | Self::INDEX.0 | Self::REFS.0 | Self::HEAD.0);

    pub fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }
}

impl std::ops::BitOr for GitDirtyScope {
    type Output = Self;

    fn bitor(self, rhs: Self) -> Self::Output {
        Self(self.0 | rhs.0)
    }
}

impl std::ops::BitOrAssign for GitDirtyScope {
    fn bitor_assign(&mut self, rhs: Self) {
        self.0 |= rhs.0;
    }
}

#[derive(Debug, Clone)]
pub struct GitReadRequest {
    pub repository: PathBuf,
    pub kind: GitReadKind,
    pub spec: GitCommandSpec,
}

impl GitReadRequest {
    pub fn new(repository: impl AsRef<Path>, kind: GitReadKind, spec: GitCommandSpec) -> Self {
        Self {
            repository: repository.as_ref().to_path_buf(),
            kind,
            spec,
        }
    }
}

#[derive(Clone)]
pub struct GitCoordinator {
    inner: Arc<CoordinatorInner>,
}

struct CoordinatorInner {
    next_request_id: AtomicU64,
    repository_touch: AtomicU64,
    cache_touch: AtomicU64,
    cache_bytes: AtomicUsize,
    requests: Mutex<HashMap<u64, ActiveRequest>>,
    completed_cleanup_failures: Mutex<HashMap<String, Vec<String>>>,
    repositories: Mutex<HashMap<PathBuf, Arc<RepositoryState>>>,
}

struct ActiveRequest {
    token: CancellationToken,
    workspace: PathBuf,
    repository: Option<PathBuf>,
    window_id: Option<String>,
}

pub struct RequestHandle {
    id: u64,
    token: CancellationToken,
    inner: Weak<CoordinatorInner>,
}

impl RequestHandle {
    pub fn token(&self) -> CancellationToken {
        self.token.clone()
    }

    #[cfg(test)]
    pub fn cancel(&self) {
        self.token.cancel();
    }

    pub fn bind_repository(&self, repository: impl AsRef<Path>) {
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        let mut requests = lock_unpoison(&inner.requests);
        if let Some(request) = requests.get_mut(&self.id) {
            request.repository = Some(canonical_key(repository.as_ref()));
        }
    }
}

impl Drop for RequestHandle {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade() {
            let mut requests = lock_unpoison(&inner.requests);
            if let Some(request) = requests.remove(&self.id) {
                if let Some(window_id) = request.window_id {
                    let failures = request.token.cleanup_failures();
                    if !failures.is_empty() {
                        let mut completed = lock_unpoison(&inner.completed_cleanup_failures);
                        let window_failures = completed.entry(window_id).or_default();
                        for failure in failures {
                            if !window_failures.contains(&failure) {
                                window_failures.push(failure);
                            }
                        }
                    }
                }
            }
        }
    }
}

impl Default for GitCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

impl GitCoordinator {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(CoordinatorInner {
                next_request_id: AtomicU64::new(1),
                repository_touch: AtomicU64::new(1),
                cache_touch: AtomicU64::new(1),
                cache_bytes: AtomicUsize::new(0),
                requests: Mutex::new(HashMap::new()),
                completed_cleanup_failures: Mutex::new(HashMap::new()),
                repositories: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn begin_request(
        &self,
        workspace: impl AsRef<Path>,
        window_id: Option<&str>,
    ) -> RequestHandle {
        self.begin_request_with_repository(workspace, None, window_id)
    }

    pub fn begin_request_with_repository(
        &self,
        workspace: impl AsRef<Path>,
        repository: Option<&Path>,
        window_id: Option<&str>,
    ) -> RequestHandle {
        let token = CancellationToken::new();
        let id = self.inner.next_request_id.fetch_add(1, Ordering::Relaxed);
        lock_unpoison(&self.inner.requests).insert(
            id,
            ActiveRequest {
                token: token.clone(),
                workspace: canonical_key(workspace.as_ref()),
                repository: repository.map(canonical_key),
                window_id: window_id.map(str::to_string),
            },
        );
        RequestHandle {
            id,
            token,
            inner: Arc::downgrade(&self.inner),
        }
    }

    #[cfg(test)]
    pub fn cancel_window(&self, window_id: &str) -> usize {
        self.cancel_matching(|request| request.window_id.as_deref() == Some(window_id))
    }

    /// Cancel this window's Git requests and wait for their request scopes to
    /// finish. Final shared-query subscribers remain registered until the
    /// worker has reaped its process tree; non-final subscribers may drain
    /// while another window continues to use the shared query.
    pub fn cancel_window_and_wait(&self, window_id: &str, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout.min(WINDOW_CANCEL_WAIT_MAX);
        let mut observed_tokens = HashMap::<u64, CancellationToken>::new();
        let mut pending_requests = 0;

        loop {
            let active = {
                let requests = lock_unpoison(&self.inner.requests);
                requests
                    .iter()
                    .filter(|(_, request)| request.window_id.as_deref() == Some(window_id))
                    .map(|(id, request)| {
                        request.token.cancel();
                        (*id, request.token.clone())
                    })
                    .collect::<Vec<_>>()
            };

            for (id, token) in active.iter().cloned() {
                observed_tokens.insert(id, token);
            }
            if active.is_empty() {
                break;
            }

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                pending_requests = active.len();
                break;
            }
            thread::sleep(PROCESS_POLL_INTERVAL.min(remaining));
        }

        let mut failures = lock_unpoison(&self.inner.completed_cleanup_failures)
            .get(window_id)
            .cloned()
            .unwrap_or_default();
        for token in observed_tokens.values() {
            for failure in token.cleanup_failures() {
                if !failures.contains(&failure) {
                    failures.push(failure);
                }
            }
        }
        if pending_requests > 0 {
            failures.insert(
                0,
                format!(
                    "Git cleanup for window {window_id:?} did not finish within {:?}; {pending_requests} request(s) remain active.",
                    timeout.min(WINDOW_CANCEL_WAIT_MAX)
                ),
            );
        }

        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("\n"))
        }
    }

    pub fn cancel_workspace(&self, window_id: &str, workspace: impl AsRef<Path>) -> usize {
        let workspace = canonical_key(workspace.as_ref());
        self.cancel_matching(|request| {
            request.window_id.as_deref() == Some(window_id) && request.workspace == workspace
        })
    }

    #[cfg(test)]
    pub fn repository_count(&self) -> usize {
        lock_unpoison(&self.inner.repositories).len()
    }

    pub fn invalidate(&self, repository: impl AsRef<Path>, scope: GitDirtyScope) -> GitRevisions {
        let Some(repository) = self.repository_state(repository.as_ref()) else {
            return GitRevisions::default();
        };
        let mut state = lock_unpoison(&repository.state);
        if scope.contains(GitDirtyScope::WORKTREE) {
            state.revisions.worktree = state.revisions.worktree.wrapping_add(1);
        }
        if scope.contains(GitDirtyScope::INDEX) {
            state.revisions.index = state.revisions.index.wrapping_add(1);
        }
        if scope.contains(GitDirtyScope::REFS) {
            state.revisions.refs = state.revisions.refs.wrapping_add(1);
        }
        if scope.contains(GitDirtyScope::REFS) || scope.contains(GitDirtyScope::HEAD) {
            state.revisions.head = state.revisions.head.wrapping_add(1);
        }
        for (key, flight) in &state.flights {
            let affected = match key.kind {
                GitReadKind::Status => {
                    scope.contains(GitDirtyScope::WORKTREE)
                        || scope.contains(GitDirtyScope::INDEX)
                        || scope.contains(GitDirtyScope::HEAD)
                }
                GitReadKind::Refs | GitReadKind::History => {
                    scope.contains(GitDirtyScope::REFS) || scope.contains(GitDirtyScope::HEAD)
                }
            };
            if affected {
                flight.cancel.cancel();
            }
        }
        let stale_keys: Vec<QueryKey> = state
            .cache
            .iter()
            .filter_map(|(key, entry)| {
                (entry.revision != state.revisions.for_kind(key.kind)).then(|| key.clone())
            })
            .collect();
        let mut released_bytes = 0usize;
        for key in stale_keys {
            if let Some(entry) = state.cache.remove(&key) {
                let bytes = entry.accounted_bytes;
                state.cache_bytes = state.cache_bytes.saturating_sub(bytes);
                released_bytes = released_bytes.saturating_add(bytes);
            }
        }
        if released_bytes > 0 {
            self.inner
                .cache_bytes
                .fetch_sub(released_bytes, Ordering::AcqRel);
        }
        state.revisions
    }

    #[cfg(test)]
    pub fn revisions(&self, repository: impl AsRef<Path>) -> GitRevisions {
        let Some(repository) = self.repository_state(repository.as_ref()) else {
            return GitRevisions::default();
        };
        let revisions = lock_unpoison(&repository.state).revisions;
        revisions
    }

    pub fn read_shared(
        &self,
        request: GitReadRequest,
        token: &CancellationToken,
    ) -> Result<GitCommandOutput, GitRuntimeError> {
        self.read_shared_internal(request, token, None)
    }

    /// Read or join a shared Git query while respecting a request-wide
    /// deadline. A non-final subscriber can leave an in-flight query without
    /// interrupting other callers; the final subscriber cancels and waits for
    /// bounded process cleanup.
    pub fn read_shared_until(
        &self,
        request: GitReadRequest,
        token: &CancellationToken,
        deadline: Instant,
    ) -> Result<GitCommandOutput, GitRuntimeError> {
        self.read_shared_internal(request, token, Some(deadline))
    }

    fn read_shared_internal(
        &self,
        request: GitReadRequest,
        token: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<GitCommandOutput, GitRuntimeError> {
        if token.is_cancelled() {
            return Err(GitRuntimeError::cancelled());
        }

        let repository_key = canonical_key(&request.repository);
        let Some(state) = self.repository_state(&repository_key) else {
            return Err(GitRuntimeError::capacity());
        };
        let key = QueryKey::from_request(&repository_key, &request);

        let (flight, should_start, revision) = loop {
            if token.is_cancelled() {
                return Err(GitRuntimeError::cancelled());
            }
            let mut cleanup_flight = None;
            let decision = {
                let mut state = lock_unpoison(&state.state);
                let revision = state.revisions.for_kind(request.kind);
                if let Some(cache) = state.cache.get_mut(&key) {
                    if cache.revision == revision {
                        cache.last_used = self.inner.cache_touch.fetch_add(1, Ordering::Relaxed);
                        let output = Arc::clone(&cache.output);
                        drop(state);
                        return Ok(output.as_ref().clone());
                    }
                }

                if let Some(flight) = state.flights.get(&key) {
                    if flight.revision == revision && !flight.cancel.is_cancelled() {
                        flight.subscribers.fetch_add(1, Ordering::AcqRel);
                        Some((Arc::clone(flight), false, revision))
                    } else if flight.cancel.is_cancelled()
                        && !flight.finished.load(Ordering::Acquire)
                    {
                        // Keep a cancelled worker in the map until its
                        // process cleanup completes. A new subscriber waits
                        // for that bounded cleanup instead of orphaning the
                        // old worker while replacing the map entry.
                        cleanup_flight = Some(Arc::clone(flight));
                        None
                    } else {
                        let flight = Arc::new(QueryFlight::new(revision));
                        flight.subscribers.fetch_add(1, Ordering::AcqRel);
                        state.flights.insert(key.clone(), Arc::clone(&flight));
                        Some((flight, true, revision))
                    }
                } else {
                    let flight = Arc::new(QueryFlight::new(revision));
                    flight.subscribers.fetch_add(1, Ordering::AcqRel);
                    state.flights.insert(key.clone(), Arc::clone(&flight));
                    Some((flight, true, revision))
                }
            };
            if let Some(decision) = decision {
                break decision;
            }
            if let Some(flight) = cleanup_flight {
                flight.wait_for_completion(Some(token))?;
                continue;
            }
        };

        if should_start {
            let coordinator = self.clone();
            let state_for_worker = Arc::clone(&state);
            let key_for_worker = key.clone();
            let spec = request.spec;
            let worker = Arc::clone(&flight);
            let spawn_result = thread::Builder::new()
                .name("pude-git-read".to_string())
                .spawn(move || {
                    let result = catch_unwind(AssertUnwindSafe(|| {
                        coordinator.execute(spec, &worker.cancel)
                    }))
                    .unwrap_or_else(|_| Err(GitRuntimeError::internal("Git worker panicked.")));
                    coordinator.complete_flight(
                        state_for_worker,
                        key_for_worker,
                        worker,
                        revision,
                        result,
                    );
                });
            if let Err(error) = spawn_result {
                self.complete_flight(
                    state,
                    key,
                    Arc::clone(&flight),
                    revision,
                    Err(GitRuntimeError::io("start Git worker", error)),
                );
            }
        }

        flight.wait_until(token, deadline)
    }

    pub fn read_shared_for(
        &self,
        request: GitReadRequest,
        handle: &RequestHandle,
    ) -> Result<GitCommandOutput, GitRuntimeError> {
        let result = self.read_shared(request, &handle.token);
        if let Err(error) = &result {
            handle.token.record_cleanup_failure(error);
        }
        result
    }

    pub fn execute(
        &self,
        spec: GitCommandSpec,
        token: &CancellationToken,
    ) -> Result<GitCommandOutput, GitRuntimeError> {
        execute_process(spec, token)
    }

    fn cancel_matching<F>(&self, matches: F) -> usize
    where
        F: Fn(&ActiveRequest) -> bool,
    {
        let requests = lock_unpoison(&self.inner.requests);
        let mut cancelled = 0;
        for request in requests.values() {
            if matches(request) {
                request.token.cancel();
                cancelled += 1;
            }
        }
        cancelled
    }

    fn repository_state(&self, repository: &Path) -> Option<Arc<RepositoryState>> {
        let key = canonical_key(repository);
        let mut repositories = lock_unpoison(&self.inner.repositories);
        let touch = self.inner.repository_touch.fetch_add(1, Ordering::Relaxed);
        if let Some(state) = repositories.get(&key) {
            state.last_used.store(touch, Ordering::Relaxed);
            return Some(Arc::clone(state));
        }
        if repositories.len() >= MAX_REPOSITORY_STATES {
            let evict_key = repositories
                .iter()
                .filter(|(_, state)| {
                    let inner = lock_unpoison(&state.state);
                    inner.flights.is_empty() && Arc::strong_count(state) == 1
                })
                .min_by_key(|(_, state)| state.last_used.load(Ordering::Relaxed))
                .map(|(key, _)| key.clone());
            if let Some(evict_key) = evict_key {
                if let Some(evicted) = repositories.remove(&evict_key) {
                    let released = lock_unpoison(&evicted.state).cache_bytes;
                    if released > 0 {
                        self.inner.cache_bytes.fetch_sub(released, Ordering::AcqRel);
                    }
                }
            } else {
                return None;
            }
        }
        let state = Arc::new(RepositoryState::default());
        state.last_used.store(touch, Ordering::Relaxed);
        repositories.insert(key, Arc::clone(&state));
        Some(state)
    }

    fn complete_flight(
        &self,
        repository: Arc<RepositoryState>,
        key: QueryKey,
        flight: Arc<QueryFlight>,
        revision: GitRevision,
        result: Result<GitCommandOutput, GitRuntimeError>,
    ) {
        let result = result.map(Arc::new);
        let mut state = lock_unpoison(&repository.state);
        if state.revisions.for_kind(key.kind) == revision {
            if let Ok(output) = &result {
                if output.success {
                    let accounted_bytes = output
                        .stdout
                        .len()
                        .saturating_add(output.stderr.len())
                        .saturating_add(key.stdin.as_ref().map_or(0, |input| input.len()));
                    if accounted_bytes <= MAX_CACHE_BYTES_PER_REPOSITORY
                        && MAX_CACHE_ENTRIES_PER_REPOSITORY > 0
                    {
                        if let Some(replaced) = state.cache.remove(&key) {
                            state.cache_bytes =
                                state.cache_bytes.saturating_sub(replaced.accounted_bytes);
                            self.inner
                                .cache_bytes
                                .fetch_sub(replaced.accounted_bytes, Ordering::AcqRel);
                        }
                        let last_used = self.inner.cache_touch.fetch_add(1, Ordering::Relaxed);
                        state.cache_bytes = state.cache_bytes.saturating_add(accounted_bytes);
                        self.inner
                            .cache_bytes
                            .fetch_add(accounted_bytes, Ordering::AcqRel);
                        state.cache.insert(
                            key.clone(),
                            CachedOutput {
                                revision,
                                output: Arc::clone(output),
                                accounted_bytes,
                                last_used,
                            },
                        );
                        self.evict_local_cache_entries(&mut state);
                    }
                }
            }
        }
        if state
            .flights
            .get(&key)
            .is_some_and(|current| Arc::ptr_eq(current, &flight))
        {
            state.flights.remove(&key);
        }
        drop(state);
        flight.finish(result);
        self.trim_global_cache();
    }

    fn evict_local_cache_entries(&self, state: &mut RepositoryStateInner) {
        while state.cache.len() > MAX_CACHE_ENTRIES_PER_REPOSITORY
            || state.cache_bytes > MAX_CACHE_BYTES_PER_REPOSITORY
        {
            let Some(evict_key) = state
                .cache
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(evicted) = state.cache.remove(&evict_key) {
                state.cache_bytes = state.cache_bytes.saturating_sub(evicted.accounted_bytes);
                self.inner
                    .cache_bytes
                    .fetch_sub(evicted.accounted_bytes, Ordering::AcqRel);
            }
        }
    }

    fn trim_global_cache(&self) {
        self.trim_global_cache_to(MAX_CACHE_BYTES_GLOBAL);
    }

    fn trim_global_cache_to(&self, byte_limit: usize) {
        while self.inner.cache_bytes.load(Ordering::Acquire) > byte_limit {
            let candidate = {
                let repositories = lock_unpoison(&self.inner.repositories);
                repositories
                    .iter()
                    .filter_map(|(repository_key, repository)| {
                        let state = lock_unpoison(&repository.state);
                        state
                            .cache
                            .iter()
                            .min_by_key(|(_, entry)| entry.last_used)
                            .map(|(key, entry)| {
                                (
                                    repository_key.clone(),
                                    Arc::clone(repository),
                                    key.clone(),
                                    entry.last_used,
                                )
                            })
                    })
                    .min_by_key(|(_, _, _, last_used)| *last_used)
            };
            let Some((_repository_key, repository, key, expected_touch)) = candidate else {
                break;
            };
            let mut state = lock_unpoison(&repository.state);
            if state
                .cache
                .get(&key)
                .is_some_and(|entry| entry.last_used == expected_touch)
            {
                if let Some(evicted) = state.cache.remove(&key) {
                    state.cache_bytes = state.cache_bytes.saturating_sub(evicted.accounted_bytes);
                    self.inner
                        .cache_bytes
                        .fetch_sub(evicted.accounted_bytes, Ordering::AcqRel);
                }
            }
        }
    }
}

struct RepositoryState {
    state: Mutex<RepositoryStateInner>,
    last_used: AtomicU64,
}

#[derive(Default)]
struct RepositoryStateInner {
    revisions: GitRevisions,
    cache: HashMap<QueryKey, CachedOutput>,
    cache_bytes: usize,
    flights: HashMap<QueryKey, Arc<QueryFlight>>,
}

impl Default for RepositoryState {
    fn default() -> Self {
        Self {
            state: Mutex::new(RepositoryStateInner::default()),
            last_used: AtomicU64::new(0),
        }
    }
}

#[derive(Debug, Clone)]
struct CachedOutput {
    revision: GitRevision,
    output: Arc<GitCommandOutput>,
    accounted_bytes: usize,
    last_used: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct QueryKey {
    repository: PathBuf,
    kind: GitReadKind,
    program: OsString,
    cwd: PathBuf,
    args: Vec<OsString>,
    stdin: Option<Arc<[u8]>>,
    no_optional_locks: bool,
    timeout: Duration,
    stdout_limit: usize,
    stderr_limit: usize,
}

impl QueryKey {
    fn from_request(repository: &Path, request: &GitReadRequest) -> Self {
        Self {
            repository: repository.to_path_buf(),
            kind: request.kind,
            program: request.spec.program.clone(),
            cwd: canonical_key(&request.spec.cwd),
            args: request.spec.args.clone(),
            stdin: request.spec.stdin.clone(),
            no_optional_locks: request.spec.no_optional_locks,
            timeout: request.spec.timeout,
            stdout_limit: request.spec.stdout_limit,
            stderr_limit: request.spec.stderr_limit,
        }
    }
}

struct QueryFlight {
    revision: GitRevision,
    subscribers: AtomicUsize,
    cancel: CancellationToken,
    finished: AtomicBool,
    result: Mutex<Option<Result<Arc<GitCommandOutput>, GitRuntimeError>>>,
    wake: Condvar,
}

impl QueryFlight {
    fn new(revision: GitRevision) -> Self {
        Self {
            revision,
            subscribers: AtomicUsize::new(0),
            cancel: CancellationToken::new(),
            finished: AtomicBool::new(false),
            result: Mutex::new(None),
            wake: Condvar::new(),
        }
    }

    fn finish(&self, result: Result<Arc<GitCommandOutput>, GitRuntimeError>) {
        self.finished.store(true, Ordering::Release);
        *lock_unpoison(&self.result) = Some(result);
        self.wake.notify_all();
    }

    fn release_subscriber(&self) -> bool {
        let last_subscriber = self.subscribers.fetch_sub(1, Ordering::AcqRel) == 1;
        if last_subscriber && !self.finished.load(Ordering::Acquire) {
            self.cancel.cancel();
        }
        last_subscriber
    }

    fn wait_for_completion(
        &self,
        cancellation: Option<&CancellationToken>,
    ) -> Result<(), GitRuntimeError> {
        let deadline = Instant::now() + FLIGHT_CLEANUP_DEADLINE;
        let mut result = lock_unpoison(&self.result);
        while result.is_none() {
            if cancellation.is_some_and(CancellationToken::is_cancelled) {
                return Err(GitRuntimeError::cancelled());
            }
            if Instant::now() >= deadline {
                return Err(GitRuntimeError::cleanup(
                    "Git shared query worker did not finish cleanup before the deadline.",
                ));
            }
            let (next, _) = self
                .wake
                .wait_timeout(result, FLIGHT_WAIT_INTERVAL)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            result = next;
        }
        Ok(())
    }

    fn wait(&self, token: &CancellationToken) -> Result<GitCommandOutput, GitRuntimeError> {
        self.wait_until(token, None)
    }

    fn wait_until(
        &self,
        token: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<GitCommandOutput, GitRuntimeError> {
        let mut result = lock_unpoison(&self.result);
        loop {
            if let Some(result) = result.as_ref() {
                let result = result.clone();
                let _ = self.release_subscriber();
                return result.map(|output| output.as_ref().clone());
            }
            if token.is_cancelled() {
                drop(result);
                if self.release_subscriber() {
                    // A final subscriber owns the shared process cleanup. Do
                    // not report cancellation until the worker has reaped the
                    // child and released its spool files.
                    self.wait_for_completion(None)?;
                    if let Some(Err(error)) = lock_unpoison(&self.result).as_ref() {
                        return Err(error.clone());
                    }
                }
                return Err(GitRuntimeError::cancelled());
            }
            if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                drop(result);
                if self.release_subscriber() {
                    self.wait_for_completion(None)?;
                }
                return Err(GitRuntimeError::new(
                    GitErrorKind::TimedOut,
                    "Git shared query exceeded the request deadline.",
                ));
            }
            let wait_duration = deadline
                .map(|deadline| {
                    deadline
                        .saturating_duration_since(Instant::now())
                        .min(FLIGHT_WAIT_INTERVAL)
                })
                .unwrap_or(FLIGHT_WAIT_INTERVAL);
            let (next, _) = self
                .wake
                .wait_timeout(result, wait_duration)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            result = next;
        }
    }
}

struct OutputSpool {
    directory: PathBuf,
    path: PathBuf,
}

impl OutputSpool {
    fn create(label: &str) -> Result<(Self, File), GitRuntimeError> {
        let base = std::env::temp_dir();
        for _ in 0..SPOOL_CREATE_ATTEMPTS {
            let sequence = SPOOL_COUNTER.fetch_add(1, Ordering::Relaxed);
            let directory = base.join(format!(
                "pude-git-runtime-{}-{}",
                std::process::id(),
                sequence
            ));
            match fs::create_dir(&directory) {
                Ok(()) => {
                    let path = directory.join(label);
                    match OpenOptions::new().write(true).create_new(true).open(&path) {
                        Ok(file) => return Ok((Self { directory, path }, file)),
                        Err(error) => {
                            let _ = fs::remove_dir(&directory);
                            return Err(GitRuntimeError::io("create Git output spool", error));
                        }
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(GitRuntimeError::io("create Git output spool", error)),
            }
        }
        Err(GitRuntimeError::internal(
            "Unable to allocate a unique Git output spool.",
        ))
    }
}

impl Drop for OutputSpool {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        let _ = fs::remove_dir(&self.directory);
    }
}

struct ProcessTreeGuard {
    #[cfg(unix)]
    process_group: u32,
    #[cfg(windows)]
    job: Option<WindowsJobHandle>,
    #[cfg(windows)]
    process_id: u32,
    cleanup_requested: AtomicBool,
    cleanup_deadline: Mutex<Option<Instant>>,
    cleanup_error: Mutex<Option<String>>,
}

impl ProcessTreeGuard {
    #[cfg(unix)]
    fn attach(child: &Child) -> Self {
        Self {
            process_group: child.id(),
            cleanup_requested: AtomicBool::new(false),
            cleanup_deadline: Mutex::new(None),
            cleanup_error: Mutex::new(None),
        }
    }

    #[cfg(windows)]
    fn attach(child: &Child) -> io::Result<Self> {
        let job = create_windows_job(child)?;
        if let Err(error) = resume_windows_process(child.id()) {
            unsafe {
                let _ = TerminateJobObject(job, 1);
                let _ = WaitForSingleObject(job, PROCESS_TERMINATION_DEADLINE.as_millis() as u32);
                let _ = CloseHandle(job);
            }
            return Err(error);
        }
        Ok(Self {
            job: Some(job),
            process_id: child.id(),
            cleanup_requested: AtomicBool::new(false),
            cleanup_deadline: Mutex::new(None),
            cleanup_error: Mutex::new(None),
        })
    }

    fn arm_cleanup(&self) {
        self.cleanup_requested.store(true, Ordering::Release);
        let mut deadline = self
            .cleanup_deadline
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        deadline.get_or_insert_with(|| Instant::now() + PROCESS_TERMINATION_DEADLINE);
    }

    fn disarm_cleanup(&self) {
        self.cleanup_requested.store(false, Ordering::Release);
        *self
            .cleanup_deadline
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }

    fn cleanup_deadline(&self) -> Instant {
        self.cleanup_deadline
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .unwrap_or_else(|| Instant::now() + PROCESS_TERMINATION_DEADLINE)
    }

    fn mark_cleanup_failed(&self, error: impl Into<String>) {
        let mut cleanup_error = self
            .cleanup_error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if cleanup_error.is_none() {
            *cleanup_error = Some(error.into());
        }
    }

    fn cleanup_error(&self) -> Option<String> {
        self.cleanup_error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn terminate_descendants(&self) -> Result<(), String> {
        #[cfg(unix)]
        {
            terminate_unix_process_group(self.process_group)
        }
        #[cfg(windows)]
        {
            let job = self
                .job
                .ok_or_else(|| "Git process Job Object is unavailable.".to_string())?;
            terminate_windows_job(job, self.process_id)
        }
    }

    fn wait_until_empty(&self, deadline: Instant) -> Result<(), String> {
        #[cfg(unix)]
        {
            wait_for_unix_process_group(self.process_group, deadline)
        }
        #[cfg(windows)]
        {
            let job = self
                .job
                .ok_or_else(|| "Git process Job Object is unavailable.".to_string())?;
            wait_for_windows_job(job, deadline)
        }
    }
}

#[cfg(windows)]
type WindowsJobHandle = *mut std::ffi::c_void;

#[cfg(windows)]
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: u32 = 9;
#[cfg(windows)]
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
#[cfg(windows)]
const THREAD_SUSPEND_RESUME: u32 = 0x0002;
#[cfg(windows)]
const TH32CS_SNAPTHREAD: u32 = 0x00000004;
#[cfg(windows)]
const INVALID_HANDLE_VALUE: WindowsJobHandle = -1isize as WindowsJobHandle;
#[cfg(windows)]
const WAIT_OBJECT_0: u32 = 0;
#[cfg(windows)]
const WAIT_TIMEOUT: u32 = 258;
#[cfg(windows)]
const WAIT_FAILED: u32 = u32::MAX;

#[cfg(windows)]
#[repr(C)]
struct WindowsJobObjectBasicLimitInformation {
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
struct WindowsIoCounters {
    read_operations: u64,
    write_operations: u64,
    other_operations: u64,
    read_bytes: u64,
    write_bytes: u64,
    other_bytes: u64,
}

#[cfg(windows)]
#[repr(C)]
struct WindowsJobObjectExtendedLimitInformation {
    basic_limit_information: WindowsJobObjectBasicLimitInformation,
    io_info: WindowsIoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[cfg(windows)]
#[repr(C)]
struct WindowsThreadEntry32 {
    size: u32,
    usage: u32,
    thread_id: u32,
    owner_process_id: u32,
    base_priority: i32,
    delta_priority: i32,
    flags: u32,
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn AssignProcessToJobObject(job: WindowsJobHandle, process: WindowsJobHandle) -> i32;
    fn CloseHandle(handle: WindowsJobHandle) -> i32;
    fn CreateEventW(
        attributes: *mut std::ffi::c_void,
        manual_reset: i32,
        initial_state: i32,
        name: *const u16,
    ) -> WindowsJobHandle;
    fn CreateJobObjectW(attributes: *mut std::ffi::c_void, name: *const u16) -> WindowsJobHandle;
    fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> WindowsJobHandle;
    fn OpenThread(access: u32, inherit: i32, thread_id: u32) -> WindowsJobHandle;
    fn ResumeThread(thread: WindowsJobHandle) -> u32;
    fn SetInformationJobObject(
        job: WindowsJobHandle,
        information_class: u32,
        information: *mut std::ffi::c_void,
        information_length: u32,
    ) -> i32;
    fn Thread32First(snapshot: WindowsJobHandle, entry: *mut WindowsThreadEntry32) -> i32;
    fn Thread32Next(snapshot: WindowsJobHandle, entry: *mut WindowsThreadEntry32) -> i32;
    fn TerminateJobObject(job: WindowsJobHandle, exit_code: u32) -> i32;
    fn WaitForMultipleObjects(
        count: u32,
        handles: *const WindowsJobHandle,
        wait_all: i32,
        milliseconds: u32,
    ) -> u32;
    fn WaitForSingleObject(handle: WindowsJobHandle, milliseconds: u32) -> u32;
    fn SetEvent(event: WindowsJobHandle) -> i32;
}

#[cfg(windows)]
fn create_windows_job(child: &Child) -> io::Result<WindowsJobHandle> {
    let job = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
    if job.is_null() {
        return Err(io::Error::last_os_error());
    }
    let mut information = WindowsJobObjectExtendedLimitInformation {
        basic_limit_information: WindowsJobObjectBasicLimitInformation {
            per_process_user_time_limit: 0,
            per_job_user_time_limit: 0,
            limit_flags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            minimum_working_set_size: 0,
            maximum_working_set_size: 0,
            active_process_limit: 0,
            affinity: 0,
            priority_class: 0,
            scheduling_class: 0,
        },
        io_info: WindowsIoCounters {
            read_operations: 0,
            write_operations: 0,
            other_operations: 0,
            read_bytes: 0,
            write_bytes: 0,
            other_bytes: 0,
        },
        process_memory_limit: 0,
        job_memory_limit: 0,
        peak_process_memory_used: 0,
        peak_job_memory_used: 0,
    };
    let configured = unsafe {
        SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            (&mut information as *mut WindowsJobObjectExtendedLimitInformation).cast(),
            std::mem::size_of::<WindowsJobObjectExtendedLimitInformation>() as u32,
        )
    } != 0;
    let assigned = configured
        && unsafe { AssignProcessToJobObject(job, child.as_raw_handle() as WindowsJobHandle) != 0 };
    if !assigned {
        let error = io::Error::last_os_error();
        unsafe {
            let _ = CloseHandle(job);
        }
        Err(error)
    } else {
        Ok(job)
    }
}

#[cfg(windows)]
fn resume_windows_process(process_id: u32) -> io::Result<()> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }

    let mut entry = WindowsThreadEntry32 {
        size: std::mem::size_of::<WindowsThreadEntry32>() as u32,
        usage: 0,
        thread_id: 0,
        owner_process_id: 0,
        base_priority: 0,
        delta_priority: 0,
        flags: 0,
    };
    let mut found_thread = None;
    let mut has_entry = unsafe { Thread32First(snapshot, &mut entry) } != 0;
    while has_entry {
        if entry.owner_process_id == process_id {
            found_thread = Some(entry.thread_id);
            break;
        }
        has_entry = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
    }
    let snapshot_error = if found_thread.is_none() {
        Some(io::Error::last_os_error())
    } else {
        None
    };
    unsafe {
        let _ = CloseHandle(snapshot);
    }

    let thread_id = found_thread.ok_or_else(|| {
        snapshot_error
            .unwrap_or_else(|| io::Error::new(io::ErrorKind::NotFound, "process thread not found"))
    })?;
    let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id) };
    if thread.is_null() {
        return Err(io::Error::last_os_error());
    }
    let mut result = unsafe { ResumeThread(thread) };
    let mut error = None;
    while result != u32::MAX && result > 1 {
        result = unsafe { ResumeThread(thread) };
    }
    if result == u32::MAX {
        error = Some(io::Error::last_os_error());
    }
    unsafe {
        let _ = CloseHandle(thread);
    }
    error.map_or(Ok(()), Err)
}

#[cfg(windows)]
fn terminate_windows_job(job: WindowsJobHandle, process_id: u32) -> Result<(), String> {
    match unsafe { WaitForSingleObject(job, 0) } {
        WAIT_OBJECT_0 => return Ok(()),
        WAIT_TIMEOUT => {}
        WAIT_FAILED => {
            return Err(format!(
                "Unable to inspect Git Job Object before termination. {}",
                io::Error::last_os_error()
            ));
        }
        result => return Err(format!("Unexpected Git Job Object wait result: {result}.")),
    }

    if unsafe { TerminateJobObject(job, 1) } == 0 {
        match unsafe { WaitForSingleObject(job, 0) } {
            WAIT_OBJECT_0 => return Ok(()),
            _ => {
                let job_error = io::Error::last_os_error();
                if !terminate_windows_process_tree(process_id) {
                    return Err(format!(
                        "Unable to terminate Git Job Object ({job_error}) or its process tree with taskkill."
                    ));
                }
            }
        }
    }

    Ok(())
}

#[cfg(windows)]
fn wait_for_windows_job(job: WindowsJobHandle, deadline: Instant) -> Result<(), String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    let timeout = remaining.as_millis().min(u32::MAX as u128) as u32;
    match unsafe { WaitForSingleObject(job, timeout) } {
        WAIT_OBJECT_0 => Ok(()),
        WAIT_TIMEOUT => Err(
            "Git child processes did not leave the Job Object before the cleanup deadline."
                .to_string(),
        ),
        WAIT_FAILED => Err(format!(
            "Unable to wait for Git Job Object cleanup. {}",
            io::Error::last_os_error()
        )),
        result => Err(format!(
            "Unexpected Git Job Object cleanup result: {result}."
        )),
    }
}

#[cfg(windows)]
impl Drop for ProcessTreeGuard {
    fn drop(&mut self) {
        if self.cleanup_requested.load(Ordering::Acquire) {
            if let Some(job) = self.job {
                let _ = terminate_windows_job(job, self.process_id);
            }
        }
        if let Some(job) = self.job.take() {
            unsafe {
                let _ = CloseHandle(job);
            }
        }
    }
}

#[cfg(unix)]
impl Drop for ProcessTreeGuard {
    fn drop(&mut self) {
        if self.cleanup_requested.load(Ordering::Acquire) {
            let _ = terminate_unix_process_group(self.process_group);
        }
    }
}

#[cfg(unix)]
#[link(name = "c")]
extern "C" {
    fn kill(process_id: i32, signal: i32) -> i32;
}

#[cfg(unix)]
fn terminate_unix_process_group(process_group: u32) -> Result<(), String> {
    const SIGKILL: i32 = 9;
    let result = unsafe { kill(-(process_group as i32), SIGKILL) };
    if result != 0 {
        let error = io::Error::last_os_error();
        if super::process_group::is_group_gone(&error) {
            return Ok(());
        }
        return Err(format!("Unable to signal Git process group. {error}"));
    }

    Ok(())
}

#[cfg(unix)]
fn wait_for_unix_process_group(process_group: u32, deadline: Instant) -> Result<(), String> {
    loop {
        let result = unsafe { kill(-(process_group as i32), 0) };
        if result != 0 {
            let error = io::Error::last_os_error();
            if super::process_group::is_group_gone(&error) {
                return Ok(());
            }
            return Err(format!(
                "Unable to inspect Git process group cleanup. {error}"
            ));
        }
        if Instant::now() >= deadline {
            return Err(
                "Git child processes did not leave the process group before the cleanup deadline."
                    .to_string(),
            );
        }
        thread::sleep(PROCESS_POLL_INTERVAL);
    }
}

#[cfg(test)]
static FORCE_SPOOL_PATH: AtomicBool = AtomicBool::new(false);

fn use_spool_fallback() -> bool {
    #[cfg(test)]
    if FORCE_SPOOL_PATH.load(Ordering::Relaxed) {
        return true;
    }
    std::env::var_os("PUDE_GIT_SPOOL").is_some_and(|value| value == "1")
}

fn execute_process(
    spec: GitCommandSpec,
    token: &CancellationToken,
) -> Result<GitCommandOutput, GitRuntimeError> {
    let result = execute_process_inner(spec, token);
    if let Err(error) = &result {
        token.record_cleanup_failure(error);
    }
    result
}

fn execute_process_inner(
    spec: GitCommandSpec,
    token: &CancellationToken,
) -> Result<GitCommandOutput, GitRuntimeError> {
    if use_spool_fallback() {
        execute_process_spooled(spec, token)
    } else {
        execute_process_piped(spec, token)
    }
}

fn build_git_command(spec: &GitCommandSpec) -> Command {
    #[cfg(target_os = "macos")]
    let program = resolve_macos_git_program(&spec.program);
    #[cfg(not(target_os = "macos"))]
    let program = spec.program.clone();
    let mut command = Command::new(&program);
    if spec.no_optional_locks {
        // An empty value disables both legacy hook paths and modern built-in
        // fsmonitor, without changing the repository or the user's config.
        command.args(["--no-optional-locks", "-c", "core.fsmonitor="]);
    }
    // Never let Git block on interactive credential prompts in the parent's
    // terminal; helpers (GCM, osxkeychain, …) are unaffected.
    command.env("GIT_TERMINAL_PROMPT", "0");
    // Error classification reads Git's English messages; a localized Git would
    // report "not a repository" as a generic failure.
    command.env("LC_ALL", "C");
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .stdin(Stdio::null());
    command
}

fn prepare_git_stdin(
    command: &mut Command,
    spec: &GitCommandSpec,
) -> Result<Option<OutputSpool>, GitRuntimeError> {
    let Some(input) = &spec.stdin else {
        return Ok(None);
    };
    if input.len() > MAX_STDIN_BYTES {
        return Err(GitRuntimeError::output_limit("stdin", MAX_STDIN_BYTES));
    }
    // File-backed stdin avoids a pipe writer blocking on Git's output.
    let (spool, mut writer) = OutputSpool::create("stdin")?;
    writer
        .write_all(input)
        .map_err(|error| GitRuntimeError::io("write Git stdin", error))?;
    drop(writer);
    command.stdin(
        File::open(&spool.path).map_err(|error| GitRuntimeError::io("open Git stdin", error))?,
    );
    Ok(Some(spool))
}

fn execute_process_spooled(
    spec: GitCommandSpec,
    token: &CancellationToken,
) -> Result<GitCommandOutput, GitRuntimeError> {
    if token.is_cancelled() {
        return Err(GitRuntimeError::cancelled());
    }

    let (stdout_spool, stdout_file) = OutputSpool::create("stdout")?;
    let (stderr_spool, stderr_file) = match OutputSpool::create("stderr") {
        Ok(value) => value,
        Err(error) => return Err(error),
    };
    let mut command = build_git_command(&spec);
    let _stdin_spool = prepare_git_stdin(&mut command, &spec)?;
    let mut child = command
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                GitRuntimeError::unavailable(error)
            } else {
                GitRuntimeError::io("start Git command", error)
            }
        })?;
    drop(command);
    #[cfg(unix)]
    let process_tree = ProcessTreeGuard::attach(&child);
    #[cfg(windows)]
    let process_tree = match ProcessTreeGuard::attach(&child) {
        Ok(process_tree) => process_tree,
        Err(error) => {
            let reap_detail = reap_failed_windows_spawn(&mut child);
            return Err(GitRuntimeError::cleanup(format!(
                "Unable to assign or resume Git in a Windows Job Object. {error} {reap_detail}"
            )));
        }
    };

    let started = Instant::now();
    let mut termination_reason = None;
    let status = loop {
        if token.is_cancelled() {
            termination_reason = Some(GitRuntimeError::cancelled());
            terminate_process_tree(&mut child, &process_tree);
            break wait_for_terminated_child(&mut child, &process_tree);
        }
        match spool_exceeds(&stdout_spool.path, spec.stdout_limit) {
            Ok(true) => {
                termination_reason =
                    Some(GitRuntimeError::output_limit("stdout", spec.stdout_limit));
                terminate_process_tree(&mut child, &process_tree);
                break wait_for_terminated_child(&mut child, &process_tree);
            }
            Ok(false) => {}
            Err(error) => {
                termination_reason = Some(GitRuntimeError::io("inspect Git stdout spool", error));
                terminate_process_tree(&mut child, &process_tree);
                break wait_for_terminated_child(&mut child, &process_tree);
            }
        }
        match spool_exceeds(&stderr_spool.path, spec.stderr_limit) {
            Ok(true) => {
                termination_reason =
                    Some(GitRuntimeError::output_limit("stderr", spec.stderr_limit));
                terminate_process_tree(&mut child, &process_tree);
                break wait_for_terminated_child(&mut child, &process_tree);
            }
            Ok(false) => {}
            Err(error) => {
                termination_reason = Some(GitRuntimeError::io("inspect Git stderr spool", error));
                terminate_process_tree(&mut child, &process_tree);
                break wait_for_terminated_child(&mut child, &process_tree);
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() >= spec.timeout => {
                termination_reason = Some(GitRuntimeError::timed_out(spec.timeout));
                terminate_process_tree(&mut child, &process_tree);
                break wait_for_terminated_child(&mut child, &process_tree);
            }
            Ok(None) => thread::sleep(
                spec.poll_interval
                    .max(PROCESS_POLL_INTERVAL)
                    .min(Duration::from_millis(100)),
            ),
            Err(error) => {
                termination_reason = Some(GitRuntimeError::io("monitor Git command", error));
                terminate_process_tree(&mut child, &process_tree);
                break wait_for_terminated_child(&mut child, &process_tree);
            }
        }
    };

    let status = status?;
    terminate_process_tree_after_exit(&mut child, &process_tree);
    let stdout = read_spool(&stdout_spool.path, spec.stdout_limit, "stdout");
    let stderr = read_spool(&stderr_spool.path, spec.stderr_limit, "stderr");
    if let Some(reason) = termination_reason {
        let mut reason = reason;
        if let Some(error) = process_tree.cleanup_error() {
            reason = GitRuntimeError::cleanup(
                "Git command stopped, but its process tree did not finish cleanup successfully.",
            )
            .with_detail(error);
        }
        if let Err(error) = &stdout {
            reason = reason.with_detail(format!("Git stdout cleanup/read detail: {error}"));
        }
        if let Err(error) = &stderr {
            reason = reason.with_detail(format!("Git stderr cleanup/read detail: {error}"));
        }
        if stdout.is_ok() && stderr.is_ok() {
            process_tree.disarm_cleanup();
        }
        return Err(reason);
    }
    if let Some(cleanup_detail) = process_tree.cleanup_error() {
        let mut error = GitRuntimeError::cleanup(
            "Git command exited, but its child process tree did not finish cleanup successfully.",
        );
        error = error.with_detail(cleanup_detail);
        if let Err(detail) = &stdout {
            error = error.with_detail(format!("Git stdout cleanup/read detail: {detail}"));
        }
        if let Err(detail) = &stderr {
            error = error.with_detail(format!("Git stderr cleanup/read detail: {detail}"));
        }
        return Err(error);
    }
    let stdout = stdout?;
    let stderr = stderr?;
    process_tree.disarm_cleanup();
    Ok(GitCommandOutput {
        success: status.success(),
        exit_code: status.code(),
        stdout: Arc::from(stdout),
        stderr: Arc::from(stderr),
    })
}

#[cfg(target_os = "macos")]
fn resolve_macos_git_program(program: &std::ffi::OsStr) -> OsString {
    let fallback_directories = [
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ];
    resolve_macos_git_program_for_path(
        program,
        std::env::var_os("PATH").as_deref(),
        &fallback_directories,
    )
}

#[cfg(target_os = "macos")]
fn resolve_macos_git_program_for_path(
    program: &std::ffi::OsStr,
    path: Option<&std::ffi::OsStr>,
    fallback_directories: &[PathBuf],
) -> OsString {
    if program != std::ffi::OsStr::new("git") {
        return program.to_os_string();
    }

    let mut preferred_directories = Vec::new();
    let mut system_directories = Vec::new();
    for directory in path.into_iter().flat_map(std::env::split_paths) {
        if !directory.is_absolute() {
            continue;
        }
        if is_macos_system_search_directory(&directory) {
            system_directories.push(directory);
        } else {
            preferred_directories.push(directory);
        }
    }

    for directory in preferred_directories
        .into_iter()
        .chain(fallback_directories.iter().cloned())
        .chain(system_directories)
    {
        let candidate = directory.join("git");
        if is_executable_file(&candidate) {
            return candidate.into_os_string();
        }
    }

    program.to_os_string()
}

#[cfg(target_os = "macos")]
fn is_macos_system_search_directory(path: &Path) -> bool {
    path == Path::new("/usr/bin")
        || path == Path::new("/bin")
        || path == Path::new("/usr/sbin")
        || path == Path::new("/sbin")
}

#[cfg(target_os = "macos")]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Piped execution path (default): stdout/stderr are piped and drained by
// reader threads, the main thread waits event-driven (Windows
// WaitForMultipleObjects on the child + an overflow event; a dedicated Unix
// wait thread reports child exit through a channel), and the process tree is
// terminated before the readers are joined so grandchildren inheriting the
// pipes cannot keep the readers waiting for EOF.
// ---------------------------------------------------------------------------

struct CollectorState {
    data: Vec<u8>,
    overflow: bool,
    read_error: Option<io::Error>,
}

#[cfg(unix)]
enum ChildWaitEvent {
    Exited(std::process::ExitStatus),
    Overflow(&'static str),
    WaitError(io::Error),
}

#[cfg(windows)]
struct WindowsEventHandle(WindowsJobHandle);

#[cfg(windows)]
impl Drop for WindowsEventHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
#[derive(Clone)]
struct WindowsOverflowSignal {
    event: WindowsJobHandle,
    stream: Arc<Mutex<Option<&'static str>>>,
}

// The event handle is only passed to SetEvent, which is safe to call from any
// thread while the owning PipedCommand keeps the handle open.
#[cfg(windows)]
unsafe impl Send for WindowsOverflowSignal {}
#[cfg(windows)]
unsafe impl Sync for WindowsOverflowSignal {}

#[cfg(windows)]
impl WindowsOverflowSignal {
    fn signal(&self, name: &'static str) {
        {
            let mut stream = lock_unpoison(&self.stream);
            if stream.is_none() {
                *stream = Some(name);
            }
        }
        unsafe {
            let _ = SetEvent(self.event);
        }
    }
}

struct PipedCommand {
    _stdin_spool: Option<OutputSpool>,
    child: Option<Child>,
    process_tree: ProcessTreeGuard,
    stdout_collector: Arc<Mutex<CollectorState>>,
    stderr_collector: Arc<Mutex<CollectorState>>,
    readers: Vec<thread::JoinHandle<()>>,
    #[cfg(windows)]
    overflow_event: WindowsEventHandle,
    #[cfg(windows)]
    overflow_stream: Arc<Mutex<Option<&'static str>>>,
    #[cfg(unix)]
    event_sender: mpsc::Sender<ChildWaitEvent>,
    #[cfg(unix)]
    wait_receiver: Option<mpsc::Receiver<ChildWaitEvent>>,
}

fn execute_process_piped(
    spec: GitCommandSpec,
    token: &CancellationToken,
) -> Result<GitCommandOutput, GitRuntimeError> {
    if token.is_cancelled() {
        return Err(GitRuntimeError::cancelled());
    }
    let mut command = spawn_piped_command(&spec)?;
    let (status, termination_reason) = wait_piped(&mut command, &spec, token);
    finish_piped_command(&mut command, status, termination_reason, &spec)
}

#[cfg(windows)]
fn create_overflow_event() -> Result<WindowsEventHandle, GitRuntimeError> {
    let event = unsafe { CreateEventW(std::ptr::null_mut(), 0, 0, std::ptr::null()) };
    if event.is_null() {
        Err(GitRuntimeError::io(
            "create Git output overflow event",
            io::Error::last_os_error(),
        ))
    } else {
        Ok(WindowsEventHandle(event))
    }
}

fn spawn_piped_command(spec: &GitCommandSpec) -> Result<PipedCommand, GitRuntimeError> {
    #[cfg(windows)]
    let overflow_event = create_overflow_event()?;

    let mut command = build_git_command(spec);
    let stdin_spool = prepare_git_stdin(&mut command, spec)?;
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            GitRuntimeError::unavailable(error)
        } else {
            GitRuntimeError::io("start Git command", error)
        }
    })?;
    #[cfg(unix)]
    let process_tree = ProcessTreeGuard::attach(&child);
    #[cfg(windows)]
    let process_tree = match ProcessTreeGuard::attach(&child) {
        Ok(process_tree) => process_tree,
        Err(error) => {
            let reap_detail = reap_failed_windows_spawn(&mut child);
            return Err(GitRuntimeError::cleanup(format!(
                "Unable to assign or resume Git in a Windows Job Object. {error} {reap_detail}"
            )));
        }
    };

    let stdout_pipe = child.stdout.take().expect("Git stdout must be piped");
    let stderr_pipe = child.stderr.take().expect("Git stderr must be piped");
    let stdout_collector = Arc::new(Mutex::new(CollectorState {
        data: Vec::new(),
        overflow: false,
        read_error: None,
    }));
    let stderr_collector = Arc::new(Mutex::new(CollectorState {
        data: Vec::new(),
        overflow: false,
        read_error: None,
    }));

    #[cfg(unix)]
    let (event_sender, wait_receiver) = {
        let (sender, receiver) = mpsc::channel::<ChildWaitEvent>();
        (sender, Some(receiver))
    };
    let mut readers = Vec::with_capacity(2);
    #[cfg(unix)]
    readers.push(spawn_reader(
        stdout_pipe,
        "stdout",
        spec.stdout_limit,
        Arc::clone(&stdout_collector),
        event_sender.clone(),
    ));
    #[cfg(unix)]
    readers.push(spawn_reader(
        stderr_pipe,
        "stderr",
        spec.stderr_limit,
        Arc::clone(&stderr_collector),
        event_sender.clone(),
    ));
    #[cfg(windows)]
    let overflow_stream = Arc::new(Mutex::new(None));
    #[cfg(windows)]
    {
        let signal = WindowsOverflowSignal {
            event: overflow_event.0,
            stream: Arc::clone(&overflow_stream),
        };
        readers.push(spawn_reader(
            stdout_pipe,
            "stdout",
            spec.stdout_limit,
            Arc::clone(&stdout_collector),
            signal.clone(),
        ));
        readers.push(spawn_reader(
            stderr_pipe,
            "stderr",
            spec.stderr_limit,
            Arc::clone(&stderr_collector),
            signal,
        ));
    }

    Ok(PipedCommand {
        _stdin_spool: stdin_spool,
        child: Some(child),
        process_tree,
        stdout_collector,
        stderr_collector,
        readers,
        #[cfg(windows)]
        overflow_event,
        #[cfg(windows)]
        overflow_stream,
        #[cfg(unix)]
        event_sender,
        #[cfg(unix)]
        wait_receiver,
    })
}

#[cfg(unix)]
fn spawn_reader(
    pipe: impl Read + Send + 'static,
    name: &'static str,
    limit: usize,
    state: Arc<Mutex<CollectorState>>,
    events: mpsc::Sender<ChildWaitEvent>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        run_reader(pipe, name, limit, &state, |stream| {
            let _ = events.send(ChildWaitEvent::Overflow(stream));
        });
    })
}

#[cfg(windows)]
fn spawn_reader(
    pipe: impl Read + Send + 'static,
    name: &'static str,
    limit: usize,
    state: Arc<Mutex<CollectorState>>,
    signal: WindowsOverflowSignal,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        run_reader(pipe, name, limit, &state, |stream| signal.signal(stream));
    })
}

fn run_reader(
    mut pipe: impl Read,
    name: &'static str,
    limit: usize,
    state: &Mutex<CollectorState>,
    signal_overflow: impl Fn(&'static str),
) {
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        match pipe.read(&mut buffer) {
            Ok(0) => break,
            Ok(size) => {
                let mut collected = lock_unpoison(state);
                if collected.overflow {
                    // Keep draining so the child never blocks on a full pipe
                    // while the main thread terminates the process tree.
                    continue;
                }
                if collected.data.len().saturating_add(size) > limit {
                    collected.overflow = true;
                    drop(collected);
                    signal_overflow(name);
                } else {
                    collected.data.extend_from_slice(&buffer[..size]);
                }
            }
            Err(error) => {
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                lock_unpoison(state).read_error = Some(error);
                break;
            }
        }
    }
}

fn piped_output_limit(name: &'static str, spec: &GitCommandSpec) -> usize {
    if name == "stdout" {
        spec.stdout_limit
    } else {
        spec.stderr_limit
    }
}

fn wait_slice(spec: &GitCommandSpec) -> Duration {
    spec.poll_interval
        .max(PROCESS_POLL_INTERVAL)
        .min(Duration::from_millis(100))
}

#[cfg(unix)]
fn wait_piped(
    command: &mut PipedCommand,
    spec: &GitCommandSpec,
    token: &CancellationToken,
) -> (
    Result<std::process::ExitStatus, GitRuntimeError>,
    Option<GitRuntimeError>,
) {
    let receiver = command
        .wait_receiver
        .take()
        .expect("piped wait receiver must exist");
    let mut wait_child = command.child.take().expect("piped child must exist");
    let wait_events = command.event_sender.clone();
    thread::spawn(move || {
        let event = match wait_child.wait() {
            Ok(status) => ChildWaitEvent::Exited(status),
            Err(error) => ChildWaitEvent::WaitError(error),
        };
        let _ = wait_events.send(event);
    });

    let slice = wait_slice(spec);
    let started = Instant::now();
    let mut termination_reason = None;
    let status = loop {
        if token.is_cancelled() {
            termination_reason = Some(GitRuntimeError::cancelled());
            terminate_process_tree_guard_only(&command.process_tree);
            break await_piped_child(&receiver, &command.process_tree);
        }
        let Some(remaining) = spec.timeout.checked_sub(started.elapsed()) else {
            termination_reason = Some(GitRuntimeError::timed_out(spec.timeout));
            terminate_process_tree_guard_only(&command.process_tree);
            break await_piped_child(&receiver, &command.process_tree);
        };
        if remaining.is_zero() {
            termination_reason = Some(GitRuntimeError::timed_out(spec.timeout));
            terminate_process_tree_guard_only(&command.process_tree);
            break await_piped_child(&receiver, &command.process_tree);
        }
        let wait_for = remaining.min(slice).max(Duration::from_millis(1));
        match receiver.recv_timeout(wait_for) {
            Ok(ChildWaitEvent::Exited(status)) => break Ok(status),
            Ok(ChildWaitEvent::Overflow(name)) => {
                termination_reason = Some(GitRuntimeError::output_limit(
                    name,
                    piped_output_limit(name, spec),
                ));
                terminate_process_tree_guard_only(&command.process_tree);
                break await_piped_child(&receiver, &command.process_tree);
            }
            Ok(ChildWaitEvent::WaitError(error)) => {
                termination_reason = Some(GitRuntimeError::io("monitor Git command", error));
                terminate_process_tree_guard_only(&command.process_tree);
                break await_piped_child(&receiver, &command.process_tree);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                termination_reason = Some(GitRuntimeError::cleanup(
                    "Git process wait channel closed unexpectedly.",
                ));
                terminate_process_tree_guard_only(&command.process_tree);
                break Err(GitRuntimeError::cleanup(
                    "Unable to monitor Git command. The process wait channel closed.",
                ));
            }
        }
    };
    (status, termination_reason)
}

#[cfg(unix)]
fn await_piped_child(
    receiver: &mpsc::Receiver<ChildWaitEvent>,
    process_tree: &ProcessTreeGuard,
) -> Result<std::process::ExitStatus, GitRuntimeError> {
    let deadline = process_tree.cleanup_deadline();
    loop {
        let remaining = deadline
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(1));
        match receiver.recv_timeout(remaining) {
            Ok(ChildWaitEvent::Exited(status)) => return Ok(status),
            Ok(_) => continue,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                terminate_process_tree_guard_only(process_tree);
                let force_deadline = Instant::now() + PROCESS_FORCE_REAP_GRACE;
                loop {
                    match receiver.recv_timeout(PROCESS_POLL_INTERVAL.max(Duration::from_millis(1)))
                    {
                        Ok(ChildWaitEvent::Exited(status)) => return Ok(status),
                        Ok(_) => continue,
                        Err(_) if Instant::now() < force_deadline => continue,
                        Err(_) => {
                            return Err(GitRuntimeError::cleanup(
                                "Git process did not terminate before the cleanup deadline.",
                            ));
                        }
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(GitRuntimeError::cleanup(
                    "Unable to reap Git process after forced termination. The process wait channel closed.",
                ));
            }
        }
    }
}

#[cfg(windows)]
fn wait_piped(
    command: &mut PipedCommand,
    spec: &GitCommandSpec,
    token: &CancellationToken,
) -> (
    Result<std::process::ExitStatus, GitRuntimeError>,
    Option<GitRuntimeError>,
) {
    let child = command.child.as_mut().expect("piped child must exist");
    let slice = wait_slice(spec);
    let started = Instant::now();
    let mut termination_reason = None;
    let status = loop {
        if token.is_cancelled() {
            termination_reason = Some(GitRuntimeError::cancelled());
            terminate_process_tree(child, &command.process_tree);
            break wait_for_terminated_child(child, &command.process_tree);
        }
        let remaining = spec.timeout.checked_sub(started.elapsed());
        let Some(remaining) = remaining.filter(|value| !value.is_zero()) else {
            termination_reason = Some(GitRuntimeError::timed_out(spec.timeout));
            terminate_process_tree(child, &command.process_tree);
            break wait_for_terminated_child(child, &command.process_tree);
        };
        let wait_for = remaining.min(slice).max(Duration::from_millis(1));
        let handles = [
            child.as_raw_handle() as WindowsJobHandle,
            command.overflow_event.0,
        ];
        let result =
            unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, wait_for.as_millis() as u32) };
        match result {
            WAIT_OBJECT_0 => match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => continue,
                Err(error) => {
                    termination_reason = Some(GitRuntimeError::io("monitor Git command", error));
                    terminate_process_tree(child, &command.process_tree);
                    break wait_for_terminated_child(child, &command.process_tree);
                }
            },
            result if result == WAIT_OBJECT_0 + 1 => {
                let name = {
                    let mut stream = lock_unpoison(&command.overflow_stream);
                    stream.take().unwrap_or("stdout")
                };
                termination_reason = Some(GitRuntimeError::output_limit(
                    name,
                    piped_output_limit(name, spec),
                ));
                terminate_process_tree(child, &command.process_tree);
                break wait_for_terminated_child(child, &command.process_tree);
            }
            WAIT_TIMEOUT => continue,
            WAIT_FAILED => {
                termination_reason = Some(GitRuntimeError::io(
                    "monitor Git command",
                    io::Error::last_os_error(),
                ));
                terminate_process_tree(child, &command.process_tree);
                break wait_for_terminated_child(child, &command.process_tree);
            }
            unexpected => {
                termination_reason = Some(GitRuntimeError::internal(format!(
                    "Unexpected Git process wait result: {unexpected}."
                )));
                terminate_process_tree(child, &command.process_tree);
                break wait_for_terminated_child(child, &command.process_tree);
            }
        }
    };
    (status, termination_reason)
}

#[cfg(unix)]
fn terminate_process_tree_guard_only(process_tree: &ProcessTreeGuard) {
    process_tree.arm_cleanup();
    if let Err(tree_error) = process_tree.terminate_descendants() {
        process_tree.mark_cleanup_failed(tree_error);
    }
}

#[cfg(unix)]
fn terminate_tree_after_exit(command: &mut PipedCommand) {
    terminate_process_tree_guard_only(&command.process_tree);
    if let Err(error) = command
        .process_tree
        .wait_until_empty(command.process_tree.cleanup_deadline())
    {
        command.process_tree.mark_cleanup_failed(error);
    }
}

#[cfg(windows)]
fn terminate_tree_after_exit(command: &mut PipedCommand) {
    if let Some(child) = command.child.as_mut() {
        terminate_process_tree_after_exit(child, &command.process_tree);
    }
}

fn join_piped_readers(command: &mut PipedCommand) {
    let deadline = Instant::now() + PROCESS_TERMINATION_DEADLINE;
    for reader in command.readers.drain(..) {
        let remaining = deadline
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(1));
        let (done_sender, done_receiver) = mpsc::channel::<()>();
        thread::spawn(move || {
            let _ = reader.join();
            let _ = done_sender.send(());
        });
        if done_receiver.recv_timeout(remaining).is_err() {
            command.process_tree.mark_cleanup_failed(
                "Git output reader did not finish before the cleanup deadline.",
            );
        }
    }
}

fn collect_stream(
    state: &Mutex<CollectorState>,
    name: &'static str,
    limit: usize,
) -> Result<Vec<u8>, GitRuntimeError> {
    let mut collected = lock_unpoison(state);
    if let Some(error) = collected.read_error.take() {
        let operation = if name == "stdout" {
            "read Git stdout pipe"
        } else {
            "read Git stderr pipe"
        };
        return Err(GitRuntimeError::io(operation, error));
    }
    if collected.overflow {
        return Err(GitRuntimeError::output_limit(name, limit));
    }
    Ok(std::mem::take(&mut collected.data))
}

fn finish_piped_command(
    command: &mut PipedCommand,
    status: Result<std::process::ExitStatus, GitRuntimeError>,
    termination_reason: Option<GitRuntimeError>,
    spec: &GitCommandSpec,
) -> Result<GitCommandOutput, GitRuntimeError> {
    let status = status?;
    terminate_tree_after_exit(command);
    join_piped_readers(command);
    let stdout = collect_stream(&command.stdout_collector, "stdout", spec.stdout_limit);
    let stderr = collect_stream(&command.stderr_collector, "stderr", spec.stderr_limit);
    if let Some(reason) = termination_reason {
        let mut reason = reason;
        if let Some(error) = command.process_tree.cleanup_error() {
            reason = reason.with_detail(format!("Git process-tree cleanup failed: {error}"));
        }
        if let Err(error) = &stdout {
            reason = reason.with_detail(format!("Git stdout cleanup/read detail: {error}"));
        }
        if let Err(error) = &stderr {
            reason = reason.with_detail(format!("Git stderr cleanup/read detail: {error}"));
        }
        if stdout.is_ok() && stderr.is_ok() {
            command.process_tree.disarm_cleanup();
        }
        return Err(reason);
    }
    if let Some(cleanup_detail) = command.process_tree.cleanup_error() {
        let mut error = GitRuntimeError::cleanup(
            "Git command exited, but its child process tree did not finish cleanup successfully.",
        );
        error = error.with_detail(cleanup_detail);
        if let Err(detail) = &stdout {
            error = error.with_detail(format!("Git stdout cleanup/read detail: {detail}"));
        }
        if let Err(detail) = &stderr {
            error = error.with_detail(format!("Git stderr cleanup/read detail: {detail}"));
        }
        return Err(error);
    }
    let stdout = stdout?;
    let stderr = stderr?;
    command.process_tree.disarm_cleanup();
    Ok(GitCommandOutput {
        success: status.success(),
        exit_code: status.code(),
        stdout: Arc::from(stdout),
        stderr: Arc::from(stderr),
    })
}

fn spool_exceeds(path: &Path, limit: usize) -> io::Result<bool> {
    Ok(fs::metadata(path)?.len() > limit as u64)
}
fn read_spool(path: &Path, limit: usize, stream: &'static str) -> Result<Vec<u8>, GitRuntimeError> {
    let mut file =
        File::open(path).map_err(|error| GitRuntimeError::io("read Git output spool", error))?;
    let mut output = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let size = file
            .read(&mut buffer)
            .map_err(|error| GitRuntimeError::io("read Git output spool", error))?;
        if size == 0 {
            break;
        }
        if output.len().saturating_add(size) > limit {
            return Err(GitRuntimeError::output_limit(stream, limit));
        }
        output.extend_from_slice(&buffer[..size]);
    }
    Ok(output)
}

fn wait_for_terminated_child(
    child: &mut Child,
    process_tree: &ProcessTreeGuard,
) -> Result<std::process::ExitStatus, GitRuntimeError> {
    let deadline = process_tree.cleanup_deadline();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(PROCESS_POLL_INTERVAL);
            }
            Ok(None) => {
                terminate_process_tree(child, process_tree);
                let force_deadline = Instant::now() + PROCESS_FORCE_REAP_GRACE;
                loop {
                    match child.try_wait() {
                        Ok(Some(status)) => return Ok(status),
                        Ok(None) if Instant::now() < force_deadline => {
                            thread::sleep(PROCESS_POLL_INTERVAL);
                        }
                        Ok(None) => {
                            return Err(GitRuntimeError::cleanup(
                                "Git process did not terminate before the cleanup deadline.",
                            ));
                        }
                        Err(error) => {
                            return Err(GitRuntimeError::cleanup(format!(
                                "Unable to reap Git process after forced termination. {error}"
                            )));
                        }
                    }
                }
            }
            Err(error) => {
                // try_wait can fail when the process handle is already in an
                // unusual state. Force the whole tree once more before
                // reporting a structured cleanup failure so this path cannot
                // leave a detached process behind.
                terminate_process_tree(child, process_tree);
                return Err(GitRuntimeError::cleanup(format!(
                    "Unable to monitor and reap Git process. {error}"
                )));
            }
        }
    }
}

fn terminate_process_tree(child: &mut Child, process_tree: &ProcessTreeGuard) {
    terminate_process_tree_inner(child, process_tree);
}

fn terminate_process_tree_after_exit(child: &mut Child, process_tree: &ProcessTreeGuard) {
    terminate_process_tree_inner(child, process_tree);
    if let Err(error) = process_tree.wait_until_empty(process_tree.cleanup_deadline()) {
        process_tree.mark_cleanup_failed(error);
    }
}

fn terminate_process_tree_inner(child: &mut Child, process_tree: &ProcessTreeGuard) {
    process_tree.arm_cleanup();
    if let Err(tree_error) = process_tree.terminate_descendants() {
        if child.kill().is_err() && matches!(child.try_wait(), Ok(None)) {
            process_tree.mark_cleanup_failed(format!(
                "{tree_error} Direct termination of the Git process also failed."
            ));
        } else {
            process_tree.mark_cleanup_failed(tree_error);
        }
    }
}

#[cfg(windows)]
fn terminate_windows_process_tree(process_id: u32) -> bool {
    let process_id = process_id.to_string();
    let Ok(mut taskkill) = Command::new("taskkill")
        .args(["/PID", &process_id, "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };

    let deadline = Instant::now() + PROCESS_FORCE_REAP_GRACE;
    loop {
        match taskkill.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(PROCESS_POLL_INTERVAL);
            }
            Ok(None) => {
                let _ = taskkill.kill();
                return false;
            }
            Err(_) => {
                let _ = taskkill.kill();
                return false;
            }
        }
    }
}

#[cfg(windows)]
fn reap_failed_windows_spawn(child: &mut Child) -> String {
    let kill_error = child.kill().err();
    let deadline = Instant::now() + PROCESS_TERMINATION_DEADLINE;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return "The suspended Git process was reaped.".to_string(),
            Ok(None) if Instant::now() < deadline => thread::sleep(PROCESS_POLL_INTERVAL),
            Ok(None) => {
                return format!(
                    "The suspended Git process did not exit before the cleanup deadline. {}",
                    kill_error
                        .map(|error| format!("TerminateProcess failed: {error}."))
                        .unwrap_or_default()
                );
            }
            Err(error) => {
                return format!("Unable to reap the suspended Git process. {error}");
            }
        }
    }
}

fn canonical_key(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn lock_unpoison<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{mpsc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(1);
    static FIXTURE_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    #[ignore]
    fn fixture_process() {
        let Ok(mode) = env::var("PUDE_GIT_RUNTIME_FIXTURE") else {
            return;
        };
        if let Ok(counter_path) = env::var("PUDE_GIT_RUNTIME_COUNTER") {
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(counter_path)
                .expect("fixture counter");
            writeln!(file, "run").expect("fixture counter write");
        }
        match mode.as_str() {
            "sleep" => thread::sleep(Duration::from_millis(180)),
            "long-sleep" => thread::sleep(Duration::from_millis(1500)),
            "timeout" => loop {
                thread::sleep(Duration::from_millis(20));
            },
            "tree" | "tree-exit" => {
                let child = Command::new(env::current_exe().expect("fixture executable"))
                    .args(["fixture_process", "--ignored", "--nocapture"])
                    .env("PUDE_GIT_RUNTIME_FIXTURE", "tree-child")
                    .spawn()
                    .expect("fixture child");
                if let Ok(path) = env::var("PUDE_GIT_RUNTIME_CHILD_PID") {
                    fs::write(path, child.id().to_string()).expect("fixture child pid");
                }
                #[cfg(unix)]
                record_fixture_process_group(
                    "PUDE_GIT_RUNTIME_ROOT_PID",
                    "PUDE_GIT_RUNTIME_ROOT_PGID",
                );
                if mode == "tree" {
                    loop {
                        thread::sleep(Duration::from_millis(20));
                    }
                }
            }
            "tree-child" => {
                #[cfg(unix)]
                record_fixture_process_group(
                    "PUDE_GIT_RUNTIME_CHILD_PID",
                    "PUDE_GIT_RUNTIME_CHILD_PGID",
                );
                loop {
                    thread::sleep(Duration::from_millis(20));
                }
            }
            "overflow" => {
                let mut output = io::stdout();
                for _ in 0..256 {
                    output
                        .write_all(b"overflow-output")
                        .expect("fixture output");
                }
                output.flush().expect("fixture flush");
                loop {
                    thread::sleep(Duration::from_millis(20));
                }
            }
            "flood" => {
                let mut stdout = io::stdout();
                for line in 1..=100_000u32 {
                    writeln!(stdout, "{line}").expect("fixture flood output");
                }
                stdout.flush().expect("fixture flood flush");
                let mut stderr = io::stderr();
                writeln!(stderr, "flood-stderr-marker").expect("fixture flood stderr");
                stderr.flush().expect("fixture flood stderr flush");
            }
            "cache-payload" => {
                let size = env::var("PUDE_GIT_RUNTIME_PAYLOAD_BYTES")
                    .ok()
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0);
                let chunk = [b'x'; 16 * 1024];
                let mut stdout = io::stdout();
                let mut remaining = size;
                while remaining > 0 {
                    let take = remaining.min(chunk.len());
                    stdout
                        .write_all(&chunk[..take])
                        .expect("cache payload output");
                    remaining -= take;
                }
                stdout.flush().expect("cache payload flush");
            }
            "pipe-holder" => {
                // Spawn a grandchild that inherits the piped stdout/stderr and
                // keeps them open without writing, then exit successfully.
                let child = Command::new(env::current_exe().expect("fixture executable"))
                    .args(["fixture_process", "--ignored", "--nocapture"])
                    .env("PUDE_GIT_RUNTIME_FIXTURE", "pipe-holder-child")
                    .spawn()
                    .expect("fixture pipe holder child");
                if let Ok(path) = env::var("PUDE_GIT_RUNTIME_CHILD_PID") {
                    fs::write(path, child.id().to_string()).expect("fixture pipe holder pid");
                }
            }
            "pipe-holder-child" => loop {
                thread::sleep(Duration::from_millis(20));
            },
            "env" => {
                let value = env::var("GIT_TERMINAL_PROMPT").unwrap_or_else(|_| "<unset>".into());
                let locale = env::var("LC_ALL").unwrap_or_else(|_| "<unset>".into());
                let mut output = io::stdout();
                writeln!(output, "GIT_TERMINAL_PROMPT={value}").expect("fixture env output");
                writeln!(output, "LC_ALL={locale}").expect("fixture env output");
                output.flush().expect("fixture flush");
            }
            _ => {}
        }
    }

    fn test_root() -> PathBuf {
        let root = env::temp_dir().join(format!(
            "pude-git-runtime-test-{}-{}",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).expect("test root");
        root
    }

    fn fixture_spec(root: &Path, mode: &str) -> GitCommandSpec {
        let mut spec = GitCommandSpec::new(
            root,
            vec![
                OsString::from("fixture_process"),
                OsString::from("--ignored"),
                OsString::from("--nocapture"),
            ],
        )
        .with_program(env::current_exe().expect("test executable"))
        .with_timeout(Duration::from_secs(3))
        .with_poll_interval(Duration::from_millis(5));
        spec.no_optional_locks = false;
        spec.program = env::current_exe().expect("test executable").into();
        spec.args.shrink_to_fit();
        env::set_var("PUDE_GIT_RUNTIME_FIXTURE", mode);
        spec
    }

    #[test]
    fn bounded_stdin_works_with_both_process_transports() {
        let root = std::env::temp_dir().join(format!("pude-stdin-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let spec = GitCommandSpec::read(&root, vec!["hash-object".into(), "--stdin".into()]);
        let mut first = spec.clone();
        first.stdin = Some(Arc::from(&b"first input\n"[..]));
        let mut second = spec.clone();
        second.stdin = Some(Arc::from(&b"second input\n"[..]));
        let token = CancellationToken::new();
        let piped = execute_process_piped(first.clone(), &token).unwrap();
        let spooled = execute_process_spooled(first.clone(), &token).unwrap();
        assert!(piped.success && spooled.success);
        assert_eq!(piped.stdout, spooled.stdout);
        assert_ne!(
            piped.stdout,
            execute_process_piped(second.clone(), &token)
                .unwrap()
                .stdout
        );
        let first_key = QueryKey::from_request(
            &root,
            &GitReadRequest::new(&root, GitReadKind::Status, first),
        );
        let second_key = QueryKey::from_request(
            &root,
            &GitReadRequest::new(&root, GitReadKind::Status, second),
        );
        assert_ne!(first_key, second_key);
        let mut oversized = spec;
        oversized.stdin = Some(vec![0; MAX_STDIN_BYTES + 1].into());
        for run in [execute_process_piped, execute_process_spooled] {
            assert_eq!(
                run(oversized.clone(), &token).unwrap_err().kind(),
                GitErrorKind::OutputLimit
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    fn fixture_spec_with_counter(root: &Path, mode: &str, counter: &Path) -> GitCommandSpec {
        env::set_var("PUDE_GIT_RUNTIME_COUNTER", counter);
        fixture_spec(root, mode)
    }

    fn clear_fixture_env() {
        env::remove_var("PUDE_GIT_RUNTIME_FIXTURE");
        env::remove_var("PUDE_GIT_RUNTIME_COUNTER");
        env::remove_var("PUDE_GIT_RUNTIME_CHILD_PID");
        env::remove_var("PUDE_GIT_RUNTIME_PAYLOAD_BYTES");
    }

    #[cfg(unix)]
    struct TestEnvironment(Vec<(OsString, Option<OsString>)>);

    #[cfg(unix)]
    impl TestEnvironment {
        fn new() -> Self {
            Self(Vec::new())
        }

        fn set(&mut self, name: &str, value: impl AsRef<std::ffi::OsStr>) {
            let name = OsString::from(name);
            if !self.0.iter().any(|(saved_name, _)| saved_name == &name) {
                self.0.push((name.clone(), env::var_os(&name)));
            }
            env::set_var(name, value);
        }
    }

    #[cfg(unix)]
    impl Drop for TestEnvironment {
        fn drop(&mut self) {
            for (name, previous) in self.0.drain(..) {
                if let Some(value) = previous {
                    env::set_var(name, value);
                } else {
                    env::remove_var(name);
                }
            }
        }
    }

    fn initialize_git_test_repository(path: &Path) -> bool {
        let Ok(version) = Command::new("git").arg("--version").output() else {
            eprintln!("Skipping Git child-process integration test: git is unavailable.");
            return false;
        };
        if !version.status.success() {
            eprintln!("Skipping Git child-process integration test: git is unavailable.");
            return false;
        }

        fs::create_dir(path).expect("Git integration repository");
        let initialized = Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(path)
            .status()
            .expect("git init should start");
        assert!(initialized.success(), "git init failed: {initialized}");
        for (key, value) in [
            ("user.name", "Pude Test"),
            ("user.email", "pude-test@example.invalid"),
        ] {
            let configured = Command::new("git")
                .args(["config", key, value])
                .current_dir(path)
                .status()
                .expect("git config should start");
            assert!(configured.success(), "git config {key} failed");
        }
        fs::write(path.join("tracked.txt"), b"test\n").expect("tracked test file");
        let added = Command::new("git")
            .args(["add", "tracked.txt"])
            .current_dir(path)
            .status()
            .expect("git add should start");
        assert!(added.success(), "git add failed: {added}");
        true
    }

    #[cfg(unix)]
    fn make_executable(path: &Path, contents: &str) {
        use std::os::unix::fs::PermissionsExt;

        fs::write(path, contents).expect("write executable test script");
        let mut permissions = fs::metadata(path)
            .expect("test script metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).expect("make test script executable");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn finder_like_path_finds_homebrew_git_before_system_git() {
        let root = test_root();
        let package_bin = root.join("homebrew/bin");
        let user_bin = root.join("user/bin");
        fs::create_dir_all(&package_bin).expect("package bin directory");
        fs::create_dir_all(&user_bin).expect("user bin directory");
        let package_git = package_bin.join("git");
        let user_git = user_bin.join("git");
        make_executable(&package_git, "#!/bin/sh\nexit 0\n");
        make_executable(&user_git, "#!/bin/sh\nexit 0\n");

        let finder_path =
            env::join_paths([Path::new("/usr/bin"), Path::new("/bin")]).expect("Finder-like PATH");
        assert_eq!(
            PathBuf::from(resolve_macos_git_program_for_path(
                std::ffi::OsStr::new("git"),
                Some(&finder_path),
                std::slice::from_ref(&package_bin),
            )),
            package_git,
            "a sparse GUI PATH should find an installed package-manager Git before Apple Git",
        );

        let configured_path =
            env::join_paths([user_bin.as_path(), Path::new("/usr/bin")]).expect("configured PATH");
        assert_eq!(
            PathBuf::from(resolve_macos_git_program_for_path(
                std::ffi::OsStr::new("git"),
                Some(&configured_path),
                std::slice::from_ref(&package_bin),
            )),
            user_git,
            "an explicit user PATH entry should keep precedence over fallback locations",
        );
        assert_eq!(
            resolve_macos_git_program_for_path(
                std::ffi::OsStr::new("custom-git"),
                Some(&finder_path),
                std::slice::from_ref(&package_bin),
            ),
            OsString::from("custom-git"),
            "custom program names should not be rewritten",
        );

        fs::remove_dir_all(root).expect("remove path resolver fixture");
    }

    #[test]
    fn cancel_window_and_wait_cancels_all_matching_requests_and_preserves_other_windows() {
        let root = test_root();
        let coordinator = GitCoordinator::new();
        let first = coordinator.begin_request(&root, Some("window-a"));
        let second = coordinator.begin_request(&root, Some("window-a"));
        let other = coordinator.begin_request(&root, Some("window-b"));
        let first_token = first.token();
        let second_token = second.token();
        let other_token = other.token();
        let dropper = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(1);
            while !(first_token.is_cancelled() && second_token.is_cancelled()) {
                assert!(
                    Instant::now() < deadline,
                    "all matching requests should be cancelled"
                );
                thread::sleep(PROCESS_POLL_INTERVAL);
            }
            drop(first);
            drop(second);
        });

        let result = coordinator.cancel_window_and_wait("window-a", Duration::from_secs(1));
        dropper.join().expect("matching request dropper");
        result.expect("matching Git requests should drain");
        assert!(
            !other_token.is_cancelled(),
            "another window keeps its Git request"
        );
        drop(other);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cancel_window_and_wait_reports_a_bounded_timeout_instead_of_cancellation_alone() {
        let root = test_root();
        let coordinator = GitCoordinator::new();
        let first = coordinator.begin_request(&root, Some("window-a"));
        let second = coordinator.begin_request(&root, Some("window-a"));
        let first_token = first.token();
        let second_token = second.token();
        let started = Instant::now();

        let error = coordinator
            .cancel_window_and_wait("window-a", Duration::from_millis(30))
            .expect_err("active request scopes must not be treated as drained");

        assert!(first_token.is_cancelled() && second_token.is_cancelled());
        assert!(error.contains("2 request(s) remain active"), "{error}");
        assert!(started.elapsed() < Duration::from_millis(500));
        drop(first);
        drop(second);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cancel_window_and_wait_aggregates_cleanup_failures_after_all_requests_drain() {
        let root = test_root();
        let coordinator = GitCoordinator::new();
        let repository_state = coordinator
            .repository_state(&root)
            .expect("cleanup-error repository state");
        let first_read = GitReadRequest::new(
            &root,
            GitReadKind::Status,
            GitCommandSpec::read(&root, vec![OsString::from("status")]),
        );
        let second_read = GitReadRequest::new(
            &root,
            GitReadKind::History,
            GitCommandSpec::read(&root, vec![OsString::from("log")]),
        );
        for (request, message) in [
            (&first_read, "first Git tree cleanup failed"),
            (&second_read, "second Git tree cleanup failed"),
        ] {
            let key = QueryKey::from_request(&canonical_key(&root), request);
            let flight = Arc::new(QueryFlight::new(
                GitRevisions::default().for_kind(request.kind),
            ));
            flight.finish(Err(GitRuntimeError::cleanup(message)));
            lock_unpoison(&repository_state.state)
                .flights
                .insert(key, flight);
        }
        let first = coordinator.begin_request(&root, Some("window-a"));
        let second = coordinator.begin_request(&root, Some("window-a"));
        assert_eq!(
            coordinator
                .read_shared_for(first_read, &first)
                .expect_err("first cleanup failure")
                .kind(),
            GitErrorKind::CleanupFailed
        );
        assert_eq!(
            coordinator
                .read_shared_for(second_read, &second)
                .expect_err("second cleanup failure")
                .kind(),
            GitErrorKind::CleanupFailed
        );
        drop(first);
        drop(second);

        let error = coordinator
            .cancel_window_and_wait("window-a", Duration::ZERO)
            .expect_err("cleanup errors must block window destruction");

        assert!(error.contains("first Git tree cleanup failed"), "{error}");
        assert!(error.contains("second Git tree cleanup failed"), "{error}");
        let _ = fs::remove_dir_all(root);
    }

    fn process_is_alive(pid: u32) -> bool {
        #[cfg(windows)]
        {
            let pid = pid.to_string();
            return Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}")])
                .output()
                .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid))
                .unwrap_or(false);
        }
        #[cfg(unix)]
        {
            return probe_process(pid as i32).unwrap_or(true);
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = pid;
            false
        }
    }

    #[cfg(unix)]
    fn record_fixture_process_group(pid_variable: &str, group_variable: &str) {
        let process_id = std::process::id();
        let process_group = unsafe { libc::getpgrp() };
        if let Ok(path) = env::var(pid_variable) {
            fs::write(path, process_id.to_string()).expect("fixture process id");
        }
        if let Ok(path) = env::var(group_variable) {
            fs::write(path, process_group.to_string()).expect("fixture process group id");
        }
    }

    #[cfg(unix)]
    fn probe_process(pid: i32) -> io::Result<bool> {
        if unsafe { libc::kill(pid, 0) } == 0 {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(false)
        } else {
            Err(error)
        }
    }

    #[cfg(unix)]
    fn probe_process_group(process_group: i32) -> io::Result<bool> {
        if unsafe { libc::kill(-process_group, 0) } == 0 {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(false)
        } else {
            Err(error)
        }
    }

    #[cfg(unix)]
    struct TestProcessGroup(i32);

    #[cfg(unix)]
    impl Drop for TestProcessGroup {
        fn drop(&mut self) {
            unsafe {
                let _ = libc::kill(-self.0, libc::SIGKILL);
            }
            let deadline = Instant::now() + PROCESS_TERMINATION_DEADLINE;
            while Instant::now() < deadline {
                if matches!(probe_process_group(self.0), Ok(false)) {
                    break;
                }
                thread::sleep(PROCESS_POLL_INTERVAL);
            }
        }
    }

    #[test]
    fn cancellation_returns_with_no_reader_thread() {
        let _fixture_guard = FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = test_root();
        let coordinator = GitCoordinator::new();
        let request = coordinator.begin_request(&root, Some("window-a"));
        let token = request.token();
        let spec = fixture_spec(&root, "timeout").with_timeout(Duration::from_secs(10));
        let (sender, receiver) = mpsc::channel();
        let worker = thread::spawn(move || sender.send(coordinator.execute(spec, &token)).unwrap());
        thread::sleep(Duration::from_millis(60));
        request.cancel();
        let started = Instant::now();
        let result = receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("cancel result");
        worker.join().expect("worker join");
        assert_eq!(
            result.expect_err("cancelled command").kind(),
            GitErrorKind::Cancelled
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        clear_fixture_env();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn timeout_and_overflow_are_structured_and_bounded() {
        let _fixture_guard = FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = test_root();
        let coordinator = GitCoordinator::new();

        let timeout = fixture_spec(&root, "timeout").with_timeout(Duration::from_millis(80));
        let started = Instant::now();
        let timeout_result = coordinator.execute(timeout, &CancellationToken::new());
        assert_eq!(
            timeout_result.expect_err("timed out").kind(),
            GitErrorKind::TimedOut
        );
        assert!(started.elapsed() < Duration::from_secs(2));

        let overflow = fixture_spec(&root, "overflow").with_output_limits(32, 128);
        let overflow_result = coordinator.execute(overflow, &CancellationToken::new());
        let error = overflow_result.expect_err("overflow");
        assert_eq!(error.kind(), GitErrorKind::OutputLimit);
        assert_eq!(error.info().stream.as_deref(), Some("stdout"));
        clear_fixture_env();
        let _ = fs::remove_dir_all(root);
    }

    struct ForceSpoolGuard;

    impl ForceSpoolGuard {
        fn new() -> Self {
            FORCE_SPOOL_PATH.store(true, Ordering::SeqCst);
            Self
        }
    }

    impl Drop for ForceSpoolGuard {
        fn drop(&mut self) {
            FORCE_SPOOL_PATH.store(false, Ordering::SeqCst);
        }
    }

    #[test]
    fn piped_large_output_is_collected_from_both_streams() {
        let _fixture_guard = FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = test_root();
        let spec = fixture_spec(&root, "flood");
        let output = GitCoordinator::new()
            .execute(spec, &CancellationToken::new())
            .expect("flooded command");
        assert!(output.success);
        // The fixture test binary also prints harness lines ("running 1 test",
        // "test result: …"); only count the numeric flood lines it emits.
        let numbers: Vec<u32> = output
            .stdout_lossy()
            .lines()
            .filter_map(|line| line.parse::<u32>().ok())
            .collect();
        assert_eq!(numbers.len(), 100_000, "flood lines must all be collected");
        assert_eq!(numbers.first(), Some(&1));
        assert_eq!(numbers.last(), Some(&100_000));
        assert!(
            output.stderr_lossy().contains("flood-stderr-marker"),
            "stderr must be collected through the pipe, got: {}",
            output.stderr_lossy()
        );
        clear_fixture_env();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn piped_reader_does_not_wait_forever_for_a_grandchild_holding_the_pipe() {
        let _fixture_guard = FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = test_root();
        let child_pid_path = root.join("pipe-holder-child-pid");
        env::set_var("PUDE_GIT_RUNTIME_FIXTURE", "pipe-holder");
        env::set_var("PUDE_GIT_RUNTIME_CHILD_PID", &child_pid_path);
        let spec = fixture_spec(&root, "pipe-holder");
        let started = Instant::now();
        let output = GitCoordinator::new()
            .execute(spec, &CancellationToken::new())
            .expect("pipe holder command");
        assert!(output.success);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "grandchild holding the pipe must be reaped promptly, took {:?}",
            started.elapsed()
        );
        if let Ok(pid) = fs::read_to_string(&child_pid_path) {
            let pid = pid.trim().parse::<u32>().expect("pipe holder child pid");
            let reap_started = Instant::now();
            while process_is_alive(pid) && reap_started.elapsed() < Duration::from_secs(2) {
                thread::sleep(Duration::from_millis(20));
            }
            assert!(
                !process_is_alive(pid),
                "pipe holder grandchild still alive: {pid}"
            );
        }
        clear_fixture_env();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn piped_cancellation_and_timeout_remain_structured() {
        let _fixture_guard = FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = test_root();
        let coordinator = GitCoordinator::new();

        let timeout = fixture_spec(&root, "timeout").with_timeout(Duration::from_millis(80));
        let started = Instant::now();
        let timeout_result = coordinator.execute(timeout, &CancellationToken::new());
        assert_eq!(
            timeout_result.expect_err("timed out").kind(),
            GitErrorKind::TimedOut
        );
        assert!(started.elapsed() < Duration::from_secs(2));

        let request = coordinator.begin_request(&root, Some("window-a"));
        let token = request.token();
        let spec = fixture_spec(&root, "timeout").with_timeout(Duration::from_secs(10));
        let (sender, receiver) = mpsc::channel();
        let worker = thread::spawn(move || sender.send(coordinator.execute(spec, &token)).unwrap());
        thread::sleep(Duration::from_millis(60));
        request.cancel();
        let result = receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("piped cancel result");
        worker.join().expect("piped cancel worker");
        assert_eq!(
            result.expect_err("cancelled command").kind(),
            GitErrorKind::Cancelled
        );
        clear_fixture_env();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn spool_fallback_path_matches_piped_semantics_for_core_scenarios() {
        let _fixture_guard = FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _force_spool = ForceSpoolGuard::new();
        let root = test_root();

        let flood = fixture_spec(&root, "flood");
        let output = GitCoordinator::new()
            .execute(flood, &CancellationToken::new())
            .expect("spool flood command");
        assert!(output.success);
        let numbers: Vec<u32> = output
            .stdout_lossy()
            .lines()
            .filter_map(|line| line.parse::<u32>().ok())
            .collect();
        assert_eq!(numbers.len(), 100_000, "flood lines must all be collected");

        let timeout = fixture_spec(&root, "timeout").with_timeout(Duration::from_millis(80));
        let error = GitCoordinator::new()
            .execute(timeout, &CancellationToken::new())
            .expect_err("spool timeout");
        assert_eq!(error.kind(), GitErrorKind::TimedOut);

        let overflow = fixture_spec(&root, "overflow").with_output_limits(32, 128);
        let error = GitCoordinator::new()
            .execute(overflow, &CancellationToken::new())
            .expect_err("spool overflow");
        assert_eq!(error.kind(), GitErrorKind::OutputLimit);
        assert_eq!(error.info().stream.as_deref(), Some("stdout"));

        let child_pid_path = root.join("spool-pipe-holder-pid");
        env::set_var("PUDE_GIT_RUNTIME_CHILD_PID", &child_pid_path);
        let holder = fixture_spec(&root, "pipe-holder");
        let started = Instant::now();
        let output = GitCoordinator::new()
            .execute(holder, &CancellationToken::new())
            .expect("spool pipe holder command");
        assert!(output.success);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "spool path must also finish promptly with a pipe-holding grandchild"
        );
        if let Ok(pid) = fs::read_to_string(&child_pid_path) {
            let pid = pid.trim().parse::<u32>().expect("spool pipe holder pid");
            let reap_started = Instant::now();
            while process_is_alive(pid) && reap_started.elapsed() < Duration::from_secs(2) {
                thread::sleep(Duration::from_millis(20));
            }
            assert!(
                !process_is_alive(pid),
                "spool path left the pipe holder grandchild alive: {pid}"
            );
        }
        clear_fixture_env();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[ignore]
    fn bench_git_status_wall_time_pipe_vs_spool() {
        let root = test_root();
        let repository = root.join("repository");
        if !initialize_git_test_repository(&repository) {
            eprintln!("Skipping git status benchmark: git is unavailable.");
            let _ = fs::remove_dir_all(root);
            return;
        }
        let coordinator = GitCoordinator::new();
        let measure = |spool: bool| {
            FORCE_SPOOL_PATH.store(spool, Ordering::SeqCst);
            let mut samples = Vec::new();
            for _ in 0..30 {
                let spec = GitCommandSpec::read(
                    &repository,
                    vec![OsString::from("status"), OsString::from("--porcelain")],
                );
                let started = Instant::now();
                coordinator
                    .execute(spec, &CancellationToken::new())
                    .expect("git status must succeed");
                samples.push(started.elapsed());
            }
            FORCE_SPOOL_PATH.store(false, Ordering::SeqCst);
            samples.sort();
            samples[samples.len() / 2]
        };
        let pipe_median = measure(false);
        let spool_median = measure(true);
        eprintln!(
            "git status --porcelain median wall time over 30 runs: pipe={pipe_median:?} spool={spool_median:?}"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn timeout_reaps_the_same_git_process_group_within_the_cleanup_bound() {
        let _fixture_guard = FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = test_root();
        let child_pid_path = root.join("timeout-child-pid");
        let child_group_path = root.join("timeout-child-pgid");
        let root_pid_path = root.join("timeout-root-pid");
        let root_group_path = root.join("timeout-root-pgid");
        let mut environment = TestEnvironment::new();
        environment.set("PUDE_GIT_RUNTIME_FIXTURE", "tree");
        environment.set("PUDE_GIT_RUNTIME_CHILD_PID", &child_pid_path);
        environment.set("PUDE_GIT_RUNTIME_CHILD_PGID", &child_group_path);
        environment.set("PUDE_GIT_RUNTIME_ROOT_PID", &root_pid_path);
        environment.set("PUDE_GIT_RUNTIME_ROOT_PGID", &root_group_path);

        let timeout = Duration::from_millis(1_500);
        let spec = fixture_spec(&root, "tree").with_timeout(timeout);
        let (sender, receiver) = mpsc::channel();
        let worker = thread::spawn(move || {
            let started = Instant::now();
            let result = GitCoordinator::new().execute(spec, &CancellationToken::new());
            sender.send((result, started.elapsed())).unwrap();
        });

        let ready_deadline = Instant::now() + Duration::from_secs(3);
        while !(child_pid_path.exists()
            && child_group_path.exists()
            && root_pid_path.exists()
            && root_group_path.exists())
            && Instant::now() < ready_deadline
        {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            child_pid_path.exists(),
            "timed Git fixture child did not start"
        );
        assert!(
            child_group_path.exists(),
            "timed Git fixture did not record its process group"
        );
        assert!(
            root_pid_path.exists(),
            "timed Git fixture did not record its process ID"
        );
        assert!(
            root_group_path.exists(),
            "timed Git fixture did not record its process group"
        );

        let root_pid = fs::read_to_string(&root_pid_path)
            .expect("fixture root process ID")
            .trim()
            .parse::<i32>()
            .expect("fixture root process ID should be numeric");
        let root_group = fs::read_to_string(&root_group_path)
            .expect("fixture root process group")
            .trim()
            .parse::<i32>()
            .expect("fixture root process group should be numeric");
        let child_pid = fs::read_to_string(&child_pid_path)
            .expect("fixture child process ID")
            .trim()
            .parse::<i32>()
            .expect("fixture child process ID should be numeric");
        let child_group = fs::read_to_string(&child_group_path)
            .expect("fixture child process group")
            .trim()
            .parse::<i32>()
            .expect("fixture child process group should be numeric");
        assert_eq!(
            root_group, root_pid,
            "Git root should lead its process group"
        );
        assert_eq!(
            child_group, root_group,
            "Git child must inherit its parent's group"
        );
        let _process_group = TestProcessGroup(root_group);
        assert!(probe_process(child_pid).expect("child should be inspectable before timeout"));
        assert!(probe_process_group(root_group)
            .expect("process group should be inspectable before timeout"));

        let (result, elapsed) = receiver
            .recv_timeout(timeout + PROCESS_TERMINATION_DEADLINE + Duration::from_secs(2))
            .expect("timed Git process tree should be cleaned up within the bound");
        worker.join().expect("timeout worker");
        let error = result.expect_err("the fixture should time out");
        assert_eq!(error.kind(), GitErrorKind::TimedOut);
        assert!(
            elapsed >= timeout,
            "timeout returned before its deadline: {elapsed:?}"
        );
        assert!(
            elapsed < timeout + PROCESS_TERMINATION_DEADLINE + Duration::from_secs(1),
            "timeout cleanup exceeded its bound: {elapsed:?}"
        );
        assert_eq!(
            error.info().message,
            format!("Git command timed out after {timeout:?}."),
            "timeout should report the configured duration accurately"
        );

        let cleanup_deadline = Instant::now() + Duration::from_secs(1);
        while (probe_process(child_pid).expect("child should remain inspectable")
            || probe_process_group(root_group).expect("process group should remain inspectable"))
            && Instant::now() < cleanup_deadline
        {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(!probe_process(child_pid).expect("child should be inspectable after timeout"));
        assert!(!probe_process_group(root_group)
            .expect("process group should be inspectable after timeout"));

        drop(environment);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cancellation_reaps_fixture_process_tree() {
        let _fixture_guard = FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = test_root();
        let child_pid_path = root.join("child-pid");
        env::set_var("PUDE_GIT_RUNTIME_FIXTURE", "tree");
        env::set_var("PUDE_GIT_RUNTIME_CHILD_PID", &child_pid_path);
        let coordinator = GitCoordinator::new();
        let request = coordinator.begin_request(&root, Some("window-a"));
        let token = request.token();
        let spec = fixture_spec(&root, "tree").with_timeout(Duration::from_secs(10));
        let (sender, receiver) = mpsc::channel();
        let worker = thread::spawn(move || sender.send(coordinator.execute(spec, &token)).unwrap());
        let pid_started = Instant::now();
        while !child_pid_path.exists() && pid_started.elapsed() < Duration::from_secs(2) {
            thread::sleep(Duration::from_millis(10));
        }
        request.cancel();
        let result = receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("tree cancellation result");
        worker.join().expect("tree worker");
        assert_eq!(
            result.expect_err("tree cancellation").kind(),
            GitErrorKind::Cancelled
        );
        if let Ok(pid) = fs::read_to_string(&child_pid_path) {
            let pid = pid.trim().parse::<u32>().expect("child pid");
            let started = Instant::now();
            while process_is_alive(pid) && started.elapsed() < Duration::from_secs(2) {
                thread::sleep(Duration::from_millis(20));
            }
            assert!(
                !process_is_alive(pid),
                "fixture child process still alive: {pid}"
            );
        }
        clear_fixture_env();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn normal_exit_reaps_fixture_process_tree() {
        let _fixture_guard = FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = test_root();
        let child_pid_path = root.join("normal-child-pid");
        env::set_var("PUDE_GIT_RUNTIME_FIXTURE", "tree-exit");
        env::set_var("PUDE_GIT_RUNTIME_CHILD_PID", &child_pid_path);
        let coordinator = GitCoordinator::new();
        let spec = fixture_spec(&root, "tree-exit");
        let output = coordinator
            .execute(spec, &CancellationToken::new())
            .expect("normal tree command");
        assert!(output.success);
        let pid_started = Instant::now();
        while !child_pid_path.exists() && pid_started.elapsed() < Duration::from_secs(2) {
            thread::sleep(Duration::from_millis(10));
        }
        if let Ok(pid) = fs::read_to_string(&child_pid_path) {
            let pid = pid.trim().parse::<u32>().expect("normal child pid");
            assert!(
                !process_is_alive(pid),
                "normal child process still alive: {pid}"
            );
        }
        clear_fixture_env();
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_reaps_a_git_hook_child_process() {
        let _fixture_guard = FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = test_root();
        let repository = root.join("repository");
        if !initialize_git_test_repository(&repository) {
            let _ = fs::remove_dir_all(root);
            return;
        }
        let child_pid_path = root.join("git-hook-child-pid");
        let hook_path = repository.join(".git/hooks/pre-commit");
        make_executable(
            &hook_path,
            "#!/bin/sh\nsleep 30 &\necho $! > \"$PUDE_GIT_RUNTIME_HOOK_CHILD_PID\"\nwait\n",
        );
        let mut environment = TestEnvironment::new();
        environment.set("PUDE_GIT_RUNTIME_HOOK_CHILD_PID", &child_pid_path);

        let token = CancellationToken::new();
        let worker_token = token.clone();
        let spec = GitCommandSpec::new(
            &repository,
            vec![
                OsString::from("commit"),
                OsString::from("-m"),
                OsString::from("test"),
            ],
        )
        .with_timeout(Duration::from_secs(10));
        let worker = thread::spawn(move || GitCoordinator::new().execute(spec, &worker_token));
        let hook_started = Instant::now();
        while !child_pid_path.exists() && hook_started.elapsed() < Duration::from_secs(3) {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(child_pid_path.exists(), "Git hook did not start its child");
        let child_pid = fs::read_to_string(&child_pid_path)
            .expect("Git hook child PID")
            .trim()
            .parse::<u32>()
            .expect("Git hook child PID should be numeric");

        let cancellation_started = Instant::now();
        token.cancel();
        let result = worker
            .join()
            .expect("Git hook worker")
            .expect_err("Git hook should be cancelled");
        assert_eq!(result.kind(), GitErrorKind::Cancelled);
        assert!(cancellation_started.elapsed() < Duration::from_secs(3));
        let cleanup_deadline = Instant::now() + Duration::from_secs(2);
        while process_is_alive(child_pid) && Instant::now() < cleanup_deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            !process_is_alive(child_pid),
            "Git hook child process {child_pid} survived cancellation"
        );
        drop(environment);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_reaps_an_ssh_helper_child_process() {
        let _fixture_guard = FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = test_root();
        let repository = root.join("repository");
        if !initialize_git_test_repository(&repository) {
            let _ = fs::remove_dir_all(root);
            return;
        }
        let child_pid_path = root.join("ssh-helper-child-pid");
        let ssh_helper = root.join("ssh-helper");
        make_executable(
            &ssh_helper,
            "#!/bin/sh\nsleep 30 &\necho $! > \"$PUDE_GIT_RUNTIME_SSH_CHILD_PID\"\nwait\n",
        );
        let mut environment = TestEnvironment::new();
        environment.set("GIT_SSH", &ssh_helper);
        environment.set("GIT_SSH_VARIANT", "ssh");
        environment.set("GIT_TERMINAL_PROMPT", "0");
        environment.set("PUDE_GIT_RUNTIME_SSH_CHILD_PID", &child_pid_path);

        let token = CancellationToken::new();
        let worker_token = token.clone();
        let spec = GitCommandSpec::new(
            &repository,
            vec![
                OsString::from("ls-remote"),
                OsString::from("ssh://example.invalid/pude/test.git"),
            ],
        )
        .with_timeout(Duration::from_secs(10));
        let worker = thread::spawn(move || GitCoordinator::new().execute(spec, &worker_token));
        let helper_started = Instant::now();
        while !child_pid_path.exists() && helper_started.elapsed() < Duration::from_secs(3) {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            child_pid_path.exists(),
            "Git SSH helper did not start its child"
        );
        let child_pid = fs::read_to_string(&child_pid_path)
            .expect("SSH helper child PID")
            .trim()
            .parse::<u32>()
            .expect("SSH helper child PID should be numeric");

        let cancellation_started = Instant::now();
        token.cancel();
        let result = worker
            .join()
            .expect("SSH helper worker")
            .expect_err("SSH helper should be cancelled");
        assert_eq!(result.kind(), GitErrorKind::Cancelled);
        assert!(cancellation_started.elapsed() < Duration::from_secs(3));
        let cleanup_deadline = Instant::now() + Duration::from_secs(2);
        while process_is_alive(child_pid) && Instant::now() < cleanup_deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            !process_is_alive(child_pid),
            "Git SSH helper child process {child_pid} survived cancellation"
        );
        drop(environment);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn windows_job_is_assigned_before_git_fixture_resumes_and_child_tree_is_reaped() {
        let _fixture_guard = FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = test_root();
        let child_pid_path = root.join("suspended-child-pid");
        env::set_var("PUDE_GIT_RUNTIME_FIXTURE", "tree");
        env::set_var("PUDE_GIT_RUNTIME_CHILD_PID", &child_pid_path);
        let spec = fixture_spec(&root, "tree");
        #[cfg(target_os = "macos")]
        let program = resolve_macos_git_program(&spec.program);
        #[cfg(not(target_os = "macos"))]
        let program = spec.program.clone();
        let mut command = Command::new(&program);
        command
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_SUSPENDED);
        let mut child = command.spawn().expect("suspended fixture should start");

        let process_tree = ProcessTreeGuard::attach(&child)
            .expect("Job Object assignment should precede the first child instruction");
        let child_started = Instant::now();
        while !child_pid_path.exists() && child_started.elapsed() < Duration::from_secs(2) {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            child_pid_path.exists(),
            "resumed fixture should start its child"
        );

        terminate_process_tree(&mut child, &process_tree);
        wait_for_terminated_child(&mut child, &process_tree).expect("Git fixture should be reaped");
        process_tree
            .wait_until_empty(Instant::now() + PROCESS_TERMINATION_DEADLINE)
            .expect("Job Object should report that the entire process tree exited");
        process_tree.disarm_cleanup();

        let child_pid = fs::read_to_string(&child_pid_path)
            .expect("fixture child PID")
            .trim()
            .parse::<u32>()
            .expect("valid child PID");
        assert!(
            !process_is_alive(child_pid),
            "Job Object left child {child_pid} alive"
        );
        clear_fixture_env();
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn windows_job_assignment_failure_kills_the_still_suspended_git_process() {
        let _fixture_guard = FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = test_root();
        let child_pid_path = root.join("must-not-start-child-pid");
        env::set_var("PUDE_GIT_RUNTIME_FIXTURE", "tree");
        env::set_var("PUDE_GIT_RUNTIME_CHILD_PID", &child_pid_path);
        let spec = fixture_spec(&root, "tree");
        #[cfg(target_os = "macos")]
        let program = resolve_macos_git_program(&spec.program);
        #[cfg(not(target_os = "macos"))]
        let program = spec.program.clone();
        let mut command = Command::new(&program);
        command
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_SUSPENDED);
        let mut child = command.spawn().expect("suspended fixture should start");
        let failed_assignment = unsafe {
            AssignProcessToJobObject(
                std::ptr::null_mut(),
                child.as_raw_handle() as WindowsJobHandle,
            )
        };
        assert_eq!(
            failed_assignment, 0,
            "null Job Object handle must fail assignment"
        );

        let reap_started = Instant::now();
        let diagnostic = reap_failed_windows_spawn(&mut child);
        assert!(reap_started.elapsed() < PROCESS_TERMINATION_DEADLINE + PROCESS_POLL_INTERVAL);
        assert!(
            matches!(child.try_wait(), Ok(Some(_))),
            "failed setup process should be reaped: {diagnostic}"
        );
        assert!(
            !child_pid_path.exists(),
            "suspended process ran before assignment"
        );
        clear_fixture_env();
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn cancel_window_and_wait_keeps_other_shared_subscribers_and_drains_the_last_one() {
        let _fixture_guard = FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = test_root();
        let child_pid_path = root.join("shared-child-pid");
        let child_group_path = root.join("shared-child-pgid");
        let root_pid_path = root.join("shared-root-pid");
        let root_group_path = root.join("shared-root-pgid");
        let mut environment = TestEnvironment::new();
        environment.set("PUDE_GIT_RUNTIME_FIXTURE", "tree");
        environment.set("PUDE_GIT_RUNTIME_CHILD_PID", &child_pid_path);
        environment.set("PUDE_GIT_RUNTIME_CHILD_PGID", &child_group_path);
        environment.set("PUDE_GIT_RUNTIME_ROOT_PID", &root_pid_path);
        environment.set("PUDE_GIT_RUNTIME_ROOT_PGID", &root_group_path);

        let coordinator = GitCoordinator::new();
        let request_a = coordinator.begin_request(&root, Some("window-a"));
        let request_b = coordinator.begin_request(&root, Some("window-b"));
        let token_b = request_b.token();
        let spec = fixture_spec(&root, "tree").with_timeout(Duration::from_secs(10));
        let probe = GitReadRequest::new(&root, GitReadKind::Status, spec.clone());
        let key = QueryKey::from_request(&canonical_key(&root), &probe);
        let state = coordinator
            .repository_state(&root)
            .expect("shared query repository state");
        let first = GitReadRequest::new(&root, GitReadKind::Status, spec.clone());
        let first_coordinator = coordinator.clone();
        let first_worker =
            thread::spawn(move || first_coordinator.read_shared_for(first, &request_a));
        let second = GitReadRequest::new(&root, GitReadKind::Status, spec);
        let second_coordinator = coordinator.clone();
        let second_worker =
            thread::spawn(move || second_coordinator.read_shared_for(second, &request_b));

        let ready_deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let subscribers = lock_unpoison(&state.state)
                .flights
                .get(&key)
                .map(|flight| flight.subscribers.load(Ordering::Acquire))
                .unwrap_or_default();
            if subscribers == 2 && child_pid_path.exists() && child_group_path.exists() {
                break;
            }
            assert!(
                Instant::now() < ready_deadline,
                "both windows should share a live Git child"
            );
            thread::sleep(PROCESS_POLL_INTERVAL);
        }

        let started = Instant::now();
        coordinator
            .cancel_window_and_wait("window-a", Duration::from_secs(1))
            .expect("a non-final subscriber should drain without waiting for the other window");
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(
            !token_b.is_cancelled(),
            "the other window remains an active subscriber"
        );
        let child_pid = fs::read_to_string(&child_pid_path)
            .expect("shared child pid")
            .trim()
            .parse::<u32>()
            .expect("shared child PID parses");
        assert!(
            process_is_alive(child_pid),
            "the shared Git process should remain alive for the other window"
        );
        assert_eq!(
            first_worker
                .join()
                .expect("first shared subscriber")
                .expect_err("first window cancellation")
                .kind(),
            GitErrorKind::Cancelled
        );

        coordinator
            .cancel_window_and_wait("window-b", Duration::from_secs(5))
            .expect("the final subscriber should wait for process-tree cleanup");
        assert_eq!(
            second_worker
                .join()
                .expect("second shared subscriber")
                .expect_err("second window cancellation")
                .kind(),
            GitErrorKind::Cancelled
        );
        assert!(
            !process_is_alive(child_pid),
            "the final window must not drain before the Git process tree exits"
        );

        drop(environment);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn shared_last_cancel_waits_for_process_cleanup() {
        let _fixture_guard = FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = test_root();
        let child_pid_path = root.join("shared-child-pid");
        env::set_var("PUDE_GIT_RUNTIME_FIXTURE", "tree");
        env::set_var("PUDE_GIT_RUNTIME_CHILD_PID", &child_pid_path);
        let coordinator = GitCoordinator::new();
        let request = coordinator.begin_request(&root, Some("window-a"));
        let token = request.token();
        let spec = fixture_spec(&root, "tree").with_timeout(Duration::from_secs(10));
        let read_request = GitReadRequest::new(&root, GitReadKind::Status, spec);
        let worker_coordinator = coordinator.clone();
        let worker = thread::spawn(move || worker_coordinator.read_shared(read_request, &token));
        let pid_started = Instant::now();
        while !child_pid_path.exists() && pid_started.elapsed() < Duration::from_secs(2) {
            thread::sleep(Duration::from_millis(10));
        }
        request.cancel();
        let started = Instant::now();
        let result = worker
            .join()
            .expect("shared cancellation worker")
            .expect_err("shared cancellation");
        assert_eq!(result.kind(), GitErrorKind::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(2));
        if let Ok(pid) = fs::read_to_string(&child_pid_path) {
            let pid = pid.trim().parse::<u32>().expect("shared child pid");
            assert!(
                !process_is_alive(pid),
                "shared child process still alive: {pid}"
            );
        }
        clear_fixture_env();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn shared_flight_keeps_other_subscriber_alive_after_one_cancel() {
        let _fixture_guard = FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = test_root();
        let counter = root.join("counter");
        let coordinator = GitCoordinator::new();
        let request_a = coordinator.begin_request(&root, Some("window-a"));
        let request_b = coordinator.begin_request(&root, Some("window-b"));
        // The fixture outlasts the short waits below even when the host is slow.
        let spec = fixture_spec_with_counter(&root, "long-sleep", &counter);
        let first = GitReadRequest::new(&root, GitReadKind::Status, spec.clone());
        let second = GitReadRequest::new(&root, GitReadKind::Status, spec);
        let first_coordinator = coordinator.clone();
        let first_token = request_a.token();
        let first_worker =
            thread::spawn(move || first_coordinator.read_shared(first, &first_token));
        thread::sleep(Duration::from_millis(30));
        let second_coordinator = coordinator.clone();
        let second_token = request_b.token();
        let second_worker =
            thread::spawn(move || second_coordinator.read_shared(second, &second_token));
        thread::sleep(Duration::from_millis(30));
        request_a.cancel();
        let first_result = first_worker.join().expect("first worker");
        assert_eq!(
            first_result.expect_err("first cancellation").kind(),
            GitErrorKind::Cancelled
        );
        let second_result = second_worker.join().expect("second worker");
        assert!(second_result.expect("second subscriber").success);
        let runs = fs::read_to_string(&counter)
            .expect("counter")
            .lines()
            .count();
        assert_eq!(runs, 1);
        clear_fixture_env();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn formal_path_disables_git_terminal_prompt_for_every_command() {
        let _fixture_guard = FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = test_root();
        let spec = fixture_spec(&root, "env");
        let token = CancellationToken::new();
        let output = GitCoordinator::new()
            .execute(spec, &token)
            .expect("fixture env command");
        assert!(
            output.stdout_lossy().contains("GIT_TERMINAL_PROMPT=0"),
            "formal Git path must set GIT_TERMINAL_PROMPT=0, got: {}",
            output.stdout_lossy()
        );
        clear_fixture_env();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn formal_path_forces_english_git_messages_for_error_classification() {
        let _fixture_guard = FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = test_root();
        let output = GitCoordinator::new()
            .execute(fixture_spec(&root, "env"), &CancellationToken::new())
            .expect("fixture env command");
        assert!(
            output.stdout_lossy().contains("LC_ALL=C"),
            "got: {}",
            output.stdout_lossy()
        );
        clear_fixture_env();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn different_query_options_do_not_merge() {
        let _fixture_guard = FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = test_root();
        let counter = root.join("counter");
        let coordinator = GitCoordinator::new();
        let request_a = coordinator.begin_request(&root, Some("window-a"));
        let request_b = coordinator.begin_request(&root, Some("window-b"));
        let spec_a = fixture_spec_with_counter(&root, "sleep", &counter)
            .with_timeout(Duration::from_secs(3));
        let spec_b = fixture_spec(&root, "sleep").with_timeout(Duration::from_secs(4));
        let first = GitReadRequest::new(&root, GitReadKind::Status, spec_a);
        let second = GitReadRequest::new(&root, GitReadKind::Status, spec_b);
        let first_coordinator = coordinator.clone();
        let first_token = request_a.token();
        let first_worker =
            thread::spawn(move || first_coordinator.read_shared(first, &first_token));
        thread::sleep(Duration::from_millis(30));
        let second_coordinator = coordinator.clone();
        let second_token = request_b.token();
        let second_worker =
            thread::spawn(move || second_coordinator.read_shared(second, &second_token));
        assert!(first_worker.join().expect("first options worker").is_ok());
        assert!(second_worker.join().expect("second options worker").is_ok());
        let runs = fs::read_to_string(&counter)
            .expect("options counter")
            .lines()
            .count();
        assert_eq!(runs, 2);
        clear_fixture_env();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn invalidation_during_flight_prevents_stale_cache_reuse() {
        let _fixture_guard = FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = test_root();
        let counter = root.join("counter");
        let coordinator = GitCoordinator::new();
        let request = coordinator.begin_request(&root, Some("window-a"));
        let spec = fixture_spec_with_counter(&root, "sleep", &counter);
        let read_request = GitReadRequest::new(&root, GitReadKind::Status, spec.clone());
        let worker_coordinator = coordinator.clone();
        let token = request.token();
        let worker = thread::spawn(move || worker_coordinator.read_shared(read_request, &token));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !fs::read_to_string(&counter).is_ok_and(|contents| contents.lines().count() == 1) {
            assert!(Instant::now() < deadline, "first Git fixture did not start");
            thread::sleep(Duration::from_millis(5));
        }
        coordinator.invalidate(&root, GitDirtyScope::WORKTREE);
        let first_result = worker.join().expect("flight worker");
        if let Ok(output) = &first_result {
            assert!(output.success);
        } else {
            assert_eq!(
                first_result
                    .expect_err("only cancellation is accepted")
                    .info
                    .kind,
                GitErrorKind::Cancelled
            );
        }

        let second_request = coordinator.begin_request(&root, Some("window-a"));
        let second_read = GitReadRequest::new(&root, GitReadKind::Status, spec);
        let second = coordinator
            .read_shared_for(second_read, &second_request)
            .expect("second read");
        assert!(second.success);
        let runs = fs::read_to_string(&counter)
            .expect("counter")
            .lines()
            .count();
        assert_eq!(runs, 2);
        clear_fixture_env();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cache_hits_share_immutable_buffers_and_account_stdout_and_stderr() {
        let _fixture_guard = FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = test_root();
        let counter = root.join("counter");
        env::set_var("PUDE_GIT_RUNTIME_PAYLOAD_BYTES", "4096");
        let spec = fixture_spec_with_counter(&root, "cache-payload", &counter);
        let coordinator = GitCoordinator::new();
        let first_request = coordinator.begin_request(&root, Some("window-a"));
        let first = coordinator
            .read_shared_for(
                GitReadRequest::new(&root, GitReadKind::Status, spec.clone()),
                &first_request,
            )
            .expect("first cacheable query");
        let second_request = coordinator.begin_request(&root, Some("window-a"));
        let second = coordinator
            .read_shared_for(
                GitReadRequest::new(&root, GitReadKind::Status, spec),
                &second_request,
            )
            .expect("cached query");

        assert!(Arc::ptr_eq(&first.stdout, &second.stdout));
        assert!(Arc::ptr_eq(&first.stderr, &second.stderr));
        assert!(first.stdout.len() + first.stderr.len() >= 4096);
        assert_eq!(
            coordinator.inner.cache_bytes.load(Ordering::Acquire),
            first.stdout.len() + first.stderr.len()
        );
        assert_eq!(
            fs::read_to_string(&counter)
                .expect("fixture counter")
                .lines()
                .count(),
            1,
            "the cache hit should avoid a second child process"
        );

        coordinator.invalidate(&root, GitDirtyScope::WORKTREE);
        assert_eq!(coordinator.inner.cache_bytes.load(Ordering::Acquire), 0);
        clear_fixture_env();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn per_repository_lru_evicts_one_cold_entry_and_keeps_a_hot_entry() {
        let _fixture_guard = FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = test_root();
        let counter = root.join("counter");
        env::set_var("PUDE_GIT_RUNTIME_PAYLOAD_BYTES", "1");
        let mut query_dirs = Vec::new();
        for index in 0..=MAX_CACHE_ENTRIES_PER_REPOSITORY {
            let query_dir = root.join(format!("query-{index}"));
            fs::create_dir(&query_dir).expect("query cwd");
            query_dirs.push(query_dir);
        }
        let coordinator = GitCoordinator::new();

        let query = |index: usize| {
            let spec = fixture_spec_with_counter(&query_dirs[index], "cache-payload", &counter);
            let request = coordinator.begin_request(&root, Some("window-a"));
            coordinator
                .read_shared_for(
                    GitReadRequest::new(&root, GitReadKind::Status, spec),
                    &request,
                )
                .expect("cache fixture query")
        };

        let mut bytes_per_entry = 0;
        for index in 0..MAX_CACHE_ENTRIES_PER_REPOSITORY {
            let output = query(index);
            bytes_per_entry = output.stdout.len() + output.stderr.len();
        }
        let first = query(0); // Refresh the first entry so query 1 becomes the LRU victim.
        assert_eq!(first.stdout.len() + first.stderr.len(), bytes_per_entry);
        query(MAX_CACHE_ENTRIES_PER_REPOSITORY);

        let repository = coordinator
            .repository_state(&root)
            .expect("repository state");
        {
            let state = lock_unpoison(&repository.state);
            assert_eq!(state.cache.len(), MAX_CACHE_ENTRIES_PER_REPOSITORY);
            assert_eq!(
                state.cache_bytes,
                MAX_CACHE_ENTRIES_PER_REPOSITORY * bytes_per_entry
            );
            assert!(
                state
                    .cache
                    .keys()
                    .any(|key| key.cwd == canonical_key(&query_dirs[0])),
                "the recently used entry should survive"
            );
            assert!(
                !state
                    .cache
                    .keys()
                    .any(|key| key.cwd == canonical_key(&query_dirs[1])),
                "the coldest entry should be evicted individually"
            );
        }
        query(1);
        assert_eq!(
            fs::read_to_string(&counter)
                .expect("fixture counter")
                .lines()
                .count(),
            MAX_CACHE_ENTRIES_PER_REPOSITORY + 2,
            "only the LRU query should need to start another child"
        );
        clear_fixture_env();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn global_byte_lru_evicts_across_repositories_by_recency() {
        let _fixture_guard = FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let roots = [test_root(), test_root(), test_root()];
        let counter = roots[0].join("counter");
        env::set_var("PUDE_GIT_RUNTIME_PAYLOAD_BYTES", "400000");
        let coordinator = GitCoordinator::new();

        let query = |index: usize| {
            let spec = fixture_spec_with_counter(&roots[index], "cache-payload", &counter);
            let request = coordinator.begin_request(&roots[index], Some("window-a"));
            coordinator
                .read_shared_for(
                    GitReadRequest::new(&roots[index], GitReadKind::Status, spec),
                    &request,
                )
                .expect("global cache fixture query")
        };

        let first = query(0);
        query(1);
        query(2);
        query(0); // The first repo is now the hottest cache entry.
        let bytes_per_entry = first.stdout.len() + first.stderr.len();
        assert_eq!(
            coordinator.inner.cache_bytes.load(Ordering::Acquire),
            3 * bytes_per_entry
        );
        let two_entry_limit = 2 * bytes_per_entry;
        coordinator.trim_global_cache_to(two_entry_limit);
        assert_eq!(
            coordinator.inner.cache_bytes.load(Ordering::Acquire),
            two_entry_limit
        );

        let cached = |index: usize| {
            let repository = coordinator
                .repository_state(&roots[index])
                .expect("repository state");
            let has_entries = !lock_unpoison(&repository.state).cache.is_empty();
            has_entries
        };
        assert!(cached(0), "the hot repository should remain cached");
        assert!(!cached(1), "the oldest repository should be evicted");
        assert!(cached(2), "the newer repository should remain cached");

        clear_fixture_env();
        for root in roots {
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn workspace_cancel_is_scoped_to_window_and_workspace() {
        let root = test_root();
        let other = test_root();
        let coordinator = GitCoordinator::new();
        let request_a = coordinator.begin_request(&root, Some("window-a"));
        let request_b = coordinator.begin_request(&root, Some("window-b"));
        let request_c = coordinator.begin_request(&other, Some("window-a"));
        assert_eq!(coordinator.cancel_workspace("window-a", &root), 1);
        assert!(request_a.token().is_cancelled());
        assert!(!request_b.token().is_cancelled());
        assert!(!request_c.token().is_cancelled());
        assert_eq!(coordinator.cancel_window("window-a"), 2);
        assert!(request_c.token().is_cancelled());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(other);
    }

    #[test]
    fn dirty_revisions_match_read_scopes() {
        let root = test_root();
        let coordinator = GitCoordinator::new();
        let initial = coordinator.revisions(&root);
        let status_initial = initial.for_kind(GitReadKind::Status);
        let refs_initial = initial.for_kind(GitReadKind::Refs);

        let after_worktree = coordinator.invalidate(&root, GitDirtyScope::WORKTREE);
        assert_ne!(after_worktree.for_kind(GitReadKind::Status), status_initial);
        assert_eq!(after_worktree.for_kind(GitReadKind::Refs), refs_initial);

        let after_index = coordinator.invalidate(&root, GitDirtyScope::INDEX);
        assert_ne!(
            after_index.for_kind(GitReadKind::Status),
            after_worktree.for_kind(GitReadKind::Status)
        );
        assert_eq!(after_index.for_kind(GitReadKind::Refs), refs_initial);

        let after_refs = coordinator.invalidate(&root, GitDirtyScope::REFS);
        assert_ne!(
            after_refs.for_kind(GitReadKind::Status),
            after_index.for_kind(GitReadKind::Status)
        );
        assert_ne!(after_refs.for_kind(GitReadKind::Refs), refs_initial);

        let after_head = coordinator.invalidate(&root, GitDirtyScope::HEAD);
        assert_ne!(
            after_head.for_kind(GitReadKind::Status),
            after_refs.for_kind(GitReadKind::Status)
        );
        assert_ne!(
            after_head.for_kind(GitReadKind::Refs),
            after_refs.for_kind(GitReadKind::Refs)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn idle_repository_states_are_evicted_at_bound() {
        let coordinator = GitCoordinator::new();
        let roots: Vec<_> = (0..(MAX_REPOSITORY_STATES + 8))
            .map(|_| test_root())
            .collect();
        for root in &roots {
            let _ = coordinator.revisions(root);
        }
        assert!(coordinator.repository_count() <= MAX_REPOSITORY_STATES);
        for root in roots {
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn active_repository_states_are_hard_capped() {
        let coordinator = GitCoordinator::new();
        let roots: Vec<_> = (0..MAX_REPOSITORY_STATES).map(|_| test_root()).collect();
        let mut states = Vec::with_capacity(roots.len());
        for root in &roots {
            let request = GitReadRequest::new(
                root,
                GitReadKind::Status,
                GitCommandSpec::read(root, Vec::new()),
            );
            let key = QueryKey::from_request(&canonical_key(root), &request);
            let state = coordinator
                .repository_state(root)
                .expect("active repository state");
            lock_unpoison(&state.state).flights.insert(
                key,
                Arc::new(QueryFlight::new(
                    GitRevisions::default().for_kind(GitReadKind::Status),
                )),
            );
            states.push(state);
        }

        assert_eq!(coordinator.repository_count(), MAX_REPOSITORY_STATES);
        let extra = test_root();
        let request = GitReadRequest::new(
            &extra,
            GitReadKind::Status,
            GitCommandSpec::read(&extra, Vec::new()),
        );
        let error = coordinator
            .read_shared(request, &CancellationToken::new())
            .expect_err("active coordinator capacity");
        assert_eq!(error.kind(), GitErrorKind::Capacity);

        drop(states);
        for root in roots {
            let _ = fs::remove_dir_all(root);
        }
        let _ = fs::remove_dir_all(extra);
    }

    #[test]
    fn final_cancel_wait_is_bounded_and_structured() {
        let flight = QueryFlight::new(GitRevisions::default().for_kind(GitReadKind::Status));
        flight.subscribers.store(1, Ordering::Release);
        let token = CancellationToken::new();
        token.cancel();
        let started = Instant::now();
        let error = flight.wait(&token).expect_err("unfinished flight cleanup");
        assert_eq!(error.kind(), GitErrorKind::CleanupFailed);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn final_cancel_reports_worker_cleanup_failure() {
        let flight = QueryFlight::new(GitRevisions::default().for_kind(GitReadKind::Status));
        flight.subscribers.store(1, Ordering::Release);
        flight.finish(Err(GitRuntimeError::cleanup("forced cleanup failure")));
        let token = CancellationToken::new();
        token.cancel();

        let error = flight
            .wait(&token)
            .expect_err("worker cleanup failure should not be hidden by cancellation");
        assert_eq!(error.kind(), GitErrorKind::CleanupFailed);
    }
}

#[cfg(test)]
#[path = "git_read_policy_tests.rs"]
mod git_read_policy_tests;
