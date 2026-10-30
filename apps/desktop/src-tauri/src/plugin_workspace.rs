use cap_std::ambient_authority;
#[cfg(windows)]
use cap_std::fs::MetadataExt as PluginWindowsMetadataExt;
use cap_std::fs::{Dir, Metadata as PluginMetadata, OpenOptions};
#[cfg(unix)]
use cap_std::fs::{
    MetadataExt as PluginUnixMetadataExt, PermissionsExt as PluginUnixPermissionsExt,
};
use serde::Serialize;
#[cfg(test)]
use std::cell::Cell;
use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use tauri::State;
use uuid::Uuid;

use crate::blocking::BlockingClass;

const MAX_PLUGIN_DIRECTORY_ENTRIES: usize = 10_000;
const MAX_PLUGIN_FILE_RANGE_BYTES: usize = 128 * 1024;
const MAX_LEGACY_PLUGIN_FILE_READ_BYTES: u64 = 128 * 1024;
const MAX_PLUGIN_SNAPSHOT_CACHE_BYTES: usize = 32 * 1024 * 1024;
const MAX_PLUGIN_SNAPSHOT_CACHE_ENTRIES: usize = 2;
const MAX_PENDING_PLUGIN_FILE_READ_CANCELLATIONS: usize = 128;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PluginWorkspaceFileInfo {
    path: String,
    revision: String,
    size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PluginWorkspaceFileRange {
    path: String,
    revision: String,
    offset_bytes: usize,
    next_offset_bytes: usize,
    total_bytes: usize,
    content: String,
    eof: bool,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct PluginSnapshotKey {
    workspace: PathBuf,
    relative_path: PathBuf,
}

struct PluginWorkspaceTextSnapshot {
    revision: String,
    content: Arc<String>,
}

struct CachedPluginSnapshot {
    snapshot: Arc<PluginWorkspaceTextSnapshot>,
    last_used: u64,
}

#[derive(Default)]
struct PluginSnapshotCache {
    snapshots: HashMap<PluginSnapshotKey, CachedPluginSnapshot>,
    retained_bytes: usize,
    sequence: u64,
}

static PLUGIN_SNAPSHOT_CACHE: OnceLock<Mutex<PluginSnapshotCache>> = OnceLock::new();
static PLUGIN_SNAPSHOT_BUILD_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static PLUGIN_FILE_READ_CANCELLATIONS: OnceLock<Mutex<PluginFileReadCancellationRegistry>> =
    OnceLock::new();

#[cfg(test)]
thread_local! {
    static PLUGIN_SNAPSHOT_BUILD_COUNT: Cell<usize> = const { Cell::new(0) };
}

#[derive(Default)]
struct PluginFileReadCancellationRegistry {
    active: HashMap<String, Arc<AtomicBool>>,
    cancelled_before_start: VecDeque<String>,
}

struct PluginFileReadRegistration {
    request_id: String,
    cancelled: Arc<AtomicBool>,
}

impl Drop for PluginFileReadRegistration {
    fn drop(&mut self) {
        if let Ok(mut registry) = plugin_file_read_cancellations().lock() {
            if registry
                .active
                .get(&self.request_id)
                .is_some_and(|current| Arc::ptr_eq(current, &self.cancelled))
            {
                registry.active.remove(&self.request_id);
            }
        }
    }
}

fn plugin_file_read_cancellations() -> &'static Mutex<PluginFileReadCancellationRegistry> {
    PLUGIN_FILE_READ_CANCELLATIONS
        .get_or_init(|| Mutex::new(PluginFileReadCancellationRegistry::default()))
}

fn plugin_snapshot_cache() -> &'static Mutex<PluginSnapshotCache> {
    PLUGIN_SNAPSHOT_CACHE.get_or_init(|| Mutex::new(PluginSnapshotCache::default()))
}

fn plugin_snapshot_build_lock() -> &'static Mutex<()> {
    PLUGIN_SNAPSHOT_BUILD_LOCK.get_or_init(|| Mutex::new(()))
}

#[tauri::command]
pub(super) async fn plugin_workspace_canonicalize(workspace: String) -> Result<String, String> {
    super::run_blocking(
        "Unable to resolve workspace path",
        BlockingClass::File,
        move || {
            let (root_path, _) = open_workspace(&workspace)?;
            Ok(super::wire_path(&root_path))
        },
    )
    .await
}

#[tauri::command]
pub(super) async fn plugin_git_diff(
    workspace: String,
    path: String,
    staged: bool,
    window: tauri::WebviewWindow,
    quit_gate: State<'_, super::QuitGateState>,
    state: State<'_, super::AppState>,
) -> Result<super::DiffResult, super::GitErrorInfo> {
    let admission = quit_gate
        .admit_resource_operation(window.label())
        .map_err(|error| super::git_error_info(super::GitErrorKind::Cancelled, error))?;
    let repository_roots = Arc::clone(&state.git_repository_roots);
    let runtime = state.git_runtime.clone();
    let window_id = window.label().to_string();
    let request = runtime.begin_request(super::decode_wire_path(&workspace), Some(&window_id));
    let resource = super::git_resource_key(&workspace, &repository_roots);
    super::run_git_blocking("Unable to read plugin Git diff", resource, move || {
        let _admission = admission;
        let repository_root =
            super::cached_git_repository_root(&workspace, &repository_roots, &runtime, &request)?;
        let mut result = if staged {
            let repository_path = plugin_git_relative_path(&workspace, &path, &repository_root)
                .map_err(|message| super::git_error_info(super::GitErrorKind::Failed, message))?;
            let literal_path = format!(":(literal){repository_path}");
            super::git_diff_sync(
                workspace,
                literal_path,
                true,
                repository_roots,
                runtime,
                request,
            )?
        } else {
            plugin_git_worktree_diff_sync(&workspace, &path, &repository_root, &runtime, &request)?
        };
        result.path = path;
        Ok(result)
    })
    .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PluginWorkspaceListResult {
    entries: Vec<PluginWorkspaceEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginWorkspaceEntry {
    name: String,
    path: String,
    kind: String,
    size: Option<u64>,
    modified_at: Option<u128>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PluginWorkspaceWriteResult {
    created: bool,
    modified_at: u128,
    size: usize,
    fingerprint: String,
}

#[tauri::command]
pub(super) async fn plugin_workspace_list(
    workspace: String,
    path: String,
    window: tauri::WebviewWindow,
    quit_gate: State<'_, super::QuitGateState>,
) -> Result<PluginWorkspaceListResult, String> {
    let admission = quit_gate.admit_resource_operation(window.label())?;
    super::run_blocking("Unable to list plugin workspace files", BlockingClass::File, move || {
        let _admission = admission;
        let (_, root) = open_workspace(&workspace)?;
        let relative = validate_relative_path(&path)?;
        let directory = open_directory(&root, &relative)?;
        let mut entries = Vec::new();
        for entry in directory
            .read_dir(".")
            .map_err(|error| format!("Unable to list plugin workspace files. {error}"))?
        {
            if entries.len() >= MAX_PLUGIN_DIRECTORY_ENTRIES {
                return Err(format!("Unable to list plugin workspace files. The directory exceeds the {MAX_PLUGIN_DIRECTORY_ENTRIES} entry limit."));
            }
            let entry = entry
                .map_err(|error| format!("Unable to inspect plugin workspace entry. {error}"))?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("Unable to inspect plugin workspace entry. {error}"))?;
            let kind = if file_type.is_symlink() {
                "symlink"
            } else if file_type.is_dir() {
                "directory"
            } else if file_type.is_file() {
                "file"
            } else {
                continue;
            };
            let metadata = if kind == "symlink" {
                None
            } else {
                Some(entry.metadata().map_err(|error| {
                    format!("Unable to inspect plugin workspace entry. {error}")
                })?)
            };
            let name = entry.file_name();
            let child_path = if relative.as_os_str().is_empty() {
                PathBuf::from(&name)
            } else {
                relative.join(&name)
            };
            entries.push(PluginWorkspaceEntry {
                name: name.to_string_lossy().to_string(),
                path: display_relative_path(&child_path),
                kind: kind.to_string(),
                size: metadata.as_ref().filter(|_| kind == "file").map(|value| value.len()),
                modified_at: metadata
                    .and_then(|value| value.modified().ok())
                    .and_then(|value| super::timestamp(value.into_std())),
            });
        }
        entries.sort_by(|left, right| {
            let left_rank = if left.kind == "directory" { 0 } else { 1 };
            let right_rank = if right.kind == "directory" { 0 } else { 1 };
            (left_rank, left.name.to_lowercase()).cmp(&(right_rank, right.name.to_lowercase()))
        });
        Ok(PluginWorkspaceListResult { entries })
    })
    .await
}

#[tauri::command]
pub(super) async fn plugin_workspace_read_file<R: tauri::Runtime>(
    workspace: String,
    path: String,
    window: tauri::WebviewWindow<R>,
    quit_gate: State<'_, super::QuitGateState>,
) -> Result<super::ReadFileResult, String> {
    let admission = quit_gate.admit_resource_operation(window.label())?;
    super::run_blocking(
        "Unable to read plugin workspace file",
        BlockingClass::File,
        move || {
            let _admission = admission;
            let context = open_plugin_file_context(&workspace, &path)?;
            read_plugin_workspace_file_bounded(context)
        },
    )
    .await
}

#[tauri::command]
pub(super) async fn plugin_workspace_file_info<R: tauri::Runtime>(
    workspace: String,
    path: String,
    window: tauri::WebviewWindow<R>,
    quit_gate: State<'_, super::QuitGateState>,
) -> Result<PluginWorkspaceFileInfo, String> {
    let admission = quit_gate.admit_resource_operation(window.label())?;
    super::run_blocking(
        "Unable to inspect plugin workspace file",
        BlockingClass::File,
        move || {
            let _admission = admission;
            plugin_workspace_file_info_sync(&workspace, &path)
        },
    )
    .await
}

#[tauri::command]
pub(super) async fn plugin_workspace_read_file_range<R: tauri::Runtime>(
    workspace: String,
    path: String,
    revision: String,
    offset_bytes: usize,
    max_bytes: usize,
    request_id: Option<String>,
    window: tauri::WebviewWindow<R>,
    quit_gate: State<'_, super::QuitGateState>,
) -> Result<PluginWorkspaceFileRange, String> {
    let admission = quit_gate.admit_resource_operation(window.label())?;
    let cancellation = register_plugin_file_read(request_id.as_deref())?;
    super::run_blocking(
        "Unable to read plugin workspace file range",
        BlockingClass::File,
        move || {
            let _admission = admission;
            let _registration = cancellation;
            let cancellation = _registration
                .as_ref()
                .map(|registration| &registration.cancelled);
            plugin_workspace_read_range_sync(
                &workspace,
                &path,
                &revision,
                offset_bytes,
                max_bytes,
                cancellation.map(Arc::as_ref),
            )
        },
    )
    .await
}

#[tauri::command]
pub(super) fn cancel_plugin_workspace_file_read(request_id: String) -> Result<bool, String> {
    cancel_plugin_file_read_sync(&request_id)
}

#[tauri::command]
pub(super) fn plugin_workspace_release_file_read(
    workspace: String,
    path: String,
    revision: String,
) -> Result<(), String> {
    let root_path = fs::canonicalize(super::decode_wire_path(&workspace))
        .map_err(|error| format!("Unable to resolve plugin workspace. {error}"))?;
    let relative_path = validate_file_path(&path)?;
    let key = PluginSnapshotKey {
        workspace: root_path,
        relative_path,
    };
    remove_plugin_snapshot(&key, Some(&revision))
}

#[tauri::command]
pub(super) async fn plugin_workspace_write_file(
    workspace: String,
    path: String,
    content: String,
    expected_fingerprint: Option<String>,
    window: tauri::WebviewWindow,
    quit_gate: State<'_, super::QuitGateState>,
    state: State<'_, super::AppState>,
) -> Result<PluginWorkspaceWriteResult, String> {
    let admission = quit_gate.admit_resource_operation(window.label())?;
    let save_locks = Arc::clone(&state.save_locks);
    super::run_blocking(
        "Unable to write plugin workspace file",
        BlockingClass::File,
        move || {
            let _admission = admission;
            plugin_workspace_write_sync(workspace, path, content, expected_fingerprint, save_locks)
        },
    )
    .await
}

struct PluginWorkspaceFileContext {
    workspace_root: PathBuf,
    relative_path: PathBuf,
    parent: Dir,
    name: OsString,
    revision: String,
    size_bytes: u64,
}

fn open_plugin_file_context(
    workspace: &str,
    path: &str,
) -> Result<PluginWorkspaceFileContext, String> {
    let (workspace_root, root) = open_workspace(workspace)?;
    let relative_path = validate_file_path(path)?;
    let (parent, name) = open_parent_directory_without_reparse_links(&root, &relative_path)?;
    let metadata = parent
        .symlink_metadata(&name)
        .map_err(|error| format!("Unable to inspect plugin workspace file. {error}"))?;
    if metadata.file_type().is_symlink()
        || plugin_is_windows_reparse_point(&metadata)
        || !metadata.is_file()
    {
        return Err(
            "Unable to inspect plugin workspace file. The selected path is not a regular workspace file."
                .to_string(),
        );
    }
    let revision = plugin_path_revision(&parent, &name, &metadata)?;
    Ok(PluginWorkspaceFileContext {
        workspace_root,
        relative_path,
        parent,
        name,
        revision,
        size_bytes: metadata.len(),
    })
}

fn plugin_workspace_file_info_sync(
    workspace: &str,
    path: &str,
) -> Result<PluginWorkspaceFileInfo, String> {
    let context = open_plugin_file_context(workspace, path)?;
    Ok(PluginWorkspaceFileInfo {
        path: display_relative_path(&context.relative_path),
        revision: context.revision,
        size_bytes: context.size_bytes,
    })
}

fn open_parent_directory_without_reparse_links(
    root: &Dir,
    relative: &Path,
) -> Result<(Dir, OsString), String> {
    let parts = path_parts(relative);
    let (name, parents) = parts
        .split_last()
        .ok_or_else(|| "Plugin workspace file path must include a file name.".to_string())?;
    let mut parent = root
        .open_dir(".")
        .map_err(|error| format!("Unable to open plugin workspace directory. {error}"))?;
    for part in parents {
        let metadata = parent
            .symlink_metadata(part)
            .map_err(|error| format!("Unable to resolve plugin workspace parent. {error}"))?;
        if metadata.file_type().is_symlink() || plugin_is_windows_reparse_point(&metadata) {
            return Err(
                "Plugin workspace access does not follow symbolic links or reparse points."
                    .to_string(),
            );
        }
        if !metadata.is_dir() {
            return Err(
                "Unable to resolve plugin workspace parent. A parent component is not a directory."
                    .to_string(),
            );
        }
        parent = parent
            .open_dir(part)
            .map_err(|error| format!("Unable to open plugin workspace parent. {error}"))?;
    }
    Ok((parent, name.clone()))
}

fn plugin_path_revision(
    parent: &Dir,
    name: &OsString,
    metadata: &PluginMetadata,
) -> Result<String, String> {
    #[cfg(windows)]
    {
        use cap_std::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        let mut options = OpenOptions::new();
        options
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        let file = parent.open_with(name, &options).map_err(|error| {
            format!("Unable to inspect plugin workspace file identity. {error}")
        })?;
        let opened_metadata = file.metadata().map_err(|error| {
            format!("Unable to inspect plugin workspace file identity. {error}")
        })?;
        if plugin_is_windows_reparse_point(&opened_metadata) || !opened_metadata.is_file() {
            return Err(
                "Plugin workspace access does not follow symbolic links or reparse points."
                    .to_string(),
            );
        }
        if metadata.len() != opened_metadata.len()
            || metadata.last_write_time() != opened_metadata.last_write_time()
        {
            return Err(
                "workspace.file_changed: The plugin workspace file changed; read its file info again."
                    .to_string(),
            );
        }
        plugin_opened_file_revision(&opened_metadata, &file)
    }
    #[cfg(not(windows))]
    {
        let _ = (parent, name);
        Ok(plugin_file_revision(metadata))
    }
}

#[cfg(windows)]
fn plugin_opened_file_revision(
    metadata: &PluginMetadata,
    file: &cap_std::fs::File,
) -> Result<String, String> {
    let identity = super::windows_file_identity(file)
        .map_err(|error| format!("Unable to inspect plugin workspace file identity. {error}"))?;
    Ok(format!(
        "plugin-file-v1:{}:{}:{}:{}",
        identity.volume,
        identity.file,
        metadata.len(),
        metadata.last_write_time()
    ))
}

#[cfg(not(windows))]
fn plugin_opened_file_revision(
    metadata: &PluginMetadata,
    _file: &cap_std::fs::File,
) -> Result<String, String> {
    Ok(plugin_file_revision(metadata))
}

#[cfg(not(windows))]
fn plugin_file_revision(metadata: &PluginMetadata) -> String {
    #[cfg(unix)]
    let identity = format!("{}:{}", metadata.dev(), metadata.ino());
    #[cfg(not(any(unix, windows)))]
    let identity = String::from("metadata-only");

    #[cfg(unix)]
    let modified = format!(
        "{}:{}:{}:{}",
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec()
    );
    #[cfg(not(any(unix, windows)))]
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| format!("{}:{}", value.as_secs(), value.subsec_nanos()))
        .unwrap_or_else(|| "unknown".to_string());

    format!("plugin-file-v1:{identity}:{}:{modified}", metadata.len())
}

#[cfg(windows)]
fn plugin_is_windows_reparse_point(metadata: &PluginMetadata) -> bool {
    metadata.file_attributes() & 0x0000_0400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
}

#[cfg(not(windows))]
fn plugin_is_windows_reparse_point(_metadata: &PluginMetadata) -> bool {
    false
}

fn register_plugin_file_read(
    request_id: Option<&str>,
) -> Result<Option<PluginFileReadRegistration>, String> {
    let Some(request_id) = request_id else {
        return Ok(None);
    };
    if request_id.is_empty() || request_id.len() > 128 {
        return Err(
            "Unable to read plugin workspace file range. The request identifier is invalid."
                .to_string(),
        );
    }
    let mut registry = plugin_file_read_cancellations()
        .lock()
        .map_err(|_| "Plugin workspace file cancellation is unavailable.".to_string())?;
    if registry.active.contains_key(request_id) {
        return Err(
            "Unable to read plugin workspace file range. This request is already active."
                .to_string(),
        );
    }
    let cancelled_before_start = registry
        .cancelled_before_start
        .iter()
        .position(|pending| pending == request_id)
        .map(|index| registry.cancelled_before_start.remove(index).is_some())
        .unwrap_or(false);
    let cancelled = Arc::new(AtomicBool::new(cancelled_before_start));
    registry
        .active
        .insert(request_id.to_string(), Arc::clone(&cancelled));
    Ok(Some(PluginFileReadRegistration {
        request_id: request_id.to_string(),
        cancelled,
    }))
}

fn cancel_plugin_file_read_sync(request_id: &str) -> Result<bool, String> {
    if request_id.is_empty() || request_id.len() > 128 {
        return Err(
            "Unable to cancel plugin workspace file read. The request identifier is invalid."
                .to_string(),
        );
    }
    let mut registry = plugin_file_read_cancellations()
        .lock()
        .map_err(|_| "Plugin workspace file cancellation is unavailable.".to_string())?;
    if let Some(cancelled) = registry.active.get(request_id) {
        cancelled.store(true, Ordering::Relaxed);
        return Ok(true);
    }
    if !registry
        .cancelled_before_start
        .iter()
        .any(|pending| pending == request_id)
    {
        registry
            .cancelled_before_start
            .push_back(request_id.to_string());
        if registry.cancelled_before_start.len() > MAX_PENDING_PLUGIN_FILE_READ_CANCELLATIONS {
            registry.cancelled_before_start.pop_front();
        }
    }
    Ok(true)
}

fn check_plugin_file_read_cancellation(cancellation: Option<&AtomicBool>) -> Result<(), String> {
    if cancellation.is_some_and(|token| token.load(Ordering::Relaxed)) {
        Err("workspace.read_cancelled: Plugin workspace file read was cancelled.".to_string())
    } else {
        Ok(())
    }
}

fn validate_plugin_file_context_revision(
    context: &PluginWorkspaceFileContext,
    expected_revision: &str,
) -> Result<(), String> {
    if context.revision != expected_revision {
        return Err(
            "workspace.file_changed: The plugin workspace file changed; read its file info again."
                .to_string(),
        );
    }
    let metadata = context
        .parent
        .symlink_metadata(&context.name)
        .map_err(|error| format!("Unable to inspect plugin workspace file. {error}"))?;
    if metadata.file_type().is_symlink()
        || plugin_is_windows_reparse_point(&metadata)
        || !metadata.is_file()
        || plugin_path_revision(&context.parent, &context.name, &metadata)? != expected_revision
    {
        return Err(
            "workspace.file_changed: The plugin workspace file changed; read its file info again."
                .to_string(),
        );
    }
    Ok(())
}

fn cached_plugin_snapshot(
    key: &PluginSnapshotKey,
    revision: &str,
) -> Result<Option<Arc<PluginWorkspaceTextSnapshot>>, String> {
    let mut cache = plugin_snapshot_cache()
        .lock()
        .map_err(|_| "Plugin workspace file snapshots are unavailable.".to_string())?;
    let existing = cache
        .snapshots
        .get(key)
        .map(|entry| Arc::clone(&entry.snapshot));
    let Some(snapshot) = existing else {
        return Ok(None);
    };
    if snapshot.revision != revision {
        remove_plugin_snapshot_locked(&mut cache, key);
        return Ok(None);
    }
    cache.sequence = cache.sequence.wrapping_add(1);
    let sequence = cache.sequence;
    if let Some(entry) = cache.snapshots.get_mut(key) {
        entry.last_used = sequence;
    }
    Ok(Some(snapshot))
}

fn insert_plugin_snapshot(
    key: PluginSnapshotKey,
    snapshot: Arc<PluginWorkspaceTextSnapshot>,
) -> Result<(), String> {
    let snapshot_bytes = snapshot.content.len();
    if snapshot_bytes > MAX_PLUGIN_SNAPSHOT_CACHE_BYTES {
        return Err("Plugin workspace file snapshot exceeds the in-memory read limit.".to_string());
    }
    let mut cache = plugin_snapshot_cache()
        .lock()
        .map_err(|_| "Plugin workspace file snapshots are unavailable.".to_string())?;
    remove_plugin_snapshot_locked(&mut cache, &key);
    while cache.snapshots.len() >= MAX_PLUGIN_SNAPSHOT_CACHE_ENTRIES
        || cache.retained_bytes.saturating_add(snapshot_bytes) > MAX_PLUGIN_SNAPSHOT_CACHE_BYTES
    {
        let oldest = cache
            .snapshots
            .iter()
            .min_by_key(|(_, entry)| entry.last_used)
            .map(|(key, _)| key.clone());
        let Some(oldest) = oldest else {
            break;
        };
        remove_plugin_snapshot_locked(&mut cache, &oldest);
    }
    cache.sequence = cache.sequence.wrapping_add(1);
    let sequence = cache.sequence;
    cache.retained_bytes = cache.retained_bytes.saturating_add(snapshot_bytes);
    cache.snapshots.insert(
        key,
        CachedPluginSnapshot {
            snapshot,
            last_used: sequence,
        },
    );
    Ok(())
}

fn remove_plugin_snapshot(key: &PluginSnapshotKey, revision: Option<&str>) -> Result<(), String> {
    let mut cache = plugin_snapshot_cache()
        .lock()
        .map_err(|_| "Plugin workspace file snapshots are unavailable.".to_string())?;
    if revision.is_some_and(|revision| {
        cache
            .snapshots
            .get(key)
            .is_some_and(|entry| entry.snapshot.revision != revision)
    }) {
        return Ok(());
    }
    remove_plugin_snapshot_locked(&mut cache, key);
    Ok(())
}

fn remove_plugin_snapshot_locked(cache: &mut PluginSnapshotCache, key: &PluginSnapshotKey) {
    if let Some(entry) = cache.snapshots.remove(key) {
        cache.retained_bytes = cache
            .retained_bytes
            .saturating_sub(entry.snapshot.content.len());
    }
}

fn plugin_workspace_read_range_sync(
    workspace: &str,
    path: &str,
    revision: &str,
    offset_bytes: usize,
    max_bytes: usize,
    cancellation: Option<&AtomicBool>,
) -> Result<PluginWorkspaceFileRange, String> {
    check_plugin_file_read_cancellation(cancellation)?;
    if max_bytes == 0 || max_bytes > MAX_PLUGIN_FILE_RANGE_BYTES {
        return Err(format!(
            "workspace.invalid_range: Plugin workspace file ranges must be between 1 and {MAX_PLUGIN_FILE_RANGE_BYTES} bytes."
        ));
    }
    let context = open_plugin_file_context(workspace, path)?;
    let key = PluginSnapshotKey {
        workspace: context.workspace_root.clone(),
        relative_path: context.relative_path.clone(),
    };
    let result = (|| {
        check_plugin_file_read_cancellation(cancellation)?;
        if context.revision != revision {
            let _ = remove_plugin_snapshot(&key, Some(revision));
            return Err(
                "workspace.file_changed: The plugin workspace file changed; read its file info again."
                    .to_string(),
            );
        }
        if context.size_bytes > super::MAX_FILE_READ_BYTES {
            return Err(format!(
                "workspace.file_too_large: The plugin workspace file exceeds the {} MiB size limit.",
                super::MAX_FILE_READ_BYTES / (1024 * 1024)
            ));
        }
        validate_plugin_file_context_revision(&context, revision)?;
        let mut snapshot = cached_plugin_snapshot(&key, revision)?;
        if snapshot.is_none() {
            let _build_guard = plugin_snapshot_build_lock()
                .lock()
                .map_err(|_| "Plugin workspace file snapshots are unavailable.".to_string())?;
            snapshot = cached_plugin_snapshot(&key, revision)?;
            if snapshot.is_none() {
                check_plugin_file_read_cancellation(cancellation)?;
                let loaded = load_plugin_text_snapshot(&context, revision, cancellation)?;
                check_plugin_file_read_cancellation(cancellation)?;
                insert_plugin_snapshot(key.clone(), Arc::clone(&loaded))?;
                snapshot = Some(loaded);
            }
        }
        check_plugin_file_read_cancellation(cancellation)?;
        if let Err(error) = validate_plugin_file_context_revision(&context, revision) {
            let _ = remove_plugin_snapshot(&key, Some(revision));
            return Err(error);
        }
        let snapshot = snapshot
            .ok_or_else(|| "Plugin workspace file snapshot could not be loaded.".to_string())?;
        let content = snapshot.content.as_str();
        let total_bytes = content.len();
        if offset_bytes > total_bytes || !is_utf8_boundary(content.as_bytes(), offset_bytes) {
            return Err("workspace.invalid_range: The plugin workspace file range offset is outside the file or splits a UTF-8 character.".to_string());
        }
        let mut next_offset_bytes = offset_bytes.saturating_add(max_bytes).min(total_bytes);
        while next_offset_bytes > offset_bytes
            && next_offset_bytes < total_bytes
            && !is_utf8_boundary(content.as_bytes(), next_offset_bytes)
        {
            next_offset_bytes -= 1;
        }
        if next_offset_bytes == offset_bytes && offset_bytes < total_bytes {
            return Err("workspace.invalid_range: The requested range cannot fit the next UTF-8 character; increase maxBytes.".to_string());
        }
        let chunk = content
            .get(offset_bytes..next_offset_bytes)
            .ok_or_else(|| {
                "workspace.invalid_range: Unable to read plugin workspace file range at this UTF-8 boundary.".to_string()
            })?
            .to_string();
        let eof = next_offset_bytes == total_bytes;
        check_plugin_file_read_cancellation(cancellation)?;
        let result = PluginWorkspaceFileRange {
            path: display_relative_path(&context.relative_path),
            revision: revision.to_string(),
            offset_bytes,
            next_offset_bytes,
            total_bytes,
            content: chunk,
            eof,
        };
        if eof {
            remove_plugin_snapshot(&key, Some(revision))?;
        }
        check_plugin_file_read_cancellation(cancellation)?;
        Ok(result)
    })();
    if cancellation.is_some_and(|token| token.load(Ordering::Relaxed)) {
        let _ = remove_plugin_snapshot(&key, Some(revision));
        return Err(
            "workspace.read_cancelled: Plugin workspace file read was cancelled.".to_string(),
        );
    }
    result
}

fn is_utf8_boundary(bytes: &[u8], offset: usize) -> bool {
    offset == 0
        || offset == bytes.len()
        || bytes
            .get(offset)
            .is_some_and(|byte| byte & 0b1100_0000 != 0b1000_0000)
}

fn load_plugin_text_snapshot(
    context: &PluginWorkspaceFileContext,
    expected_revision: &str,
    cancellation: Option<&AtomicBool>,
) -> Result<Arc<PluginWorkspaceTextSnapshot>, String> {
    #[cfg(test)]
    PLUGIN_SNAPSHOT_BUILD_COUNT.with(|count| count.set(count.get().saturating_add(1)));
    check_plugin_file_read_cancellation(cancellation)?;
    validate_plugin_file_context_revision(context, expected_revision)?;
    let mut options = OpenOptions::new();
    options.read(true);
    let mut file = context
        .parent
        .open_with(&context.name, &options)
        .map_err(|error| format!("Unable to read plugin workspace file. {error}"))?;
    let opened_metadata = file
        .metadata()
        .map_err(|error| format!("Unable to inspect plugin workspace file. {error}"))?;
    if !opened_metadata.is_file()
        || plugin_opened_file_revision(&opened_metadata, &file)? != expected_revision
    {
        return Err(
            "workspace.file_changed: The plugin workspace file changed; read its file info again."
                .to_string(),
        );
    }
    if opened_metadata.len() > super::MAX_FILE_READ_BYTES {
        return Err(format!(
            "workspace.file_too_large: The plugin workspace file exceeds the {} MiB size limit.",
            super::MAX_FILE_READ_BYTES / (1024 * 1024)
        ));
    }
    check_plugin_file_read_cancellation(cancellation)?;
    let capacity = usize::try_from(opened_metadata.len()).unwrap_or(usize::MAX);
    let mut bytes = Vec::with_capacity(capacity);
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        check_plugin_file_read_cancellation(cancellation)?;
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Unable to read plugin workspace file. {error}"))?;
        if read == 0 {
            break;
        }
        check_plugin_file_read_cancellation(cancellation)?;
        if bytes.len().saturating_add(read) > super::MAX_FILE_READ_BYTES as usize {
            return Err(format!(
                "workspace.file_too_large: The plugin workspace file exceeds the {} MiB size limit.",
                super::MAX_FILE_READ_BYTES / (1024 * 1024)
            ));
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    check_plugin_file_read_cancellation(cancellation)?;
    let final_metadata = file
        .metadata()
        .map_err(|error| format!("Unable to inspect plugin workspace file. {error}"))?;
    let path_metadata = context
        .parent
        .symlink_metadata(&context.name)
        .map_err(|error| format!("Unable to inspect plugin workspace file. {error}"))?;
    if plugin_opened_file_revision(&final_metadata, &file)? != expected_revision
        || plugin_path_revision(&context.parent, &context.name, &path_metadata)?
            != expected_revision
        || final_metadata.len() != bytes.len() as u64
        || path_metadata.file_type().is_symlink()
        || plugin_is_windows_reparse_point(&path_metadata)
    {
        return Err(
            "workspace.file_changed: The plugin workspace file changed while it was being read; request it again."
                .to_string(),
        );
    }
    let (content, _, _) = super::decode_text_bytes(&bytes)
        .map_err(|error| format!("Unable to read plugin workspace file. {error}"))?;
    check_plugin_file_read_cancellation(cancellation)?;
    Ok(Arc::new(PluginWorkspaceTextSnapshot {
        revision: expected_revision.to_string(),
        content: Arc::new(content),
    }))
}

fn plugin_workspace_write_sync(
    workspace: String,
    path: String,
    content: String,
    expected_fingerprint: Option<String>,
    save_locks: Arc<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>>,
) -> Result<PluginWorkspaceWriteResult, String> {
    if content.len() as u64 > super::MAX_FILE_READ_BYTES {
        return Err(format!(
            "Unable to write plugin workspace file. The file exceeds the {} MiB size limit.",
            super::MAX_FILE_READ_BYTES / (1024 * 1024)
        ));
    }
    let (root_path, root) = open_workspace(&workspace)?;
    let relative = validate_file_path(&path)?;
    let (parent, name) = open_parent_directory(&root, &relative)?;
    let full_path = root_path.join(&relative);
    let lock = super::path_lock(&save_locks, &full_path)?;
    let _guard = lock.lock().map_err(|_| {
        "Unable to write plugin workspace file. The save lock is unavailable.".to_string()
    })?;

    let (existing, _existing_permissions) = match parent.symlink_metadata(&name) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err("Unable to write plugin workspace file. The selected path is not a regular workspace file.".to_string());
        }
        Ok(metadata) => {
            let original_permissions = Some(metadata.permissions());
            let expected = expected_fingerprint.as_deref().ok_or_else(|| "Unable to write plugin workspace file. Modifying an existing file requires its current fingerprint.".to_string())?;
            let (current, _) =
                read_file_from_directory(&parent, &name, display_relative_path(&relative))?;
            if current.fingerprint != expected {
                return Err("Unable to write plugin workspace file. The file changed on disk; read it again before writing.".to_string());
            }
            (Some(current), original_permissions)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            if expected_fingerprint.is_some() {
                return Err("Unable to write plugin workspace file. The file no longer exists; omit its fingerprint to create it again.".to_string());
            }
            (None, None)
        }
        Err(error) => {
            return Err(format!(
                "Unable to inspect plugin workspace write target. {error}"
            ))
        }
    };

    let bytes = match existing.as_ref() {
        Some(current) => super::serialize_save_content(
            &content,
            Some(&current.line_endings),
            &current.line_ending,
            current.bom,
        )?,
        None => super::serialize_save_content(&content, None, "lf", false)?,
    };
    let (temporary_path, mut temporary_file) = create_temporary_file(&parent)?;
    let write_result = (|| {
        temporary_file.write_all(&bytes)?;
        temporary_file.sync_all()?;
        #[cfg(unix)]
        if let Some(permissions) = _existing_permissions.as_ref() {
            temporary_file.set_permissions(permissions.clone())?;
            temporary_file.sync_all()?;
        }
        Ok::<(), io::Error>(())
    })();
    drop(temporary_file);
    if let Err(error) = write_result {
        let _ = parent.remove_file(&temporary_path);
        return Err(format!("Unable to stage plugin workspace file. {error}"));
    }

    match existing.as_ref() {
        Some(_) => {
            let (current, _) =
                match read_file_from_directory(&parent, &name, display_relative_path(&relative)) {
                    Ok(current) => current,
                    Err(error) => {
                        let _ = parent.remove_file(&temporary_path);
                        return Err(error);
                    }
                };
            if expected_fingerprint.as_deref() != Some(current.fingerprint.as_str()) {
                let _ = parent.remove_file(&temporary_path);
                return Err("Unable to write plugin workspace file. The file changed while the replacement was being prepared; read it again before writing.".to_string());
            }
            #[cfg(unix)]
            {
                let current_metadata = match parent.symlink_metadata(&name) {
                    Ok(metadata) => metadata,
                    Err(error) => {
                        let _ = parent.remove_file(&temporary_path);
                        return Err(format!(
                            "Unable to inspect plugin workspace write target. {error}"
                        ));
                    }
                };
                if _existing_permissions.as_ref().is_some_and(|permissions| {
                    permissions.mode() != current_metadata.permissions().mode()
                }) {
                    let _ = parent.remove_file(&temporary_path);
                    return Err("Unable to write plugin workspace file. The file metadata changed while the replacement was being prepared; read it again before writing.".to_string());
                }
            }
            if let Err(error) = parent.rename(&temporary_path, &parent, &name) {
                let _ = parent.remove_file(&temporary_path);
                return Err(format!("Unable to replace plugin workspace file. {error}"));
            }
            let _ = remove_plugin_snapshot(
                &PluginSnapshotKey {
                    workspace: root_path.clone(),
                    relative_path: relative.clone(),
                },
                None,
            );
            let (result, _) =
                read_file_from_directory(&parent, &name, display_relative_path(&relative))?;
            Ok(PluginWorkspaceWriteResult {
                created: false,
                modified_at: result.modified_at,
                size: result.size,
                fingerprint: result.fingerprint,
            })
        }
        None => {
            if let Err(error) = publish_new_file(&parent, &temporary_path, Path::new(&name)) {
                let _ = parent.remove_file(&temporary_path);
                if error.kind() == io::ErrorKind::AlreadyExists {
                    return Err("Unable to write plugin workspace file. A file appeared at the destination; read it before replacing it.".to_string());
                }
                return Err(format!("Unable to create plugin workspace file. {error}"));
            }
            let _ = remove_plugin_snapshot(
                &PluginSnapshotKey {
                    workspace: root_path.clone(),
                    relative_path: relative.clone(),
                },
                None,
            );
            let _ = parent.remove_file(&temporary_path);
            let (result, _) =
                read_file_from_directory(&parent, &name, display_relative_path(&relative))?;
            Ok(PluginWorkspaceWriteResult {
                created: true,
                modified_at: result.modified_at,
                size: result.size,
                fingerprint: result.fingerprint,
            })
        }
    }
}

fn open_workspace(workspace: &str) -> Result<(PathBuf, Dir), String> {
    let root_path = fs::canonicalize(super::decode_wire_path(workspace))
        .map_err(|error| format!("Unable to resolve plugin workspace. {error}"))?;
    if !root_path.is_dir() {
        return Err(
            "Unable to resolve plugin workspace. The current workspace is not a directory."
                .to_string(),
        );
    }
    let root = Dir::open_ambient_dir(&root_path, ambient_authority())
        .map_err(|error| format!("Unable to open plugin workspace. {error}"))?;
    Ok((root_path, root))
}

fn plugin_git_relative_path(
    workspace: &str,
    path: &str,
    repository_root: &Path,
) -> Result<String, String> {
    let (workspace_root, capability) = open_workspace(workspace)?;
    let relative_file = validate_file_path(path)?;
    let (parent, name) = open_parent_directory(&capability, &relative_file)?;
    match parent.symlink_metadata(&name) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(
                "Plugin Git diff does not follow symbolic links or read non-file paths."
                    .to_string(),
            );
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!("Unable to inspect plugin Git diff target. {error}"));
        }
    }

    let repository_root = fs::canonicalize(repository_root)
        .map_err(|error| format!("Unable to resolve Git repository root. {error}"))?;
    let workspace_from_repository = workspace_root
        .strip_prefix(&repository_root)
        .map_err(|_| "Plugin workspace is not inside the Git repository.".to_string())?;
    let repository_relative = workspace_from_repository.join(relative_file);
    if repository_relative.as_os_str().is_empty()
        || repository_relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Plugin Git diff path is not a regular path inside the workspace.".to_string());
    }
    Ok(super::wire_path(&repository_relative))
}

fn plugin_git_worktree_diff_sync(
    workspace: &str,
    plugin_path: &str,
    repository_root: &Path,
    runtime: &super::GitCoordinator,
    request: &super::RequestHandle,
) -> Result<super::DiffResult, super::GitErrorInfo> {
    let (workspace_root, capability) = open_workspace(workspace)?;
    let relative_file = validate_file_path(plugin_path)?;
    let (parent, name) = open_parent_directory(&capability, &relative_file)?;
    let worktree_bytes = read_workspace_file_bytes(&parent, &name)?;

    let repository_root = fs::canonicalize(repository_root).map_err(|error| {
        super::git_error_info(
            super::GitErrorKind::Failed,
            format!("Unable to resolve Git repository root. {error}"),
        )
    })?;
    let workspace_from_repository =
        workspace_root.strip_prefix(&repository_root).map_err(|_| {
            super::git_error_info(
                super::GitErrorKind::Failed,
                "Plugin workspace is not inside the Git repository.",
            )
        })?;
    let repository_relative = workspace_from_repository.join(&relative_file);
    if repository_relative.as_os_str().is_empty()
        || repository_relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(super::git_error_info(
            super::GitErrorKind::Failed,
            "Plugin Git diff path is not a regular path inside the workspace.",
        ));
    }

    let index_bytes = read_index_blob(&repository_root, &repository_relative, runtime, request)?;
    if index_bytes == worktree_bytes {
        return Ok(super::DiffResult {
            path: plugin_path.to_string(),
            diff: String::new(),
            staged: false,
            context_lines: 3,
            output_bytes: 0,
            truncated: false,
            next_context_lines: None,
        });
    }

    let snapshots = PluginGitDiffSnapshots::create().map_err(|error| {
        super::git_error_info(
            super::GitErrorKind::Io,
            format!("Unable to prepare a safe plugin Git diff. {error}"),
        )
    })?;
    let index_snapshot = index_bytes
        .as_deref()
        .map(|bytes| snapshots.write("a", &relative_file, bytes))
        .transpose()
        .map_err(|error| {
            super::git_error_info(
                super::GitErrorKind::Io,
                format!("Unable to prepare a safe plugin Git diff. {error}"),
            )
        })?;
    let worktree_snapshot = worktree_bytes
        .as_deref()
        .map(|bytes| snapshots.write("b", &relative_file, bytes))
        .transpose()
        .map_err(|error| {
            super::git_error_info(
                super::GitErrorKind::Io,
                format!("Unable to prepare a safe plugin Git diff. {error}"),
            )
        })?;

    super::ensure_request_active(request)?;
    let old_path = index_snapshot
        .as_deref()
        .unwrap_or_else(|| Path::new(super::null_device_path()));
    let new_path = worktree_snapshot
        .as_deref()
        .unwrap_or_else(|| Path::new(super::null_device_path()));
    let output = super::git_read_shared_raw(
        runtime,
        &repository_root,
        super::GitReadKind::Status,
        vec![
            std::ffi::OsString::from("diff"),
            std::ffi::OsString::from("--no-index"),
            std::ffi::OsString::from("--no-ext-diff"),
            std::ffi::OsString::from("--"),
            old_path.as_os_str().to_os_string(),
            new_path.as_os_str().to_os_string(),
        ],
        request,
    )?;
    if !output.success && !super::is_expected_no_index_difference_runtime(&output) {
        return Err(super::git_runtime_output_error(&output));
    }

    let relative_display = display_relative_path(&relative_file);
    let mut snapshot_paths: Vec<(&Path, &str)> = Vec::with_capacity(2);
    if let Some(path) = index_snapshot.as_deref() {
        snapshot_paths.push((path, relative_display.as_str()));
    }
    if let Some(path) = worktree_snapshot.as_deref() {
        snapshot_paths.push((path, relative_display.as_str()));
    }
    let diff = restore_plugin_paths(&String::from_utf8_lossy(&output.stdout), &snapshot_paths);
    Ok(super::DiffResult {
        path: plugin_path.to_string(),
        output_bytes: diff.len(),
        diff,
        staged: false,
        context_lines: 3,
        truncated: false,
        next_context_lines: None,
    })
}

fn read_workspace_file_bytes(
    parent: &Dir,
    name: &std::ffi::OsStr,
) -> Result<Option<Vec<u8>>, String> {
    let target = Path::new(name);
    let metadata = match parent.symlink_metadata(target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Unable to inspect plugin Git diff target. {error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(
            "Plugin Git diff does not follow symbolic links or read non-file paths.".to_string(),
        );
    }
    if metadata.len() > super::MAX_FILE_READ_BYTES {
        return Err(format!(
            "Unable to read plugin Git diff target. The file exceeds the {} MiB size limit.",
            super::MAX_FILE_READ_BYTES / (1024 * 1024)
        ));
    }

    let mut options = OpenOptions::new();
    options.read(true);
    let mut file = parent
        .open_with(target, &options)
        .map_err(|error| format!("Unable to read plugin Git diff target. {error}"))?;
    let opened_metadata = file
        .metadata()
        .map_err(|error| format!("Unable to inspect plugin Git diff target. {error}"))?;
    if !opened_metadata.is_file() || opened_metadata.len() > super::MAX_FILE_READ_BYTES {
        return Err("Plugin Git diff target changed while it was being opened.".to_string());
    }
    let limit = usize::try_from(super::MAX_FILE_READ_BYTES).unwrap_or(usize::MAX);
    let mut bytes = Vec::with_capacity(opened_metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Unable to read plugin Git diff target. {error}"))?;
    let final_metadata = file
        .metadata()
        .map_err(|error| format!("Unable to inspect plugin Git diff target. {error}"))?;
    if bytes.len() > limit
        || opened_metadata.len() != final_metadata.len()
        || opened_metadata.modified().ok() != final_metadata.modified().ok()
        || final_metadata.len() != bytes.len() as u64
    {
        return Err(
            "Plugin Git diff target changed while its contents were being checked.".to_string(),
        );
    }
    Ok(Some(bytes))
}

fn read_index_blob(
    repository_root: &Path,
    repository_relative: &Path,
    runtime: &super::GitCoordinator,
    request: &super::RequestHandle,
) -> Result<Option<Vec<u8>>, super::GitErrorInfo> {
    let mut pathspec = OsString::from(":(literal)");
    pathspec.push(repository_relative.as_os_str());
    let index_entries = super::git_read_shared_raw(
        runtime,
        repository_root,
        super::GitReadKind::Status,
        vec![
            OsString::from("ls-files"),
            OsString::from("--stage"),
            OsString::from("--error-unmatch"),
            OsString::from("-z"),
            OsString::from("--"),
            pathspec,
        ],
        request,
    )?;
    if !index_entries.success {
        if index_entries.exit_code == Some(1) && index_entries.stdout.is_empty() {
            return Ok(None);
        }
        return Err(super::git_runtime_output_error(&index_entries));
    }

    let object_id = index_entries
        .stdout
        .split(|byte| *byte == 0)
        .find_map(|entry| {
            let metadata = entry.split(|byte| *byte == b'\t').next()?;
            let mut fields = metadata
                .split(|byte| *byte == b' ')
                .filter(|field| !field.is_empty());
            let _mode = fields.next()?;
            let object_id = fields.next()?;
            let stage = fields.next()?;
            if stage != b"0"
                || object_id.is_empty()
                || !object_id.iter().all(|byte| byte.is_ascii_hexdigit())
            {
                return None;
            }
            Some(object_id.to_vec())
        });
    let Some(object_id) = object_id else {
        return Ok(None);
    };
    let blob = super::git_read_shared(
        runtime,
        repository_root,
        super::GitReadKind::Status,
        vec![
            OsString::from("cat-file"),
            OsString::from("blob"),
            OsString::from(String::from_utf8_lossy(&object_id).into_owned()),
        ],
        request,
    )?;
    Ok(Some(blob.stdout.to_vec()))
}

struct PluginGitDiffSnapshots {
    path: PathBuf,
}

impl PluginGitDiffSnapshots {
    fn create() -> io::Result<Self> {
        for _ in 0..32 {
            let path =
                std::env::temp_dir().join(format!("pude-plugin-git-diff-{}", Uuid::new_v4()));
            match fs::create_dir(&path) {
                Ok(()) => {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        if let Err(error) =
                            fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                        {
                            let _ = fs::remove_dir_all(&path);
                            return Err(error);
                        }
                    }
                    return Ok(Self { path });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "a unique temporary directory could not be created",
        ))
    }

    fn write(&self, side: &str, relative: &Path, bytes: &[u8]) -> io::Result<PathBuf> {
        let path = self.path.join(side).join(relative);
        let parent = path.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "snapshot path has no parent")
        })?;
        fs::create_dir_all(parent)?;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(path)
    }
}

fn restore_plugin_paths(diff: &str, snapshots: &[(&Path, &str)]) -> String {
    if diff.is_empty() || snapshots.is_empty() {
        return diff.to_string();
    }
    let normalized: Vec<(String, &str)> = snapshots
        .iter()
        .map(|(absolute, relative)| (absolute.to_string_lossy().replace('\\', "/"), *relative))
        .collect();
    let mut restored = String::with_capacity(diff.len());
    let mut in_header = true;
    for line in diff.split_inclusive('\n') {
        let (body, ending) = match line.strip_suffix('\n') {
            Some(body) => (body, "\n"),
            None => (line, ""),
        };
        let (body, carriage) = match body.strip_suffix('\r') {
            Some(body) => (body, "\r"),
            None => (body, ""),
        };
        let (rewritten, stays_in_header) = rewrite_diff_header_line(body, &normalized, in_header);
        in_header = stays_in_header;
        restored.push_str(&rewritten);
        restored.push_str(carriage);
        restored.push_str(ending);
    }
    restored
}

fn rewrite_diff_header_line(
    line: &str,
    snapshots: &[(String, &str)],
    in_header: bool,
) -> (String, bool) {
    if let Some(rest) = line.strip_prefix("diff --git ") {
        let rewritten = match rewrite_git_path_pair(rest, snapshots) {
            Some(pair) => format!("diff --git {pair}"),
            None => line.to_string(),
        };
        return (rewritten, true);
    }
    if !in_header {
        return (line.to_string(), false);
    }
    if let Some(rest) = line.strip_prefix("--- ") {
        let rewritten = rewrite_extended_header_path(rest, snapshots);
        return (format!("--- {rewritten}"), true);
    }
    if let Some(rest) = line.strip_prefix("+++ ") {
        let rewritten = rewrite_extended_header_path(rest, snapshots);
        return (format!("+++ {rewritten}"), true);
    }
    if let Some(rest) = line.strip_prefix("Binary files ") {
        let rewritten = match rewrite_binary_file_pair(rest, snapshots) {
            Some(pair) => format!("Binary files {pair}"),
            None => line.to_string(),
        };
        return (rewritten, true);
    }
    if is_diff_extended_header(line) {
        return (line.to_string(), true);
    }
    (line.to_string(), false)
}

fn is_diff_extended_header(line: &str) -> bool {
    [
        "index ",
        "new file mode ",
        "deleted file mode ",
        "old mode ",
        "new mode ",
        "similarity index ",
        "dissimilarity index ",
        "rename from ",
        "rename to ",
        "copy from ",
        "copy to ",
    ]
    .iter()
    .any(|prefix| line.starts_with(prefix))
}

fn rewrite_git_path_pair(rest: &str, snapshots: &[(String, &str)]) -> Option<String> {
    let (used_first, first_token) = parse_git_path_token(rest)?;
    let after_first = rest[used_first..].strip_prefix(' ')?;
    let (used_second, second_token) = parse_git_path_token(after_first)?;
    if !after_first[used_second..].is_empty() {
        return None;
    }
    let first = restore_snapshot_token(&first_token, snapshots)?;
    let second = restore_snapshot_token(&second_token, snapshots)?;
    Some(format!("{first} {second}"))
}

fn rewrite_extended_header_path(rest: &str, snapshots: &[(String, &str)]) -> String {
    let Some((used, token)) = parse_git_path_token(rest) else {
        return rest.to_string();
    };
    let Some(restored) = restore_snapshot_token(&token, snapshots) else {
        return rest.to_string();
    };
    format!("{restored}{}", &rest[used..])
}

fn rewrite_binary_file_pair(rest: &str, snapshots: &[(String, &str)]) -> Option<String> {
    let (used_first, first_token) = parse_git_path_token(rest)?;
    let after_first = rest[used_first..].strip_prefix(" and ")?;
    let (used_second, second_token) = parse_git_path_token(after_first)?;
    if &after_first[used_second..] != " differ" {
        return None;
    }
    let first = restore_snapshot_token(&first_token, snapshots)?;
    let second = restore_snapshot_token(&second_token, snapshots)?;
    Some(format!("{first} and {second} differ"))
}

fn find_snapshot_path<'a>(normalized: &str, snapshots: &[(String, &'a str)]) -> Option<&'a str> {
    snapshots
        .iter()
        .find(|(absolute, _)| {
            absolute.as_str() == normalized
                // `git diff --no-index` removes the leading slash from
                // absolute paths before adding its `a/` and `b/` prefixes.
                // Match that Git form while still requiring the full exact
                // snapshot path, so similarly named paths cannot collide.
                || absolute
                    .strip_prefix('/')
                    .is_some_and(|without_root| without_root == normalized)
        })
        .map(|(_, relative)| *relative)
}

fn restore_snapshot_token(token: &str, snapshots: &[(String, &str)]) -> Option<String> {
    let normalized = token.replace('\\', "/");
    if let Some(relative) = find_snapshot_path(&normalized, snapshots) {
        return Some(quote_git_path(relative));
    }
    for side in ["a", "b"] {
        if let Some(rest) = normalized.strip_prefix(&format!("{side}/")) {
            if let Some(relative) = find_snapshot_path(rest, snapshots) {
                return Some(quote_git_path(&format!("{side}/{relative}")));
            }
        }
    }
    None
}

fn parse_git_path_token(text: &str) -> Option<(usize, String)> {
    if text.starts_with('"') {
        let bytes = text.as_bytes();
        let mut index = 1;
        let mut decoded = Vec::new();
        while index < bytes.len() {
            match bytes[index] {
                b'"' => {
                    return Some((index + 1, String::from_utf8_lossy(&decoded).into_owned()));
                }
                b'\\' => {
                    index += 1;
                    let escaped = *bytes.get(index)?;
                    match escaped {
                        b'a' => decoded.push(0x07),
                        b'b' => decoded.push(0x08),
                        b't' => decoded.push(b'\t'),
                        b'n' => decoded.push(b'\n'),
                        b'v' => decoded.push(0x0b),
                        b'f' => decoded.push(0x0c),
                        b'r' => decoded.push(b'\r'),
                        b'\\' => decoded.push(b'\\'),
                        b'"' => decoded.push(b'"'),
                        byte @ b'0'..=b'7' => {
                            let mut value = (byte - b'0') as u32;
                            for _ in 0..2 {
                                match bytes.get(index + 1) {
                                    Some(next @ b'0'..=b'7') => {
                                        value = value * 8 + (next - b'0') as u32;
                                        index += 1;
                                    }
                                    _ => break,
                                }
                            }
                            decoded.push(value as u8);
                        }
                        _ => return None,
                    }
                    index += 1;
                }
                byte => {
                    decoded.push(byte);
                    index += 1;
                }
            }
        }
        return None;
    }
    let end = text.find([' ', '\t']).unwrap_or(text.len());
    Some((end, text[..end].to_string()))
}

fn quote_git_path(path: &str) -> String {
    let needs_quoting = path
        .bytes()
        .any(|byte| byte <= b' ' || byte == b'"' || byte == b'\\' || byte == 0x7f);
    if !needs_quoting {
        return path.to_string();
    }
    let mut quoted: Vec<u8> = Vec::with_capacity(path.len() + 2);
    quoted.push(b'"');
    for byte in path.bytes() {
        match byte {
            0x07 => quoted.extend_from_slice(b"\\a"),
            0x08 => quoted.extend_from_slice(b"\\b"),
            b'\t' => quoted.extend_from_slice(b"\\t"),
            b'\n' => quoted.extend_from_slice(b"\\n"),
            0x0b => quoted.extend_from_slice(b"\\v"),
            b'\x0c' => quoted.extend_from_slice(b"\\f"),
            b'\r' => quoted.extend_from_slice(b"\\r"),
            b'\\' => quoted.extend_from_slice(b"\\\\"),
            b'"' => quoted.extend_from_slice(b"\\\""),
            byte if byte < b' ' || byte == 0x7f => {
                quoted.extend_from_slice(format!("\\{byte:03o}").as_bytes());
            }
            byte => quoted.push(byte),
        }
    }
    quoted.push(b'"');
    String::from_utf8_lossy(&quoted).into_owned()
}

impl Drop for PluginGitDiffSnapshots {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn open_directory(root: &Dir, relative: &Path) -> Result<Dir, String> {
    let mut directory = root
        .open_dir(".")
        .map_err(|error| format!("Unable to open plugin workspace directory. {error}"))?;
    for part in path_parts(relative) {
        let metadata = directory
            .symlink_metadata(&part)
            .map_err(|error| format!("Unable to resolve plugin workspace directory. {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("Plugin workspace access does not follow symbolic links.".to_string());
        }
        if !metadata.is_dir() {
            return Err("Unable to resolve plugin workspace directory. The selected path is not a directory.".to_string());
        }
        directory = directory
            .open_dir(&part)
            .map_err(|error| format!("Unable to open plugin workspace directory. {error}"))?;
    }
    Ok(directory)
}

fn open_parent_directory(root: &Dir, relative: &Path) -> Result<(Dir, OsString), String> {
    let parts = path_parts(relative);
    let (name, parents) = parts
        .split_last()
        .ok_or_else(|| "Plugin workspace file path must include a file name.".to_string())?;
    let mut parent = root
        .open_dir(".")
        .map_err(|error| format!("Unable to open plugin workspace directory. {error}"))?;
    for part in parents {
        let metadata = parent
            .symlink_metadata(part)
            .map_err(|error| format!("Unable to resolve plugin workspace parent. {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("Plugin workspace access does not follow symbolic links.".to_string());
        }
        if !metadata.is_dir() {
            return Err(
                "Unable to resolve plugin workspace parent. A parent component is not a directory."
                    .to_string(),
            );
        }
        parent = parent
            .open_dir(part)
            .map_err(|error| format!("Unable to open plugin workspace parent. {error}"))?;
    }
    Ok((parent, name.clone()))
}

fn read_file_from_directory(
    parent: &Dir,
    name: &std::ffi::OsStr,
    relative_path: String,
) -> Result<(super::ReadFileResult, Vec<u8>), String> {
    let target = Path::new(name);
    let path_metadata = parent
        .symlink_metadata(target)
        .map_err(|error| format!("Unable to read plugin workspace file. {error}"))?;
    if path_metadata.file_type().is_symlink() || !path_metadata.is_file() {
        return Err("Unable to read plugin workspace file. The selected path is not a regular workspace file.".to_string());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    let mut file = parent
        .open_with(target, &options)
        .map_err(|error| format!("Unable to read plugin workspace file. {error}"))?;
    let opened_metadata = file
        .metadata()
        .map_err(|error| format!("Unable to inspect plugin workspace file. {error}"))?;
    if !opened_metadata.is_file() {
        return Err("Unable to read plugin workspace file. The selected path is not a regular workspace file.".to_string());
    }
    if opened_metadata.len() > super::MAX_FILE_READ_BYTES {
        return Err(format!(
            "Unable to read plugin workspace file. The file exceeds the {} MiB size limit.",
            super::MAX_FILE_READ_BYTES / (1024 * 1024)
        ));
    }
    let limit = usize::try_from(super::MAX_FILE_READ_BYTES).unwrap_or(usize::MAX);
    let mut bytes = Vec::with_capacity(opened_metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Unable to read plugin workspace file. {error}"))?;
    if bytes.len() > limit {
        return Err(format!(
            "Unable to read plugin workspace file. The file exceeds the {} MiB size limit.",
            super::MAX_FILE_READ_BYTES / (1024 * 1024)
        ));
    }
    let final_metadata = file
        .metadata()
        .map_err(|error| format!("Unable to inspect plugin workspace file. {error}"))?;
    if opened_metadata.len() != final_metadata.len()
        || opened_metadata.modified().ok() != final_metadata.modified().ok()
        || final_metadata.len() != bytes.len() as u64
    {
        return Err("Unable to read plugin workspace file. It changed while its contents were being checked; read it again.".to_string());
    }
    let fingerprint = super::content_fingerprint(&bytes);
    let (content, line_endings, bom) = super::decode_text_bytes(&bytes)?;
    let line_ending = super::preferred_line_ending(&line_endings).to_string();
    let modified_at = final_metadata
        .modified()
        .ok()
        .and_then(|value| super::timestamp(value.into_std()))
        .unwrap_or_default();
    Ok((
        super::ReadFileResult {
            path: relative_path,
            content,
            encoding: if bom { "utf-8-bom" } else { "utf-8" }.to_string(),
            line_ending,
            line_endings,
            bom,
            modified_at,
            size: bytes.len(),
            fingerprint,
            identity: None,
        },
        bytes,
    ))
}

fn publish_new_file(parent: &Dir, temporary_path: &Path, name: &Path) -> io::Result<()> {
    publish_new_file_with(
        parent,
        temporary_path,
        name,
        |parent, temporary_path, name| parent.hard_link(temporary_path, parent, name),
    )
}

fn publish_new_file_with(
    parent: &Dir,
    temporary_path: &Path,
    name: &Path,
    link: impl FnOnce(&Dir, &Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    match link(parent, temporary_path, name) {
        Err(error) if super::hard_links_unsupported(&error) => {
            copy_into_new_file(parent, temporary_path, name)
        }
        result => result,
    }
}

fn copy_into_new_file(parent: &Dir, source: &Path, destination: &Path) -> io::Result<()> {
    let mut source = parent.open(source)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    let mut new_file = parent.open_with(destination, &options)?;
    let copied = io::copy(&mut source, &mut new_file).and_then(|_| new_file.sync_all());
    if copied.is_err() {
        let _ = parent.remove_file(destination);
    }
    copied
}

fn create_temporary_file(parent: &Dir) -> Result<(PathBuf, cap_std::fs::File), String> {
    for _ in 0..16 {
        let path = PathBuf::from(format!(".pude-tmp-{}.tmp", Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        match parent.open_with(&path, &options) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Unable to stage plugin workspace file. {error}")),
        }
    }
    Err(
        "Unable to stage plugin workspace file. A unique temporary file could not be created."
            .to_string(),
    )
}

fn validate_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    if relative_path.len() > 4096
        || relative_path.contains('\0')
        || relative_path.contains('\\')
        || relative_path.as_bytes().get(1) == Some(&b':')
        || relative_path.starts_with('/')
        || relative_path.starts_with('~')
        || Path::new(relative_path).is_absolute()
    {
        return Err(
            "Plugin workspace paths must be relative paths inside the current workspace."
                .to_string(),
        );
    }
    for component in Path::new(relative_path).components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            _ => {
                return Err(
                    "Plugin workspace paths must be relative paths without parent traversal."
                        .to_string(),
                )
            }
        }
    }
    Ok(PathBuf::from(relative_path))
}

fn validate_file_path(path: &str) -> Result<PathBuf, String> {
    let relative = validate_relative_path(path)?;
    if path_parts(&relative).is_empty() || path.ends_with('/') {
        return Err("Plugin workspace file path must include a file name.".to_string());
    }
    Ok(relative)
}

fn path_parts(path: &Path) -> Vec<OsString> {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_os_string()),
            _ => None,
        })
        .collect()
}

fn display_relative_path(path: &Path) -> String {
    path_parts(path)
        .iter()
        .map(|part| part.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn read_plugin_workspace_file_bounded(
    context: PluginWorkspaceFileContext,
) -> Result<super::ReadFileResult, String> {
    if context.size_bytes > MAX_LEGACY_PLUGIN_FILE_READ_BYTES {
        return Err(format!(
            "workspace.file_requires_ranges: This file exceeds the {} KiB single-response limit; use workspace.readFileRange.",
            MAX_LEGACY_PLUGIN_FILE_READ_BYTES / 1024
        ));
    }
    validate_plugin_file_context_revision(&context, &context.revision)?;
    let mut options = OpenOptions::new();
    options.read(true);
    let mut file = context
        .parent
        .open_with(&context.name, &options)
        .map_err(|error| format!("Unable to read plugin workspace file. {error}"))?;
    let opened_metadata = file
        .metadata()
        .map_err(|error| format!("Unable to inspect plugin workspace file. {error}"))?;
    if !opened_metadata.is_file()
        || plugin_opened_file_revision(&opened_metadata, &file)? != context.revision
    {
        return Err(
            "workspace.file_changed: The plugin workspace file changed; read its file info again."
                .to_string(),
        );
    }
    if opened_metadata.len() > MAX_LEGACY_PLUGIN_FILE_READ_BYTES {
        return Err(format!(
            "workspace.file_requires_ranges: This file exceeds the {} KiB single-response limit; use workspace.readFileRange.",
            MAX_LEGACY_PLUGIN_FILE_READ_BYTES / 1024
        ));
    }
    let limit = usize::try_from(MAX_LEGACY_PLUGIN_FILE_READ_BYTES).unwrap_or(usize::MAX);
    let mut bytes = Vec::with_capacity(opened_metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Unable to read plugin workspace file. {error}"))?;
    if bytes.len() > limit {
        return Err(format!(
            "workspace.file_requires_ranges: This file exceeds the {} KiB single-response limit; use workspace.readFileRange.",
            MAX_LEGACY_PLUGIN_FILE_READ_BYTES / 1024
        ));
    }
    let final_metadata = file
        .metadata()
        .map_err(|error| format!("Unable to inspect plugin workspace file. {error}"))?;
    let path_metadata = context
        .parent
        .symlink_metadata(&context.name)
        .map_err(|error| format!("Unable to inspect plugin workspace file. {error}"))?;
    if plugin_opened_file_revision(&final_metadata, &file)? != context.revision
        || plugin_path_revision(&context.parent, &context.name, &path_metadata)? != context.revision
        || path_metadata.file_type().is_symlink()
        || plugin_is_windows_reparse_point(&path_metadata)
        || final_metadata.len() != bytes.len() as u64
    {
        return Err(
            "workspace.file_changed: The plugin workspace file changed while it was being read; read it again."
                .to_string(),
        );
    }
    let fingerprint = super::content_fingerprint(&bytes);
    let (content, line_endings, bom) = super::decode_text_bytes(&bytes)?;
    let line_ending = super::preferred_line_ending(&line_endings).to_string();
    let modified_at = final_metadata
        .modified()
        .ok()
        .and_then(|value| super::timestamp(value.into_std()))
        .unwrap_or_default();
    Ok(super::ReadFileResult {
        path: display_relative_path(&context.relative_path),
        content,
        encoding: if bom { "utf-8-bom" } else { "utf-8" }.to_string(),
        line_ending,
        line_endings,
        bom,
        modified_at,
        size: bytes.len(),
        fingerprint,
        identity: None,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        cached_plugin_snapshot, cancel_plugin_file_read_sync, open_plugin_file_context,
        plugin_git_relative_path, plugin_git_worktree_diff_sync, plugin_workspace_file_info_sync,
        plugin_workspace_read_range_sync, plugin_workspace_release_file_read,
        plugin_workspace_write_sync, read_plugin_workspace_file_bounded, register_plugin_file_read,
        restore_plugin_paths, validate_file_path, validate_relative_path, PluginGitDiffSnapshots,
        PluginSnapshotKey,
    };
    #[cfg(unix)]
    use super::{
        create_temporary_file, open_parent_directory, open_workspace, publish_new_file_with,
        read_workspace_file_bytes,
    };
    #[cfg(unix)]
    use cap_std::fs::Dir;
    use std::cell::Cell;
    use std::collections::HashMap;
    use std::fs;
    #[cfg(unix)]
    use std::io;
    #[cfg(unix)]
    use std::io::Write;
    #[cfg(unix)]
    use std::path::Path;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::{Arc, Mutex, OnceLock, Weak};
    use uuid::Uuid;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[cfg(unix)]
    static UMASK_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    #[cfg(unix)]
    struct UmaskGuard(libc::mode_t);

    #[cfg(unix)]
    impl UmaskGuard {
        fn set(mask: libc::mode_t) -> Self {
            Self(unsafe { libc::umask(mask) })
        }
    }

    #[cfg(unix)]
    impl Drop for UmaskGuard {
        fn drop(&mut self) {
            unsafe { libc::umask(self.0) };
        }
    }

    fn temporary_directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!("pude-plugin-workspace-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn rejects_absolute_parent_and_platform_separator_paths() {
        assert!(validate_relative_path("../secret").is_err());
        assert!(validate_relative_path("/secret").is_err());
        assert!(validate_relative_path("C:/secret").is_err());
        assert!(validate_relative_path("C:secret").is_err());
        assert!(validate_relative_path("src\\secret").is_err());
        assert!(validate_file_path("src/").is_err());
        assert_eq!(
            validate_relative_path("src/main.rs").unwrap(),
            PathBuf::from("src/main.rs")
        );
    }

    #[test]
    fn maps_plugin_diff_paths_from_nested_workspace_to_repository_relative_paths() {
        let repository = temporary_directory();
        let workspace = repository.join("packages/example");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(repository.join("secret.txt"), "repository root secret").unwrap();
        fs::write(workspace.join("secret.txt"), "workspace file").unwrap();

        let mapped =
            plugin_git_relative_path(&workspace.to_string_lossy(), "secret.txt", &repository)
                .unwrap();

        assert_eq!(
            super::super::decode_wire_path(&mapped),
            PathBuf::from("packages/example/secret.txt")
        );
        assert_ne!(
            super::super::decode_wire_path(&mapped),
            PathBuf::from("secret.txt")
        );
        let _ = fs::remove_dir_all(repository);
    }

    #[test]
    fn worktree_diff_uses_workspace_file_snapshot_not_a_same_named_repository_file() {
        let repository = temporary_directory();
        let workspace = repository.join("packages/example");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(repository.join("secret.txt"), "repository root secret\n").unwrap();
        fs::write(workspace.join("secret.txt"), "indexed workspace text\n").unwrap();

        let init = Command::new("git")
            .arg("init")
            .current_dir(&repository)
            .output();
        if init.is_err() {
            let _ = fs::remove_dir_all(repository);
            return;
        }
        assert!(init.unwrap().status.success());
        assert!(Command::new("git")
            .args(["add", "--", "."])
            .current_dir(&repository)
            .status()
            .unwrap()
            .success());
        fs::write(workspace.join("secret.txt"), "changed workspace text\n").unwrap();

        let runtime = super::super::GitCoordinator::new();
        let request = runtime.begin_request(&repository, Some("plugin-diff-test"));
        let result = plugin_git_worktree_diff_sync(
            &workspace.to_string_lossy(),
            "secret.txt",
            &repository,
            &runtime,
            &request,
        )
        .unwrap();

        assert_eq!(result.path, "secret.txt");
        assert!(result.diff.contains("-indexed workspace text"));
        assert!(result.diff.contains("+changed workspace text"));
        assert!(!result.diff.contains("repository root secret"));
        assert!(result.diff.contains("diff --git a/secret.txt b/secret.txt"));
        let _ = fs::remove_dir_all(repository);
    }

    #[test]
    fn untracked_plugin_diff_compares_a_safe_snapshot_with_an_empty_file() {
        let repository = temporary_directory();
        let workspace = repository.join("packages/example");
        fs::create_dir_all(&workspace).unwrap();
        let init = Command::new("git")
            .arg("init")
            .current_dir(&repository)
            .output();
        if init.is_err() {
            let _ = fs::remove_dir_all(repository);
            return;
        }
        assert!(init.unwrap().status.success());
        fs::write(workspace.join("new.txt"), "safe new file\n").unwrap();

        let runtime = super::super::GitCoordinator::new();
        let request = runtime.begin_request(&repository, Some("plugin-untracked-diff-test"));
        let result = plugin_git_worktree_diff_sync(
            &workspace.to_string_lossy(),
            "new.txt",
            &repository,
            &runtime,
            &request,
        )
        .unwrap();

        assert!(result.diff.contains("new file mode"));
        assert!(result.diff.contains("+++ b/new.txt"));
        assert!(result.diff.contains("+safe new file"));
        assert!(!result.diff.contains("pude-plugin-git-diff-"));
        let _ = fs::remove_dir_all(repository);
    }

    #[cfg(unix)]
    #[test]
    fn safe_diff_snapshot_is_read_from_a_pinned_workspace_parent_after_symlink_swap() {
        let root = temporary_directory();
        let outside = temporary_directory();
        fs::create_dir(root.join("workspace")).unwrap();
        fs::write(root.join("workspace/note.txt"), "inside snapshot").unwrap();
        fs::write(outside.join("note.txt"), "outside secret").unwrap();
        let (_, capability) = open_workspace(&root.to_string_lossy()).unwrap();
        let (parent, name) =
            open_parent_directory(&capability, &PathBuf::from("workspace/note.txt")).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            fs::rename(root.join("workspace"), root.join("held-workspace")).unwrap();
            symlink(&outside, root.join("workspace")).unwrap();
        }

        let snapshot = read_workspace_file_bytes(&parent, &name).unwrap().unwrap();
        assert_eq!(snapshot, b"inside snapshot");
        assert_ne!(snapshot, b"outside secret");
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn rewrites_temporary_diff_file_names_to_the_plugin_relative_path() {
        let snapshots = PluginGitDiffSnapshots::create().unwrap();
        let root = snapshots.path.to_string_lossy().replace('\\', "/");
        let old_snapshot = snapshots.path.join("a/src/secret.txt");
        let new_snapshot = snapshots.path.join("b/src/secret.txt");
        let raw = format!(
            "diff --git a/{root}/a/src/secret.txt b/{root}/b/src/secret.txt\n--- a/{root}/a/src/secret.txt\n+++ b/{root}/b/src/secret.txt\n"
        );
        let restored = restore_plugin_paths(
            &raw,
            &[
                (old_snapshot.as_path(), "src/secret.txt"),
                (new_snapshot.as_path(), "src/secret.txt"),
            ],
        );
        assert_eq!(
            restored,
            "diff --git a/src/secret.txt b/src/secret.txt\n--- a/src/secret.txt\n+++ b/src/secret.txt\n"
        );
        drop(snapshots);
    }

    #[cfg(unix)]
    #[test]
    fn restores_git_no_index_paths_after_it_strips_the_unix_root_slash() {
        let snapshots = PluginGitDiffSnapshots::create().unwrap();
        let old_snapshot = snapshots.path.join("a/src/note.txt");
        let new_snapshot = snapshots.path.join("b/src/note.txt");
        let old_git_path = old_snapshot
            .strip_prefix("/")
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let new_git_path = new_snapshot
            .strip_prefix("/")
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let raw = format!(
            "diff --git a/{old_git_path} b/{new_git_path}\n--- a/{old_git_path}\n+++ b/{new_git_path}\n"
        );

        let restored = restore_plugin_paths(
            &raw,
            &[
                (old_snapshot.as_path(), "src/note.txt"),
                (new_snapshot.as_path(), "src/note.txt"),
            ],
        );

        assert_eq!(
            restored,
            "diff --git a/src/note.txt b/src/note.txt\n--- a/src/note.txt\n+++ b/src/note.txt\n"
        );
        assert!(!restored.contains(&snapshots.path.to_string_lossy().to_string()));
        drop(snapshots);
    }

    fn git_quote(path: &str) -> String {
        let mut quoted = String::from("\"");
        for byte in path.bytes() {
            match byte {
                b'\\' => quoted.push_str("\\\\"),
                b'"' => quoted.push_str("\\\""),
                0x20..=0x7e => quoted.push(byte as char),
                _ => quoted.push_str(&format!("\\{byte:03o}")),
            }
        }
        quoted.push('"');
        quoted
    }

    fn backslash_path(path: &str) -> String {
        path.replace('/', "\\")
    }

    #[test]
    fn restores_quoted_windows_paths_in_diff_headers() {
        let snapshots = PluginGitDiffSnapshots::create().unwrap();
        let root = snapshots.path.to_string_lossy().replace('\\', "/");
        let windows_root = backslash_path(&root);
        let old_snapshot = snapshots.path.join("a/src/secret.txt");
        let new_snapshot = snapshots.path.join("b/src/secret.txt");
        let old_token = git_quote(&format!("a/{windows_root}\\a\\src\\secret.txt"));
        let new_token = git_quote(&format!("b/{windows_root}\\b\\src\\secret.txt"));
        let raw = format!(
            "diff --git {old_token} {new_token}\n--- {old_token}\t2024-01-01 00:00:00 +0000\n+++ {new_token}\t2024-01-01 00:00:00 +0000\n"
        );
        let restored = restore_plugin_paths(
            &raw,
            &[
                (old_snapshot.as_path(), "src/secret.txt"),
                (new_snapshot.as_path(), "src/secret.txt"),
            ],
        );
        assert_eq!(
            restored,
            "diff --git a/src/secret.txt b/src/secret.txt\n--- a/src/secret.txt\t2024-01-01 00:00:00 +0000\n+++ b/src/secret.txt\t2024-01-01 00:00:00 +0000\n"
        );
        assert!(!restored.contains(&root));
        drop(snapshots);
    }

    #[test]
    fn restores_octal_escaped_non_ascii_paths() {
        let snapshots = PluginGitDiffSnapshots::create().unwrap();
        let root = snapshots.path.to_string_lossy().replace('\\', "/");
        let relative = "src/中文 檔案.txt";
        let old_snapshot = snapshots.path.join("a").join(relative);
        let new_snapshot = snapshots.path.join("b").join(relative);
        let old_token = git_quote(&format!("a/{root}/a/{relative}"));
        let new_token = git_quote(&format!("b/{root}/b/{relative}"));
        let raw = format!("diff --git {old_token} {new_token}\n--- {old_token}\n+++ {new_token}\n");
        let restored = restore_plugin_paths(
            &raw,
            &[
                (old_snapshot.as_path(), relative),
                (new_snapshot.as_path(), relative),
            ],
        );
        let expected = "diff --git \"a/src/中文 檔案.txt\" \"b/src/中文 檔案.txt\"\n--- \"a/src/中文 檔案.txt\"\n+++ \"b/src/中文 檔案.txt\"\n";
        assert_eq!(restored, expected);
        drop(snapshots);
    }

    #[test]
    fn restores_paths_with_spaces_and_embedded_quotes() {
        let snapshots = PluginGitDiffSnapshots::create().unwrap();
        let root = snapshots.path.to_string_lossy().replace('\\', "/");
        let relative = "dir with space/say \"hi\".txt";
        let old_snapshot = snapshots.path.join("a").join(relative);
        let new_snapshot = snapshots.path.join("b").join(relative);
        let old_token = git_quote(&format!("a/{root}/a/{relative}"));
        let new_token = git_quote(&format!("b/{root}/b/{relative}"));
        let raw = format!("diff --git {old_token} {new_token}\n--- {old_token}\n+++ {new_token}\n");
        let restored = restore_plugin_paths(
            &raw,
            &[
                (old_snapshot.as_path(), relative),
                (new_snapshot.as_path(), relative),
            ],
        );
        assert_eq!(
            restored,
            "diff --git \"a/dir with space/say \\\"hi\\\".txt\" \"b/dir with space/say \\\"hi\\\".txt\"\n--- \"a/dir with space/say \\\"hi\\\".txt\"\n+++ \"b/dir with space/say \\\"hi\\\".txt\"\n"
        );
        drop(snapshots);
    }

    #[test]
    fn keeps_dev_null_semantics_for_added_and_deleted_files() {
        let snapshots = PluginGitDiffSnapshots::create().unwrap();
        let root = snapshots.path.to_string_lossy().replace('\\', "/");
        let added_snapshot = snapshots.path.join("b/added.txt");
        let deleted_snapshot = snapshots.path.join("a/deleted.txt");
        let raw = format!(
            "diff --git a/{root}/b/added.txt b/{root}/b/added.txt\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/{root}/b/added.txt\n@@ -0,0 +1 @@\n+added\n"
        ) + &format!(
            "diff --git a/{root}/a/deleted.txt b/{root}/a/deleted.txt\ndeleted file mode 100644\nindex 2222222..0000000\n--- a/{root}/a/deleted.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-deleted\n"
        );
        let restored = restore_plugin_paths(
            &raw,
            &[
                (added_snapshot.as_path(), "added.txt"),
                (deleted_snapshot.as_path(), "deleted.txt"),
            ],
        );
        assert_eq!(
            restored,
            "diff --git a/added.txt b/added.txt\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/added.txt\n@@ -0,0 +1 @@\n+added\n"
                .to_string()
                + "diff --git a/deleted.txt b/deleted.txt\ndeleted file mode 100644\nindex 2222222..0000000\n--- a/deleted.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-deleted\n"
        );
        drop(snapshots);
    }

    #[test]
    fn restores_binary_files_header_paths() {
        let snapshots = PluginGitDiffSnapshots::create().unwrap();
        let root = snapshots.path.to_string_lossy().replace('\\', "/");
        let windows_root = backslash_path(&root);
        let old_snapshot = snapshots.path.join("a/logo.bin");
        let new_snapshot = snapshots.path.join("b/logo.bin");
        let old_token = git_quote(&format!("a/{windows_root}\\a\\logo.bin"));
        let new_token = git_quote(&format!("b/{windows_root}\\b\\logo.bin"));
        let raw = format!("Binary files {old_token} and {new_token} differ\n");
        let restored = restore_plugin_paths(
            &raw,
            &[
                (old_snapshot.as_path(), "logo.bin"),
                (new_snapshot.as_path(), "logo.bin"),
            ],
        );
        assert_eq!(restored, "Binary files a/logo.bin and b/logo.bin differ\n");
        drop(snapshots);
    }

    #[test]
    fn leaves_diff_body_lines_that_resemble_headers_untouched() {
        let snapshots = PluginGitDiffSnapshots::create().unwrap();
        let root = snapshots.path.to_string_lossy().replace('\\', "/");
        let old_snapshot = snapshots.path.join("a/note.txt");
        let new_snapshot = snapshots.path.join("b/note.txt");
        let raw = format!(
            "diff --git a/{root}/a/note.txt b/{root}/b/note.txt\n--- a/{root}/a/note.txt\n+++ b/{root}/b/note.txt\n@@ -1,3 +1,3 @@\n context {root}/a/note.txt stays\n--- a/{root}/a/note.txt\n+++ b/{root}/b/note.txt\n\\ No newline at end of file\n"
        );
        let restored = restore_plugin_paths(
            &raw,
            &[
                (old_snapshot.as_path(), "note.txt"),
                (new_snapshot.as_path(), "note.txt"),
            ],
        );
        assert_eq!(
            restored,
            format!(
                "diff --git a/note.txt b/note.txt\n--- a/note.txt\n+++ b/note.txt\n@@ -1,3 +1,3 @@\n context {root}/a/note.txt stays\n--- a/{root}/a/note.txt\n+++ b/{root}/b/note.txt\n\\ No newline at end of file\n"
            )
        );
        drop(snapshots);
    }

    #[test]
    fn returns_an_empty_diff_unchanged_and_never_leaks_the_snapshot_root() {
        let snapshots = PluginGitDiffSnapshots::create().unwrap();
        let root = snapshots.path.to_string_lossy().replace('\\', "/");
        let old_snapshot = snapshots.path.join("a/x.txt");
        let new_snapshot = snapshots.path.join("b/x.txt");
        assert_eq!(
            restore_plugin_paths("", &[(old_snapshot.as_path(), "x.txt")]),
            ""
        );
        let raw = format!(
            "diff --git a/{root}/a/x.txt b/{root}/b/x.txt\n--- a/{root}/a/x.txt\n+++ b/{root}/b/x.txt\n@@ -1 +1 @@\n-old\n+new\n"
        );
        let restored = restore_plugin_paths(
            &raw,
            &[
                (old_snapshot.as_path(), "x.txt"),
                (new_snapshot.as_path(), "x.txt"),
            ],
        );
        assert_eq!(
            restored,
            "diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n+new\n"
        );
        assert!(!restored.contains(&root));
        drop(snapshots);
    }

    #[test]
    fn plugin_worktree_diff_restores_nested_plugin_relative_paths() {
        let repository = temporary_directory();
        let workspace = repository.join("packages/example");
        fs::create_dir_all(workspace.join("sub/dir")).unwrap();
        fs::write(repository.join("note.txt"), "repository root note\n").unwrap();
        fs::write(workspace.join("sub/dir/note.txt"), "indexed note\n").unwrap();

        let init = Command::new("git")
            .arg("init")
            .current_dir(&repository)
            .output();
        if init.is_err() {
            let _ = fs::remove_dir_all(repository);
            return;
        }
        assert!(init.unwrap().status.success());
        assert!(Command::new("git")
            .args(["add", "--", "."])
            .current_dir(&repository)
            .status()
            .unwrap()
            .success());
        fs::write(workspace.join("sub/dir/note.txt"), "changed note\n").unwrap();

        let runtime = super::super::GitCoordinator::new();
        let request = runtime.begin_request(&repository, Some("plugin-diff-nested-test"));
        let result = plugin_git_worktree_diff_sync(
            &workspace.to_string_lossy(),
            "sub/dir/note.txt",
            &repository,
            &runtime,
            &request,
        )
        .unwrap();

        assert_eq!(result.path, "sub/dir/note.txt");
        assert!(result
            .diff
            .contains("diff --git a/sub/dir/note.txt b/sub/dir/note.txt"));
        assert!(result.diff.contains("--- a/sub/dir/note.txt"));
        assert!(result.diff.contains("+++ b/sub/dir/note.txt"));
        assert!(result.diff.contains("-indexed note"));
        assert!(result.diff.contains("+changed note"));
        assert!(!result.diff.contains("repository root note"));
        assert!(!result.diff.contains("packages/example/"));
        assert!(!result.diff.contains("pude-plugin-git-diff-"));
        let _ = fs::remove_dir_all(repository);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_plugin_diff_paths_that_follow_symlinks_outside_the_workspace() {
        use std::os::unix::fs::symlink;

        let repository = temporary_directory();
        let workspace = repository.join("packages/example");
        let outside = temporary_directory();
        fs::create_dir_all(&workspace).unwrap();
        fs::write(outside.join("secret.txt"), "outside secret").unwrap();
        symlink(outside.join("secret.txt"), workspace.join("secret.txt")).unwrap();

        let result =
            plugin_git_relative_path(&workspace.to_string_lossy(), "secret.txt", &repository);
        assert!(result.unwrap_err().contains("symbolic links"));
        let _ = fs::remove_dir_all(repository);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn creates_only_absent_files_and_requires_a_matching_fingerprint_to_modify() {
        let root = temporary_directory();
        let locks = Arc::new(Mutex::new(HashMap::<PathBuf, Weak<Mutex<()>>>::new()));
        let created = plugin_workspace_write_sync(
            root.to_string_lossy().to_string(),
            "note.txt".to_string(),
            "first".to_string(),
            None,
            Arc::clone(&locks),
        )
        .unwrap();
        assert!(created.created);
        let missing_fingerprint = plugin_workspace_write_sync(
            root.to_string_lossy().to_string(),
            "note.txt".to_string(),
            "overwrite".to_string(),
            None,
            Arc::clone(&locks),
        );
        assert!(missing_fingerprint
            .unwrap_err()
            .contains("requires its current fingerprint"));
        let wrong_fingerprint = plugin_workspace_write_sync(
            root.to_string_lossy().to_string(),
            "note.txt".to_string(),
            "overwrite".to_string(),
            Some("0000000000000000".to_string()),
            Arc::clone(&locks),
        );
        assert!(wrong_fingerprint.unwrap_err().contains("changed on disk"));
        let replaced = plugin_workspace_write_sync(
            root.to_string_lossy().to_string(),
            "note.txt".to_string(),
            "second".to_string(),
            Some(created.fingerprint),
            locks,
        );
        assert!(!replaced.unwrap().created);
        assert_eq!(fs::read_to_string(root.join("note.txt")).unwrap(), "second");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn file_ranges_are_revision_bound_utf8_chunks_of_normalized_workspace_text() {
        let root = temporary_directory();
        let path = root.join("range.txt");
        let original = "\u{feff}alpha\r\n中文🙂omega";
        fs::write(&path, original.as_bytes()).unwrap();
        let context = open_plugin_file_context(&root.to_string_lossy(), "range.txt").unwrap();
        let revision = context.revision.clone();
        assert_eq!(context.size_bytes, original.len() as u64);

        let mut offset = 0;
        let mut joined = String::new();
        loop {
            let range = plugin_workspace_read_range_sync(
                &root.to_string_lossy(),
                "range.txt",
                &revision,
                offset,
                5,
                None,
            )
            .unwrap();
            assert_eq!(range.offset_bytes, offset);
            assert_eq!(range.revision, revision);
            assert!(range.content.len() <= 5);
            assert!(range.next_offset_bytes - range.offset_bytes <= 5);
            assert_eq!(range.total_bytes, "alpha\n中文🙂omega".len());
            joined.push_str(&range.content);
            offset = range.next_offset_bytes;
            if range.eof {
                break;
            }
        }
        assert_eq!(joined, "alpha\n中文🙂omega");

        let invalid_boundary = plugin_workspace_read_range_sync(
            &root.to_string_lossy(),
            "range.txt",
            &revision,
            "alpha\n中".len() + 1,
            8,
            None,
        );
        assert!(invalid_boundary
            .unwrap_err()
            .starts_with("workspace.invalid_range:"));
        let too_small_for_scalar = plugin_workspace_read_range_sync(
            &root.to_string_lossy(),
            "range.txt",
            &revision,
            "alpha\n中文".len(),
            1,
            None,
        );
        assert!(too_small_for_scalar
            .unwrap_err()
            .starts_with("workspace.invalid_range:"));
        let too_wide = plugin_workspace_read_range_sync(
            &root.to_string_lossy(),
            "range.txt",
            &revision,
            0,
            super::MAX_PLUGIN_FILE_RANGE_BYTES + 1,
            None,
        );
        assert!(too_wide
            .unwrap_err()
            .starts_with("workspace.invalid_range:"));
        let key = PluginSnapshotKey {
            workspace: fs::canonicalize(&root).unwrap(),
            relative_path: PathBuf::from("range.txt"),
        };
        assert!(cached_plugin_snapshot(&key, &revision).unwrap().is_some());
        plugin_workspace_release_file_read(
            root.to_string_lossy().to_string(),
            "range.txt".to_string(),
            revision.clone(),
        )
        .unwrap();
        assert!(cached_plugin_snapshot(&key, &revision).unwrap().is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn file_info_returns_stat_size_without_allocating_oversized_snapshots() {
        let root = temporary_directory();
        let workspace = root.to_string_lossy().to_string();
        let mut oversized_revision = String::new();
        for (name, size) in [
            ("small.txt", 1),
            ("at-limit.txt", super::super::MAX_FILE_READ_BYTES),
            ("oversized.txt", super::super::MAX_FILE_READ_BYTES + 1),
        ] {
            let path = root.join(name);
            fs::File::create(&path).unwrap().set_len(size).unwrap();
            let key = PluginSnapshotKey {
                workspace: fs::canonicalize(&root).unwrap(),
                relative_path: PathBuf::from(name),
            };
            assert!(cached_plugin_snapshot(&key, "unused").unwrap().is_none());
            let builds_before = super::PLUGIN_SNAPSHOT_BUILD_COUNT.with(Cell::get);

            let info = plugin_workspace_file_info_sync(&workspace, name).unwrap();

            let builds_after = super::PLUGIN_SNAPSHOT_BUILD_COUNT.with(Cell::get);
            assert_eq!(builds_after, builds_before, "FileInfo read file contents");
            assert_eq!(info.size_bytes, size);
            assert_eq!(info.path, name);
            assert!(cached_plugin_snapshot(&key, &info.revision)
                .unwrap()
                .is_none());
            if name == "oversized.txt" {
                oversized_revision = info.revision;
            }
        }

        let legacy_error = read_plugin_workspace_file_bounded(
            open_plugin_file_context(&workspace, "oversized.txt").unwrap(),
        )
        .unwrap_err();
        assert!(legacy_error.starts_with("workspace.file_requires_ranges:"));
        let error = plugin_workspace_read_range_sync(
            &workspace,
            "oversized.txt",
            &oversized_revision,
            0,
            1024,
            None,
        )
        .unwrap_err();
        assert!(error.starts_with("workspace.file_too_large:"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_file_read_keeps_normalized_result_for_small_files() {
        let root = temporary_directory();
        let path = root.join("small.txt");
        let bytes = b"\xef\xbb\xbfalpha\r\nbeta\r\n";
        fs::write(&path, bytes).unwrap();
        let context = open_plugin_file_context(&root.to_string_lossy(), "small.txt").unwrap();

        let result = read_plugin_workspace_file_bounded(context).unwrap();

        assert_eq!(result.path, "small.txt");
        assert_eq!(result.content, "alpha\nbeta\n");
        assert_eq!(result.encoding, "utf-8-bom");
        assert!(result.bom);
        assert_eq!(result.size, bytes.len());
        assert_eq!(result.fingerprint, super::super::content_fingerprint(bytes));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn file_range_cancellation_marks_active_work_and_cleans_its_registry_entry() {
        let root = temporary_directory();
        let path = root.join("cancel.txt");
        fs::write(&path, "cancellable content").unwrap();
        let context = open_plugin_file_context(&root.to_string_lossy(), "cancel.txt").unwrap();
        let request_id = format!("cancel-{}", Uuid::new_v4());
        let registration = register_plugin_file_read(Some(&request_id))
            .unwrap()
            .unwrap();
        assert!(cancel_plugin_file_read_sync(&request_id).unwrap());

        let error = plugin_workspace_read_range_sync(
            &root.to_string_lossy(),
            "cancel.txt",
            &context.revision,
            0,
            8,
            Some(&registration.cancelled),
        )
        .unwrap_err();

        assert!(error.starts_with("workspace.read_cancelled:"));
        drop(registration);
        assert!(!super::plugin_file_read_cancellations()
            .lock()
            .unwrap()
            .active
            .contains_key(&request_id));

        let prestart_id = format!("cancel-before-start-{}", Uuid::new_v4());
        assert!(cancel_plugin_file_read_sync(&prestart_id).unwrap());
        let prestart_registration = register_plugin_file_read(Some(&prestart_id))
            .unwrap()
            .unwrap();
        assert!(prestart_registration
            .cancelled
            .load(std::sync::atomic::Ordering::Relaxed));
        drop(prestart_registration);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn range_requests_reject_changed_revisions_without_returning_new_file_bytes() {
        let root = temporary_directory();
        let path = root.join("stale.txt");
        fs::write(&path, b"original contents").unwrap();
        let context = open_plugin_file_context(&root.to_string_lossy(), "stale.txt").unwrap();
        let revision = context.revision;
        let first = plugin_workspace_read_range_sync(
            &root.to_string_lossy(),
            "stale.txt",
            &revision,
            0,
            4,
            None,
        )
        .unwrap();
        assert_eq!(first.content, "orig");
        // A different length keeps the revision distinct even when the filesystem
        // timestamp has not ticked between the two writes.
        fs::write(&path, b"replacement bytes with a different length").unwrap();

        let error = plugin_workspace_read_range_sync(
            &root.to_string_lossy(),
            "stale.txt",
            &revision,
            first.next_offset_bytes,
            4,
            None,
        )
        .unwrap_err();

        assert!(error.starts_with("workspace.file_changed:"));
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn replacement_preserves_existing_modes_across_umasks_and_new_files_keep_umask_mode() {
        let _lock = UMASK_TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        let root = temporary_directory();
        let locks = Arc::new(Mutex::new(HashMap::<PathBuf, Weak<Mutex<()>>>::new()));
        for mask in [0o022, 0o077] {
            for mode in [0o600, 0o640, 0o755] {
                let name = format!("mode-{mask:o}-{mode:o}.sh");
                let path = root.join(&name);
                fs::write(&path, b"before\r\n").unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
                let before = super::super::content_fingerprint(b"before\r\n");
                let umask = UmaskGuard::set(mask);
                let written = plugin_workspace_write_sync(
                    root.to_string_lossy().to_string(),
                    name,
                    "after\n".to_string(),
                    Some(before),
                    Arc::clone(&locks),
                );
                drop(umask);
                let written = written.expect("replacement should preserve the original mode");
                let bytes = fs::read(&path).unwrap();
                assert_eq!(bytes, b"after\r\n");
                assert_eq!(
                    written.fingerprint,
                    super::super::content_fingerprint(&bytes)
                );
                assert_eq!(
                    fs::metadata(&path).unwrap().permissions().mode() & 0o7777,
                    mode
                );
            }
        }

        let umask = UmaskGuard::set(0o077);
        let created = plugin_workspace_write_sync(
            root.to_string_lossy().to_string(),
            "new.sh".to_string(),
            "new file\n".to_string(),
            None,
            locks,
        )
        .expect("new files should use the current umask");
        drop(umask);
        assert!(created.created);
        assert_eq!(
            fs::metadata(root.join("new.sh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o7777,
            0o600
        );
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_point_outside_the_workspace() {
        use std::os::unix::fs::symlink;

        let root = temporary_directory();
        let outside = temporary_directory();
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        symlink(outside.join("secret.txt"), root.join("outside-link.txt")).unwrap();
        let (_, capability) = open_workspace(&root.to_string_lossy()).unwrap();
        let result = open_parent_directory(&capability, &PathBuf::from("outside-link.txt"));
        assert!(result.is_ok());
        let (parent, name) = result.unwrap();
        assert!(
            super::read_file_from_directory(&parent, &name, "outside-link.txt".to_string())
                .unwrap_err()
                .contains("not a regular workspace file")
        );
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[cfg(unix)]
    #[test]
    fn filesystems_without_hard_links_still_create_new_files_exclusively() {
        let root = temporary_directory();
        let (_, capability) = open_workspace(&root.to_string_lossy()).unwrap();
        let unsupported =
            |_: &Dir, _: &Path, _: &Path| Err(io::Error::from(io::ErrorKind::Unsupported));

        let (staged, mut file) = create_temporary_file(&capability).unwrap();
        file.write_all(b"new contents").unwrap();
        drop(file);
        publish_new_file_with(&capability, &staged, Path::new("created.txt"), unsupported).unwrap();
        assert_eq!(fs::read(root.join("created.txt")).unwrap(), b"new contents");

        fs::write(root.join("existing.txt"), b"keep me").unwrap();
        let error =
            publish_new_file_with(&capability, &staged, Path::new("existing.txt"), unsupported)
                .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(root.join("existing.txt")).unwrap(), b"keep me");

        let denied =
            publish_new_file_with(&capability, &staged, Path::new("other.txt"), |_, _, _| {
                Err(io::Error::from(io::ErrorKind::NotFound))
            })
            .unwrap_err();
        assert_eq!(denied.kind(), io::ErrorKind::NotFound);
        assert!(!root.join("other.txt").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn parent_directory_handle_stays_inside_workspace_after_symlink_swap() {
        use std::os::unix::fs::symlink;

        let root = temporary_directory();
        let outside = temporary_directory();
        fs::create_dir(root.join("workspace")).unwrap();
        let (_, capability) = open_workspace(&root.to_string_lossy()).unwrap();
        let (parent, _) =
            open_parent_directory(&capability, &PathBuf::from("workspace/note.txt")).unwrap();
        fs::rename(root.join("workspace"), root.join("held-workspace")).unwrap();
        symlink(&outside, root.join("workspace")).unwrap();
        let (temporary_path, mut file) = create_temporary_file(&parent).unwrap();
        file.write_all(b"confined").unwrap();
        file.sync_all().unwrap();
        drop(file);
        parent
            .hard_link(&temporary_path, &parent, "note.txt")
            .unwrap();
        parent.remove_file(&temporary_path).unwrap();
        assert_eq!(
            fs::read(root.join("held-workspace/note.txt")).unwrap(),
            b"confined"
        );
        assert!(!outside.join("note.txt").exists());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }
}
