use crate::git_repository::RepositoryIdentity;
use crate::git_runtime::{
    GitCommandOutput, GitCommandSpec, GitCoordinator, GitErrorInfo, GitErrorKind, RequestHandle,
    DEFAULT_READ_TIMEOUT, DEFAULT_STDERR_LIMIT, DEFAULT_STDOUT_LIMIT,
};
use serde::Serialize;
use std::collections::{BTreeMap, BinaryHeap, HashMap, HashSet};
use std::ffi::OsString;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use uuid::Uuid;

const HISTORY_REQUEST_DEADLINE: Duration = Duration::from_secs(10);
const HISTORY_MAX_CHILD_PROCESSES: usize = 32;
const HISTORY_MAX_COMMITS_PER_REQUEST: usize = 500;
const HISTORY_MAX_OUTPUT_BYTES_PER_REQUEST: usize = 8 * 1024 * 1024;
const HISTORY_MAX_PAGE_SIZE: usize = 120;
const HISTORY_MAX_CURSORS: usize = 32;
const HISTORY_MAX_CURSOR_BYTES: usize = 64 * 1024 * 1024;
const HISTORY_MAX_CURSOR_STATE_BYTES: usize = 8 * 1024 * 1024;
const HISTORY_MAX_SEEN_OIDS: usize = 100_000;
const HISTORY_CURSOR_TTL: Duration = Duration::from_secs(15 * 60);

// Git rejects NUL bytes in commit messages, so NUL can frame fields and commits
// (`-z`) without colliding with any message content.
const HISTORY_FORMAT: &str =
    "--pretty=format:%H%x00%P%x00%h%x00%an%x00%ad%x00%aI%x00%s%x00%D%x00%b";
const HISTORY_FIELDS_PER_COMMIT: usize = 9;
const REF_FORMAT: &str =
    "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(HEAD)";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    pub path: String,
    pub status: String,
    pub original_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub parents: Vec<String>,
    pub short_hash: String,
    pub author: String,
    pub date: String,
    pub authored_at: String,
    pub subject: String,
    pub body: String,
    pub refs: Vec<String>,
    pub files: Vec<GitCommitFile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryPage {
    pub commits: Vec<GitCommit>,
    pub has_more: bool,
    pub cursor: Option<String>,
    /// False only when this request stopped at a stated process, time, output,
    /// or cursor-state budget and some refs/ranges remain for a retry.
    pub complete: bool,
    pub unresolved_refs: Vec<String>,
    pub incomplete_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RefSnapshot {
    refs: Vec<RefSnapshotEntry>,
    head_oid: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RefSnapshotEntry {
    name_bytes: Vec<u8>,
    name: String,
    tip_oid: Option<String>,
    is_head: bool,
}

struct HistoryCursor {
    repository_identity: String,
    snapshot: RefSnapshot,
    seen_oids: HashSet<String>,
    raw_offset: usize,
    global_has_more: bool,
    pending_refs: BTreeMap<String, String>,
    last_request_processes: usize,
    last_request_output_bytes: usize,
    last_used: Instant,
}

impl HistoryCursor {
    fn estimated_bytes(&self) -> usize {
        let refs_bytes = self
            .snapshot
            .refs
            .iter()
            .map(|reference| reference.name_bytes.len() + reference.name.len() + 64)
            .sum::<usize>();
        let oids_bytes = self.seen_oids.len() * 64;
        let pending_bytes = self
            .pending_refs
            .iter()
            .map(|(name, oid)| name.len() + oid.len() + 64)
            .sum::<usize>();
        self.repository_identity.len()
            + refs_bytes
            + oids_bytes
            + pending_bytes
            + std::mem::size_of::<Self>()
    }

    fn unresolved_refs(&self) -> Vec<String> {
        self.pending_refs.keys().cloned().collect()
    }

    fn has_more(&self) -> bool {
        self.global_has_more || !self.pending_refs.is_empty()
    }
}

#[derive(Default)]
struct HistoryCursorStore {
    cursors: HashMap<String, HistoryCursor>,
    active: HashMap<String, usize>,
}

static HISTORY_CURSORS: OnceLock<Mutex<HistoryCursorStore>> = OnceLock::new();

fn cursor_store() -> &'static Mutex<HistoryCursorStore> {
    HISTORY_CURSORS.get_or_init(|| Mutex::new(HistoryCursorStore::default()))
}

/// Load the initial bounded history window or advance an opaque continuation.
/// The cursor is an in-memory handle bound to the repository's filesystem
/// identity and an exact refs/HEAD snapshot. Continuations advance a raw
/// `git log --all` offset and return only the next window, while quiet ref tips
/// are resolved once by unique object ID.
pub fn load_git_commits_page(
    repository: &std::path::Path,
    identity: &RepositoryIdentity,
    runtime: &GitCoordinator,
    request: &RequestHandle,
    cursor: Option<&str>,
    page_size: usize,
) -> Result<GitHistoryPage, GitErrorInfo> {
    let page_size = page_size.clamp(1, HISTORY_MAX_PAGE_SIZE);
    let mut budget = HistoryRequestBudget::new();
    let snapshot = match read_ref_snapshot(repository, runtime, request, &mut budget)? {
        Some(snapshot) => snapshot,
        None => {
            return Ok(GitHistoryPage {
                commits: Vec::new(),
                has_more: cursor.is_some(),
                cursor: cursor.map(str::to_string),
                complete: false,
                unresolved_refs: Vec::new(),
                incomplete_reason: budget.partial_reason,
            });
        }
    };

    let (cursor_key, mut state) = if let Some(cursor) = cursor {
        let state = take_cursor(cursor)?;
        if state.repository_identity != identity.fingerprint() || state.snapshot != snapshot {
            finish_cursor(cursor, None);
            return Err(error(
                GitErrorKind::Cancelled,
                "Git refs or repository identity changed; reload history before continuing.",
            ));
        }
        (Some(cursor.to_string()), state)
    } else {
        (None, new_cursor_state(identity, snapshot))
    };

    let result = if cursor_key.is_some() {
        read_history_continuation(
            repository,
            runtime,
            request,
            &mut budget,
            &mut state,
            page_size,
        )
    } else {
        read_initial_history(
            repository,
            runtime,
            request,
            &mut budget,
            &mut state,
            page_size,
        )
    };
    let commits = match result {
        Ok(commits) => commits,
        Err(error) => {
            if let Some(cursor_key) = cursor_key.as_deref() {
                finish_cursor(cursor_key, Some(state));
            }
            return Err(error);
        }
    };
    state.last_request_processes = budget.child_processes;
    state.last_request_output_bytes = budget.output_bytes;
    let has_more = state.has_more();
    let unresolved_refs = state.unresolved_refs();
    let incomplete_reason = budget.partial_reason;
    let complete = incomplete_reason.is_none();

    let next_cursor = if has_more {
        let key = cursor_key
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        state.last_used = Instant::now();
        if state.seen_oids.len() >= HISTORY_MAX_SEEN_OIDS {
            if let Some(cursor_key) = cursor_key.as_deref() {
                finish_cursor(cursor_key, None);
            }
            return Ok(GitHistoryPage {
                commits,
                has_more: true,
                cursor: None,
                complete: false,
                unresolved_refs,
                incomplete_reason: Some(
                    "Git history reached the cursor's 100,000-commit state limit; reload history to start a fresh scan.".to_string(),
                ),
            });
        }
        if publish_cursor(&key, state) {
            Some(key)
        } else {
            if let Some(cursor_key) = cursor_key.as_deref() {
                finish_cursor(cursor_key, None);
            }
            return Ok(GitHistoryPage {
                commits,
                has_more: true,
                cursor: None,
                complete: false,
                unresolved_refs,
                incomplete_reason: Some(
                    "Git history continuation storage is full; reload history to continue."
                        .to_string(),
                ),
            });
        }
    } else {
        if let Some(cursor_key) = cursor_key.as_deref() {
            finish_cursor(cursor_key, None);
        }
        None
    };

    Ok(GitHistoryPage {
        commits,
        has_more,
        cursor: next_cursor,
        complete,
        unresolved_refs,
        incomplete_reason,
    })
}

fn new_cursor_state(identity: &RepositoryIdentity, snapshot: RefSnapshot) -> HistoryCursor {
    let mut pending_refs = BTreeMap::new();
    for reference in &snapshot.refs {
        if let Some(tip_oid) = &reference.tip_oid {
            pending_refs.insert(reference.name.clone(), tip_oid.clone());
        }
    }
    let is_detached = !snapshot.refs.iter().any(|reference| reference.is_head);
    if is_detached {
        if let Some(head_oid) = &snapshot.head_oid {
            pending_refs.insert("HEAD".to_string(), head_oid.clone());
        }
    }
    HistoryCursor {
        repository_identity: identity.fingerprint(),
        snapshot,
        seen_oids: HashSet::new(),
        raw_offset: 0,
        global_has_more: true,
        pending_refs,
        last_request_processes: 0,
        last_request_output_bytes: 0,
        last_used: Instant::now(),
    }
}

struct HistoryRequestBudget {
    deadline: Instant,
    child_processes: usize,
    output_bytes: usize,
    partial_reason: Option<String>,
}

impl HistoryRequestBudget {
    fn new() -> Self {
        Self {
            deadline: Instant::now() + HISTORY_REQUEST_DEADLINE,
            child_processes: 0,
            output_bytes: 0,
            partial_reason: None,
        }
    }

    fn can_start_child(&mut self, request: &RequestHandle) -> Result<bool, GitErrorInfo> {
        if request.token().is_cancelled() {
            return Err(error(GitErrorKind::Cancelled, "Git command was cancelled."));
        }
        if self.partial_reason.is_some() {
            return Ok(false);
        }
        if Instant::now() >= self.deadline {
            self.mark_partial("The Git history request reached its 10 second deadline.");
            return Ok(false);
        }
        if self.child_processes >= HISTORY_MAX_CHILD_PROCESSES {
            self.mark_partial("The Git history request reached its 32 process limit.");
            return Ok(false);
        }
        if self.output_bytes >= HISTORY_MAX_OUTPUT_BYTES_PER_REQUEST {
            self.mark_partial("The Git history request reached its 8 MiB output limit.");
            return Ok(false);
        }
        Ok(true)
    }

    fn mark_partial(&mut self, reason: &str) {
        self.partial_reason
            .get_or_insert_with(|| reason.to_string());
    }

    fn run_raw(
        &mut self,
        repository: &std::path::Path,
        runtime: &GitCoordinator,
        request: &RequestHandle,
        args: Vec<OsString>,
    ) -> Result<Option<GitCommandOutput>, GitErrorInfo> {
        if !self.can_start_child(request)? {
            return Ok(None);
        }
        let remaining_bytes = HISTORY_MAX_OUTPUT_BYTES_PER_REQUEST - self.output_bytes;
        let stderr_limit = remaining_bytes.min(DEFAULT_STDERR_LIMIT);
        let stdout_limit = remaining_bytes
            .saturating_sub(stderr_limit)
            .min(DEFAULT_STDOUT_LIMIT);
        let remaining_time = self.deadline.saturating_duration_since(Instant::now());
        if remaining_time.is_zero() || stdout_limit == 0 {
            self.mark_partial(if remaining_time.is_zero() {
                "The Git history request reached its 10 second deadline."
            } else {
                "The Git history request reached its 8 MiB output limit."
            });
            return Ok(None);
        }
        let mut spec = GitCommandSpec::read(repository, args);
        spec.timeout = remaining_time.min(DEFAULT_READ_TIMEOUT);
        spec.stdout_limit = stdout_limit;
        spec.stderr_limit = stderr_limit;
        self.child_processes += 1;
        let output = match runtime.execute(spec, &request.token()) {
            Ok(output) => output,
            Err(error_value) => {
                let info = error_value.info();
                match info.kind {
                    GitErrorKind::OutputLimit => {
                        self.mark_partial("A Git history child reached its output byte limit.");
                        return Ok(None);
                    }
                    GitErrorKind::TimedOut => {
                        self.mark_partial("A Git history child reached the request deadline.");
                        return Ok(None);
                    }
                    GitErrorKind::Capacity => {
                        self.mark_partial("Git history could not start another query because the native Git coordinator is full.");
                        return Ok(None);
                    }
                    GitErrorKind::Cancelled => return Err(info),
                    _ => return Err(info),
                }
            }
        };
        self.output_bytes = self
            .output_bytes
            .saturating_add(output.stdout.len())
            .saturating_add(output.stderr.len());
        if self.output_bytes > HISTORY_MAX_OUTPUT_BYTES_PER_REQUEST {
            self.mark_partial("The Git history request reached its 8 MiB output limit.");
            return Ok(None);
        }
        Ok(Some(output))
    }
}

fn read_ref_snapshot(
    repository: &std::path::Path,
    runtime: &GitCoordinator,
    request: &RequestHandle,
    budget: &mut HistoryRequestBudget,
) -> Result<Option<RefSnapshot>, GitErrorInfo> {
    let refs = match budget.run_raw(
        repository,
        runtime,
        request,
        vec![
            OsString::from("for-each-ref"),
            OsString::from(REF_FORMAT),
            OsString::from("refs"),
        ],
    )? {
        Some(output) => output
            .into_success()
            .map_err(|error_value| error_value.info())?,
        None => return Ok(None),
    };
    let mut parsed_refs = parse_ref_snapshot(&refs.stdout);
    parsed_refs.sort_by(|left, right| left.name_bytes.cmp(&right.name_bytes));

    let head = match budget.run_raw(
        repository,
        runtime,
        request,
        vec![
            OsString::from("rev-parse"),
            OsString::from("--verify"),
            OsString::from("--quiet"),
            OsString::from("HEAD"),
        ],
    )? {
        Some(output) if output.success => parse_single_oid(&output.stdout),
        Some(_) => None,
        None => return Ok(None),
    };
    Ok(Some(RefSnapshot {
        refs: parsed_refs,
        head_oid: head,
    }))
}

fn parse_ref_snapshot(bytes: &[u8]) -> Vec<RefSnapshotEntry> {
    let mut refs = Vec::new();
    for line in bytes.split(|byte| *byte == b'\n') {
        let fields: Vec<&[u8]> = line.split(|byte| *byte == 0).collect();
        if fields.len() < 6 || fields[0].is_empty() {
            continue;
        }
        let name_bytes = fields[0].to_vec();
        let object_oid = String::from_utf8_lossy(fields[1]).trim().to_string();
        let object_type = fields[2];
        let peeled_oid = String::from_utf8_lossy(fields[3]).trim().to_string();
        let peeled_type = fields[4];
        let tip_oid = if peeled_type == b"commit" && !peeled_oid.is_empty() {
            Some(peeled_oid)
        } else if object_type == b"commit" && !object_oid.is_empty() {
            Some(object_oid)
        } else {
            None
        };
        refs.push(RefSnapshotEntry {
            name: String::from_utf8_lossy(&name_bytes).into_owned(),
            name_bytes,
            tip_oid,
            is_head: fields[5].first() == Some(&b'*'),
        });
    }
    refs
}

fn parse_single_oid(bytes: &[u8]) -> Option<String> {
    let value = String::from_utf8_lossy(bytes).trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn read_initial_history(
    repository: &std::path::Path,
    runtime: &GitCoordinator,
    request: &RequestHandle,
    budget: &mut HistoryRequestBudget,
    state: &mut HistoryCursor,
    page_size: usize,
) -> Result<Vec<GitCommit>, GitErrorInfo> {
    let mut commits_by_hash = HashMap::<String, GitCommit>::new();
    let fetch_limit = page_size
        .saturating_add(1)
        .min(HISTORY_MAX_COMMITS_PER_REQUEST);
    let revisions = history_revisions(state);
    match budget.run_raw(
        repository,
        runtime,
        request,
        history_args(&revisions, fetch_limit, None),
    )? {
        Some(output) => {
            let output = output
                .into_success()
                .map_err(|error_value| error_value.info())?;
            let mut raw_commits = parse_git_commits(&output.stdout);
            let consumed = raw_commits.len().min(page_size);
            state.raw_offset = state.raw_offset.saturating_add(consumed);
            state.global_has_more = raw_commits.len() > consumed
                || (raw_commits.len() == fetch_limit && fetch_limit < page_size.saturating_add(1));
            raw_commits.truncate(consumed);
            merge_history(
                raw_commits,
                &mut commits_by_hash,
                HISTORY_MAX_COMMITS_PER_REQUEST,
            );
        }
        None => state.global_has_more = true,
    }

    resolve_pending_ref_tips(
        repository,
        runtime,
        request,
        budget,
        state,
        &mut commits_by_hash,
    )?;

    commit_page_into_state(state, commits_by_hash.values());
    Ok(order_git_commits_topologically(
        commits_by_hash.into_values().collect(),
    ))
}

fn read_history_continuation(
    repository: &std::path::Path,
    runtime: &GitCoordinator,
    request: &RequestHandle,
    budget: &mut HistoryRequestBudget,
    state: &mut HistoryCursor,
    page_size: usize,
) -> Result<Vec<GitCommit>, GitErrorInfo> {
    let mut commits_by_hash = HashMap::<String, GitCommit>::new();
    resolve_pending_ref_tips(
        repository,
        runtime,
        request,
        budget,
        state,
        &mut commits_by_hash,
    )?;

    if budget.partial_reason.is_none() {
        let remaining = HISTORY_MAX_COMMITS_PER_REQUEST.saturating_sub(commits_by_hash.len());
        if remaining == 0 {
            budget.mark_partial("The Git history request reached its 500 unique commit limit.");
        } else {
            let fetch_limit = page_size.saturating_add(1).min(remaining);
            let revisions = history_revisions(state);
            let args = history_args(&revisions, fetch_limit, Some(state.raw_offset));
            if let Some(output) = budget.run_raw(repository, runtime, request, args)? {
                let output = output
                    .into_success()
                    .map_err(|error_value| error_value.info())?;
                let mut raw_commits = parse_git_commits(&output.stdout);
                let consumed = raw_commits.len().min(page_size);
                state.raw_offset = state.raw_offset.saturating_add(consumed);
                state.global_has_more = raw_commits.len() > consumed
                    || (raw_commits.len() == fetch_limit
                        && fetch_limit < page_size.saturating_add(1));
                if raw_commits.len() == fetch_limit && fetch_limit < page_size.saturating_add(1) {
                    budget.mark_partial(
                        "The Git history request reached its 500 unique commit limit.",
                    );
                }
                raw_commits.truncate(consumed);
                raw_commits.retain(|commit| !state.seen_oids.contains(&commit.hash));
                merge_history(
                    raw_commits,
                    &mut commits_by_hash,
                    HISTORY_MAX_COMMITS_PER_REQUEST,
                );
            }
        }
    }

    commit_page_into_state(state, commits_by_hash.values());
    Ok(order_git_commits_topologically(
        commits_by_hash.into_values().collect(),
    ))
}

fn resolve_pending_ref_tips(
    repository: &std::path::Path,
    runtime: &GitCoordinator,
    request: &RequestHandle,
    budget: &mut HistoryRequestBudget,
    state: &HistoryCursor,
    commits_by_hash: &mut HashMap<String, GitCommit>,
) -> Result<(), GitErrorInfo> {
    let mut tips: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (reference, tip_oid) in &state.pending_refs {
        if !state.seen_oids.contains(tip_oid) {
            tips.entry(tip_oid.clone())
                .or_default()
                .push(reference.clone());
        }
    }

    for (tip_oid, references) in tips {
        if let Some(commit) = commits_by_hash.get_mut(&tip_oid) {
            add_ref_names(commit, &references);
            continue;
        }
        if commits_by_hash.len() >= HISTORY_MAX_COMMITS_PER_REQUEST {
            budget.mark_partial("The Git history request reached its 500 unique commit limit.");
            break;
        }
        let Some(output) = budget.run_raw(
            repository,
            runtime,
            request,
            history_args(&[tip_oid.as_str()], 1, None),
        )?
        else {
            break;
        };
        let output = output
            .into_success()
            .map_err(|error_value| error_value.info())?;
        merge_history(
            parse_git_commits(&output.stdout),
            commits_by_hash,
            HISTORY_MAX_COMMITS_PER_REQUEST,
        );
        if let Some(commit) = commits_by_hash.get_mut(&tip_oid) {
            add_ref_names(commit, &references);
        }
    }
    Ok(())
}

fn add_ref_names(commit: &mut GitCommit, references: &[String]) {
    for reference in references {
        let display_name = short_ref_name(reference);
        if !commit.refs.contains(&display_name) {
            commit.refs.push(display_name);
        }
    }
}

fn history_revisions(state: &HistoryCursor) -> Vec<&str> {
    let mut revisions = vec!["--all"];
    let detached_head = !state
        .snapshot
        .refs
        .iter()
        .any(|reference| reference.is_head);
    if detached_head {
        if let Some(head_oid) = &state.snapshot.head_oid {
            revisions.push(head_oid.as_str());
        }
    }
    revisions
}

fn history_args(revisions: &[&str], limit: usize, skip: Option<usize>) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("log"),
        OsString::from("-z"),
        OsString::from("--topo-order"),
        OsString::from("--max-count"),
        OsString::from(limit.max(1).to_string()),
        OsString::from("--date=short"),
        OsString::from("--decorate=short"),
        OsString::from(HISTORY_FORMAT),
    ];
    if let Some(skip) = skip {
        args.push(OsString::from(format!("--skip={skip}")));
    }
    args.extend(revisions.iter().map(OsString::from));
    args
}

fn merge_history(commits: Vec<GitCommit>, output: &mut HashMap<String, GitCommit>, limit: usize) {
    for commit in commits {
        if let Some(existing) = output.get_mut(&commit.hash) {
            for reference in commit.refs {
                if !existing.refs.contains(&reference) {
                    existing.refs.push(reference);
                }
            }
        } else if output.len() < limit {
            output.insert(commit.hash.clone(), commit);
        } else {
            break;
        }
    }
}

fn commit_page_into_state<'a>(
    state: &mut HistoryCursor,
    commits: impl Iterator<Item = &'a GitCommit>,
) {
    let commits: Vec<&GitCommit> = commits.collect();
    for commit in &commits {
        state.seen_oids.insert(commit.hash.clone());
    }
    state
        .pending_refs
        .retain(|_, tip_oid| !state.seen_oids.contains(tip_oid));
    state.last_used = Instant::now();
}

fn short_ref_name(reference: &str) -> String {
    reference
        .strip_prefix("refs/heads/")
        .or_else(|| reference.strip_prefix("refs/remotes/"))
        .or_else(|| reference.strip_prefix("refs/tags/"))
        .unwrap_or(reference)
        .to_string()
}

fn parse_git_commits(bytes: &[u8]) -> Vec<GitCommit> {
    let fields: Vec<String> = bytes
        .split(|byte| *byte == 0)
        .map(|field| String::from_utf8_lossy(field).into_owned())
        .collect();
    fields
        .as_chunks::<HISTORY_FIELDS_PER_COMMIT>()
        .0
        .iter()
        .map(|fields| GitCommit {
            hash: fields[0].to_string(),
            parents: fields[1]
                .split_whitespace()
                .filter(|parent| !parent.is_empty())
                .map(str::to_string)
                .collect(),
            short_hash: fields[2].to_string(),
            author: fields[3].to_string(),
            date: fields[4].to_string(),
            authored_at: fields[5].to_string(),
            subject: fields[6].to_string(),
            body: fields[8].trim().to_string(),
            refs: fields[7]
                .split(", ")
                .filter(|reference| !reference.is_empty())
                .map(str::to_string)
                .collect(),
            files: Vec::new(),
        })
        .collect()
}

fn order_git_commits_topologically(commits: Vec<GitCommit>) -> Vec<GitCommit> {
    let indexes: HashMap<&str, usize> = commits
        .iter()
        .enumerate()
        .map(|(index, commit)| (commit.hash.as_str(), index))
        .collect();
    let mut remaining_children = vec![0usize; commits.len()];
    for commit in &commits {
        for parent in &commit.parents {
            if let Some(parent_index) = indexes.get(parent.as_str()) {
                remaining_children[*parent_index] += 1;
            }
        }
    }

    let mut ready = BinaryHeap::new();
    for (index, commit) in commits.iter().enumerate() {
        if remaining_children[index] == 0 {
            ready.push((commit.authored_at.clone(), commit.hash.clone(), index));
        }
    }

    let mut ordered_indexes = Vec::with_capacity(commits.len());
    while let Some((_, _, index)) = ready.pop() {
        ordered_indexes.push(index);
        for parent in &commits[index].parents {
            let Some(parent_index) = indexes.get(parent.as_str()).copied() else {
                continue;
            };
            remaining_children[parent_index] -= 1;
            if remaining_children[parent_index] == 0 {
                let parent = &commits[parent_index];
                ready.push((
                    parent.authored_at.clone(),
                    parent.hash.clone(),
                    parent_index,
                ));
            }
        }
    }

    if ordered_indexes.len() < commits.len() {
        let included: HashSet<usize> = ordered_indexes.iter().copied().collect();
        ordered_indexes.extend((0..commits.len()).filter(|index| !included.contains(index)));
    }
    let mut commits: Vec<Option<GitCommit>> = commits.into_iter().map(Some).collect();
    ordered_indexes
        .into_iter()
        .filter_map(|index| commits[index].take())
        .collect()
}

fn take_cursor(token: &str) -> Result<HistoryCursor, GitErrorInfo> {
    let mut store = cursor_store()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    prune_expired_cursors(&mut store);
    if store.active.contains_key(token) {
        return Err(error(
            GitErrorKind::Capacity,
            "This Git history page is already being advanced.",
        ));
    }
    let state = store.cursors.remove(token).ok_or_else(|| {
        error(
            GitErrorKind::Failed,
            "Git history cursor expired; reload history to continue.",
        )
    })?;
    if store.cursors.len() + store.active.len() >= HISTORY_MAX_CURSORS {
        store.cursors.insert(token.to_string(), state);
        return Err(error(
            GitErrorKind::Capacity,
            "Git history continuation concurrency is temporarily full.",
        ));
    }
    let state_bytes = state.estimated_bytes();
    store.active.insert(token.to_string(), state_bytes);
    Ok(state)
}

fn finish_cursor(token: &str, state: Option<HistoryCursor>) {
    let mut store = cursor_store()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    store.active.remove(token);
    if let Some(mut state) = state {
        state.last_used = Instant::now();
        store.cursors.insert(token.to_string(), state);
    }
}

fn publish_cursor(token: &str, state: HistoryCursor) -> bool {
    let state_bytes = state.estimated_bytes();
    if state_bytes > HISTORY_MAX_CURSOR_STATE_BYTES {
        return false;
    }
    let mut store = cursor_store()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    prune_expired_cursors(&mut store);
    publish_cursor_in_store(&mut store, token, state)
}

fn publish_cursor_in_store(
    store: &mut HistoryCursorStore,
    token: &str,
    state: HistoryCursor,
) -> bool {
    let state_bytes = state.estimated_bytes();
    if state_bytes > HISTORY_MAX_CURSOR_STATE_BYTES {
        return false;
    }
    let current_active_bytes = store.active.get(token).copied().unwrap_or(0);
    loop {
        let other_cursor_count = store
            .cursors
            .len()
            .saturating_add(store.active.len())
            .saturating_sub(usize::from(store.active.contains_key(token)));
        let next_cursor_bytes = cursor_store_bytes(store)
            .saturating_sub(current_active_bytes)
            .saturating_add(state_bytes);
        if other_cursor_count < HISTORY_MAX_CURSORS && next_cursor_bytes <= HISTORY_MAX_CURSOR_BYTES
        {
            break;
        }
        let oldest = store
            .cursors
            .iter()
            .filter(|(key, _)| key.as_str() != token)
            .min_by_key(|(_, state)| state.last_used)
            .map(|(key, _)| key.clone());
        let Some(oldest) = oldest else {
            return false;
        };
        store.cursors.remove(&oldest);
    }
    store.active.remove(token);
    store.cursors.insert(token.to_string(), state);
    true
}

fn prune_expired_cursors(store: &mut HistoryCursorStore) {
    let now = Instant::now();
    store
        .cursors
        .retain(|_, state| now.duration_since(state.last_used) <= HISTORY_CURSOR_TTL);
}

fn cursor_store_bytes(store: &HistoryCursorStore) -> usize {
    let cursor_bytes: usize = store
        .cursors
        .values()
        .map(HistoryCursor::estimated_bytes)
        .sum();
    cursor_bytes.saturating_add(store.active.values().copied().sum::<usize>())
}

fn error(kind: GitErrorKind, message: impl Into<String>) -> GitErrorInfo {
    GitErrorInfo {
        kind,
        message: message.into(),
        exit_code: None,
        stream: None,
        limit: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_repository::RepositoryRootCache;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::atomic::AtomicU64;

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(1);

    fn test_cursor(age_seconds: u64) -> HistoryCursor {
        HistoryCursor {
            repository_identity: "test-repository".to_string(),
            snapshot: RefSnapshot {
                refs: Vec::new(),
                head_oid: None,
            },
            seen_oids: HashSet::new(),
            raw_offset: 0,
            global_has_more: true,
            pending_refs: BTreeMap::new(),
            last_request_processes: 0,
            last_request_output_bytes: 0,
            last_used: Instant::now() - Duration::from_secs(age_seconds),
        }
    }

    struct GitFixture {
        path: PathBuf,
        runtime: GitCoordinator,
        roots: RepositoryRootCache,
    }

    impl GitFixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "pude-git-history-test-{}-{}",
                std::process::id(),
                TEST_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).expect("fixture directory");
            let fixture = Self {
                path,
                runtime: GitCoordinator::new(),
                roots: RepositoryRootCache::default(),
            };
            fixture.git(&["init", "--quiet"]);
            fixture.git(&["config", "user.name", "History Test"]);
            fixture.git(&["config", "user.email", "history@example.test"]);
            fixture
        }

        fn git(&self, args: &[&str]) -> String {
            let output = Command::new("git")
                .args(args)
                .current_dir(&self.path)
                .output()
                .expect("git executable");
            assert!(
                output.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }

        fn commit(&self, name: &str, content: &str) -> String {
            fs::write(self.path.join("history.txt"), content).expect("history file");
            self.git(&["add", "history.txt"]);
            self.git(&["commit", "--quiet", "-m", name]);
            self.git(&["rev-parse", "HEAD"])
        }

        fn commit_file(&self, name: &str, path: &str, content: &str) -> String {
            fs::write(self.path.join(path), content).expect("commit file");
            self.git(&["add", path]);
            self.git(&["commit", "--quiet", "-m", name]);
            self.git(&["rev-parse", "HEAD"])
        }

        fn load(&self, cursor: Option<&str>, page_size: usize) -> GitHistoryPage {
            let request = self.runtime.begin_request(&self.path, Some("history-test"));
            let repository = self
                .roots
                .resolve(&self.path, &self.runtime, &request)
                .expect("repository discovery");
            load_git_commits_page(
                &repository.root,
                &repository.identity,
                &self.runtime,
                &request,
                cursor,
                page_size,
            )
            .expect("history query")
        }
    }

    impl Drop for GitFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn commit_messages_containing_old_record_separators_still_parse() {
        let fixture = GitFixture::new();
        let hash = fixture.commit("subject\u{1e}with\u{1f}controls", "first\n");
        let second = fixture.commit("second", "second\n");

        let page = fixture.load(None, 10);

        let hashes: Vec<&str> = page
            .commits
            .iter()
            .map(|commit| commit.hash.as_str())
            .collect();
        assert_eq!(hashes, [second.as_str(), hash.as_str()]);
        assert_eq!(page.commits[1].subject, "subject\u{1e}with\u{1f}controls");
    }

    #[test]
    fn publishing_the_33rd_cursor_evicts_one_lru_and_preserves_active_slots() {
        let mut store = HistoryCursorStore::default();
        for index in 0..HISTORY_MAX_CURSORS {
            store.cursors.insert(
                format!("cursor-{index}"),
                test_cursor((HISTORY_MAX_CURSORS - index) as u64),
            );
        }

        assert!(publish_cursor_in_store(
            &mut store,
            "cursor-new",
            test_cursor(0)
        ));
        assert_eq!(store.cursors.len(), HISTORY_MAX_CURSORS);
        assert!(!store.cursors.contains_key("cursor-0"));
        assert!(store.cursors.contains_key("cursor-new"));
        for index in 1..HISTORY_MAX_CURSORS {
            assert!(store.cursors.contains_key(&format!("cursor-{index}")));
        }

        let mut store_with_active = HistoryCursorStore::default();
        for index in 0..HISTORY_MAX_CURSORS - 1 {
            store_with_active.cursors.insert(
                format!("inactive-{index}"),
                test_cursor((HISTORY_MAX_CURSORS - index) as u64),
            );
        }
        store_with_active.active.insert(
            "active-cursor".to_string(),
            test_cursor(0).estimated_bytes(),
        );
        assert!(publish_cursor_in_store(
            &mut store_with_active,
            "new-cursor",
            test_cursor(0)
        ));
        assert!(store_with_active.active.contains_key("active-cursor"));
        assert!(!store_with_active.cursors.contains_key("inactive-0"));
        assert!(store_with_active.cursors.contains_key("new-cursor"));
        assert_eq!(
            store_with_active.cursors.len() + store_with_active.active.len(),
            HISTORY_MAX_CURSORS
        );
    }

    fn set_test_timestamp(path: &Path, seconds: i64) {
        let output = Command::new("git")
            .args([
                "commit",
                "--quiet",
                "--amend",
                "--no-edit",
                "--date",
                &format!("@{seconds} +0000"),
            ])
            .env("GIT_COMMITTER_DATE", format!("@{seconds} +0000"))
            .current_dir(path)
            .output()
            .expect("git amend timestamp");
        assert!(
            output.status.success(),
            "git amend: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn continuation_reads_only_the_unseen_parent_frontier() {
        let fixture = GitFixture::new();
        let mut expected = Vec::new();
        for index in 0..25 {
            expected.push(fixture.commit(&format!("commit-{index}"), &format!("{index}\n")));
        }
        let first = fixture.load(None, 5);
        assert_eq!(first.commits.len(), 5);
        assert!(first.has_more);
        let cursor = first.cursor.expect("continuation token");
        let second = fixture.load(Some(&cursor), 5);
        assert_eq!(second.commits.len(), 5);
        assert!(second.complete);
        assert!(second.has_more);
        assert!(first
            .commits
            .iter()
            .all(|old| second.commits.iter().all(|new| old.hash != new.hash)));

        let mut loaded = first.commits;
        let mut page = second;
        while page.has_more {
            let cursor = page.cursor.take().expect("cursor while history remains");
            loaded.extend(page.commits);
            page = fixture.load(Some(&cursor), 5);
        }
        loaded.extend(page.commits);
        let hashes: HashSet<_> = loaded.iter().map(|commit| commit.hash.as_str()).collect();
        assert_eq!(hashes.len(), 25, "every commit appears once across pages");
        assert_eq!(hashes.len(), expected.len());
    }

    #[test]
    fn identical_quiet_tips_are_queried_once_and_keep_all_ref_names() {
        let fixture = GitFixture::new();
        let quiet_tip = fixture.commit("quiet root", "root\n");
        for index in 0..30 {
            fixture.commit(&format!("busy-{index}"), &format!("busy {index}\n"));
        }
        for index in 0..40 {
            fixture.git(&["branch", &format!("quiet-{index}"), &quiet_tip]);
        }
        let page = fixture.load(None, 5);
        let tip = page
            .commits
            .iter()
            .find(|commit| commit.hash == quiet_tip)
            .expect("quiet branch tip remains visible");
        for index in 0..40 {
            assert!(tip.refs.contains(&format!("quiet-{index}")));
        }
        assert!(page.complete);
        assert!(page.unresolved_refs.is_empty());
        let cursor = page.cursor.expect("remaining busy history");
        let store = cursor_store().lock().expect("cursor store lock");
        let state = store.cursors.get(&cursor).expect("stored cursor");
        assert_eq!(
            state.last_request_processes, 4,
            "one quiet OID uses one child"
        );
        assert!(state.last_request_output_bytes > 0);
    }

    #[test]
    fn cursor_is_rejected_after_ref_topology_changes() {
        let fixture = GitFixture::new();
        for index in 0..8 {
            fixture.commit(&format!("commit-{index}"), &format!("{index}\n"));
        }
        let first = fixture.load(None, 3);
        let cursor = first.cursor.expect("continuation token");
        fixture.commit("new head", "new\n");
        let request = fixture
            .runtime
            .begin_request(&fixture.path, Some("history-test"));
        let repository = fixture
            .roots
            .resolve(&fixture.path, &fixture.runtime, &request)
            .expect("same repository identity");
        let error = load_git_commits_page(
            &repository.root,
            &repository.identity,
            &fixture.runtime,
            &request,
            Some(&cursor),
            3,
        )
        .expect_err("stale cursor must not mix a new ref snapshot");
        assert_eq!(error.kind, GitErrorKind::Cancelled);
        assert!(error
            .message
            .contains("refs or repository identity changed"));
    }

    #[test]
    fn identical_timestamps_and_merge_parents_are_kept_across_pages() {
        let fixture = GitFixture::new();
        const TIMESTAMP: i64 = 1_700_000_000;
        fixture.commit("base", "base\n");
        set_test_timestamp(&fixture.path, TIMESTAMP);
        fixture.git(&["branch", "-M", "main"]);
        fixture.git(&["checkout", "--quiet", "-b", "left"]);
        fixture.commit_file("left", "left.txt", "left\n");
        set_test_timestamp(&fixture.path, TIMESTAMP);
        fixture.git(&["checkout", "--quiet", "-b", "right", "main"]);
        fixture.commit_file("right", "right.txt", "right\n");
        set_test_timestamp(&fixture.path, TIMESTAMP);
        fixture.git(&["checkout", "--quiet", "left"]);
        fixture.git(&["merge", "--quiet", "--no-ff", "right", "-m", "merge"]);
        set_test_timestamp(&fixture.path, TIMESTAMP);
        for index in 0..20 {
            fixture.commit_file(
                &format!("after-merge-{index}"),
                &format!("after-merge-{index}.txt"),
                &format!("{index}\n"),
            );
            set_test_timestamp(&fixture.path, TIMESTAMP);
        }
        let branch = fixture.git(&["branch", "--show-current"]);
        assert_eq!(branch, "left");

        let mut loaded = Vec::new();
        let mut page = fixture.load(None, 2);
        let mut page_count = 1;
        while page.has_more {
            let cursor = page.cursor.clone().expect("cursor while history remains");
            loaded.extend(page.commits);
            page = fixture.load(Some(&cursor), 2);
            page_count += 1;
        }
        loaded.extend(page.commits);
        assert!(page_count >= 10, "fixture must exercise ten or more pages");
        let by_subject: HashMap<_, _> = loaded
            .iter()
            .map(|commit| (commit.subject.as_str(), commit))
            .collect();
        let merge = by_subject.get("merge").expect("merge commit");
        assert_eq!(merge.parents.len(), 2);
        assert!(by_subject.contains_key("left"));
        assert!(by_subject.contains_key("right"));
        assert!(by_subject["right"].refs.contains(&"right".to_string()));
        assert!(loaded
            .iter()
            .any(|commit| commit.refs.contains(&"left".to_string())));
        assert_eq!(
            loaded
                .iter()
                .map(|commit| commit.authored_at.as_str())
                .collect::<HashSet<_>>()
                .len(),
            1,
            "all fixture commits share a timestamp"
        );
        let unique: HashSet<_> = loaded.iter().map(|commit| commit.hash.clone()).collect();
        assert_eq!(unique.len(), loaded.len());
        let reference_oids: HashSet<_> = fixture
            .git(&["log", "--all", "--format=%H"])
            .lines()
            .map(str::to_string)
            .collect();
        assert_eq!(
            unique, reference_oids,
            "cursor pages equal the complete Git reference walk"
        );
    }

    #[test]
    fn history_request_budget_has_fixed_child_commit_and_output_caps() {
        let mut budget = HistoryRequestBudget::new();
        budget.child_processes = HISTORY_MAX_CHILD_PROCESSES;
        assert!(!budget
            .can_start_child(&GitCoordinator::new().begin_request("/tmp", None))
            .expect("budget check"));
        assert!(budget
            .partial_reason
            .as_deref()
            .unwrap()
            .contains("32 process"));

        let mut output_budget = HistoryRequestBudget::new();
        output_budget.output_bytes = HISTORY_MAX_OUTPUT_BYTES_PER_REQUEST;
        assert!(!output_budget
            .can_start_child(&GitCoordinator::new().begin_request("/tmp", None))
            .expect("output budget check"));
        assert!(output_budget
            .partial_reason
            .as_deref()
            .unwrap()
            .contains("8 MiB"));
    }

    #[test]
    fn one_thousand_alias_refs_are_deduplicated_before_child_queries() {
        let fixture = GitFixture::new();
        let quiet_tip = fixture.commit("quiet root", "root\n");
        for index in 0..30 {
            fixture.commit(&format!("busy-{index}"), &format!("busy {index}\n"));
        }
        for index in 0..1_000 {
            fixture.git(&["branch", &format!("quiet-{index:04}"), &quiet_tip]);
        }
        let page = fixture.load(None, 5);
        assert!(page.complete);
        assert!(page.unresolved_refs.is_empty());
        let cursor = page.cursor.expect("older busy history remains");
        let store = cursor_store().lock().expect("cursor store lock");
        let state = store.cursors.get(&cursor).expect("stored cursor");
        assert_eq!(state.last_request_processes, 4);
        let quiet_commit = page
            .commits
            .iter()
            .find(|commit| commit.hash == quiet_tip)
            .expect("shared quiet tip");
        assert_eq!(quiet_commit.refs.len(), 1_000);
    }

    #[test]
    fn many_distinct_quiet_tips_stop_at_the_request_process_budget_explicitly() {
        let fixture = GitFixture::new();
        let mut tip_oids = Vec::new();
        tip_oids.push(fixture.commit("root", "root\n"));
        for index in 0..99 {
            tip_oids.push(fixture.commit(&format!("quiet-{index}"), &format!("{index}\n")));
        }
        for (index, tip) in tip_oids.iter().enumerate() {
            fixture.git(&["branch", &format!("quiet-ref-{index:03}"), tip]);
        }
        let page = fixture.load(None, 1);
        assert!(!page.complete);
        assert!(!page.unresolved_refs.is_empty());
        assert!(page.has_more);
        assert!(page
            .incomplete_reason
            .as_deref()
            .unwrap()
            .contains("32 process"));
        let cursor = page.cursor.expect("partial result must remain resumable");
        let store = cursor_store().lock().expect("cursor store lock");
        let state = store.cursors.get(&cursor).expect("stored cursor");
        assert_eq!(state.last_request_processes, HISTORY_MAX_CHILD_PROCESSES);
        assert!(state.last_request_output_bytes <= HISTORY_MAX_OUTPUT_BYTES_PER_REQUEST);
    }

    #[test]
    fn equal_timestamp_order_is_stable_and_parent_before_child_never_occurs() {
        let fixture = GitFixture::new();
        let mut hashes = Vec::new();
        for index in 0..4 {
            hashes.push(fixture.commit(&format!("same-time-{index}"), &format!("{index}\n")));
            set_test_timestamp(&fixture.path, 1_700_000_000);
        }
        let page = fixture.load(None, 10);
        let positions: HashMap<_, _> = page
            .commits
            .iter()
            .enumerate()
            .map(|(index, commit)| (commit.hash.as_str(), index))
            .collect();
        for commit in &page.commits {
            for parent in &commit.parents {
                if let Some(parent_index) = positions.get(parent.as_str()) {
                    assert!(positions[commit.hash.as_str()] < *parent_index);
                }
            }
        }
        assert_eq!(hashes.len(), 4);
    }
}
