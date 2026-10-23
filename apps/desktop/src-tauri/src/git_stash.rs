use std::ffi::OsString;
use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::git_diff::{
    next_context_lines, INITIAL_DIFF_CONTEXT_LINES, MAX_DIFF_CONTEXT_LINES, MAX_DIFF_STDOUT_BYTES,
};
use crate::git_runtime::{
    GitCommandSpec, GitCoordinator, GitErrorInfo, GitErrorKind, GitReadKind, GitReadRequest,
    RequestHandle, DEFAULT_STDERR_LIMIT,
};
use crate::{
    cached_git_repository_root, decode_wire_path, git_error_info, git_read_shared,
    git_read_shared_raw, git_resource_key_async, parse_git_commit_files, run_git_blocking,
    wire_path_bytes, AppState, DiffResult, QuitGateState,
};

const STASH_LIST_FORMAT: &str = "--format=%H%x1f%gd%x1f%cI%x1f%gs";

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitStash {
    index: usize,
    reference: String,
    hash: String,
    created_at: String,
    message: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitStashFile {
    path: String,
    status: String,
    original_path: Option<String>,
    untracked: bool,
}

/// `stash@{N}` as printed by `git stash list`.
pub(crate) fn is_stash_reference(value: &str) -> bool {
    value
        .strip_prefix("stash@{")
        .and_then(|rest| rest.strip_suffix('}'))
        .is_some_and(|index| !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit()))
}

/// A full SHA-1 or SHA-256 object name.
pub(crate) fn is_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn parse_stash_list(output: &str) -> Vec<GitStash> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\u{1f}');
            let hash = fields.next()?.trim();
            let reference = fields.next()?.trim();
            let created_at = fields.next()?.trim();
            let message = fields.next().unwrap_or_default().trim();
            if !is_object_id(hash) || !is_stash_reference(reference) {
                return None;
            }
            let index = reference["stash@{".len()..reference.len() - 1]
                .parse()
                .ok()?;
            Some(GitStash {
                index,
                reference: reference.to_string(),
                hash: hash.to_string(),
                created_at: created_at.to_string(),
                message: message.to_string(),
            })
        })
        .collect()
}

fn require_object_id(value: &str) -> Result<(), GitErrorInfo> {
    if is_object_id(value) {
        Ok(())
    } else {
        Err(git_error_info(
            GitErrorKind::Failed,
            "The stash is no longer available. Refresh the stash list and try again.",
        ))
    }
}

#[tauri::command]
pub(crate) async fn git_stashes(
    workspace: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    quit_gate: State<'_, QuitGateState>,
) -> Result<Vec<GitStash>, GitErrorInfo> {
    let admission = quit_gate
        .admit_resource_operation(window.label())
        .map_err(|error| git_error_info(GitErrorKind::Cancelled, error))?;
    let repository_roots = Arc::clone(&state.git_repository_roots);
    let runtime = state.git_runtime.clone();
    let request = runtime.begin_request(decode_wire_path(&workspace), Some(window.label()));
    let resource = git_resource_key_async(workspace.clone(), repository_roots.clone()).await;
    run_git_blocking("Unable to read Git stashes", resource, move || {
        let _admission = admission;
        let repository_root =
            cached_git_repository_root(&workspace, &repository_roots, &runtime, &request)?;
        list_stashes(&repository_root, &runtime, &request)
    })
    .await
}

fn list_stashes(
    repository_root: &Path,
    runtime: &GitCoordinator,
    request: &RequestHandle,
) -> Result<Vec<GitStash>, GitErrorInfo> {
    let output = git_read_shared(
        runtime,
        repository_root,
        GitReadKind::Refs,
        vec![
            OsString::from("stash"),
            OsString::from("list"),
            OsString::from(STASH_LIST_FORMAT),
        ],
        request,
    )?;
    Ok(parse_stash_list(&output.stdout_lossy()))
}

#[tauri::command]
pub(crate) async fn git_stash_files(
    workspace: String,
    stash: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    quit_gate: State<'_, QuitGateState>,
) -> Result<Vec<GitStashFile>, GitErrorInfo> {
    require_object_id(&stash)?;
    let admission = quit_gate
        .admit_resource_operation(window.label())
        .map_err(|error| git_error_info(GitErrorKind::Cancelled, error))?;
    let repository_roots = Arc::clone(&state.git_repository_roots);
    let runtime = state.git_runtime.clone();
    let request = runtime.begin_request(decode_wire_path(&workspace), Some(window.label()));
    let resource = git_resource_key_async(workspace.clone(), repository_roots.clone()).await;
    run_git_blocking("Unable to read stash files", resource, move || {
        let _admission = admission;
        let repository_root =
            cached_git_repository_root(&workspace, &repository_roots, &runtime, &request)?;
        stash_files(&repository_root, &stash, &runtime, &request)
    })
    .await
}

fn stash_files(
    repository_root: &Path,
    stash: &str,
    runtime: &GitCoordinator,
    request: &RequestHandle,
) -> Result<Vec<GitStashFile>, GitErrorInfo> {
    // The stash commit's tree is the working tree; its first parent is HEAD at stash time.
    let tracked = git_read_shared(
        runtime,
        repository_root,
        GitReadKind::History,
        vec![
            OsString::from("diff"),
            OsString::from("--no-ext-diff"),
            OsString::from("--name-status"),
            OsString::from("--find-renames"),
            OsString::from("-z"),
            OsString::from(format!("{stash}^1")),
            OsString::from(stash),
        ],
        request,
    )?;
    let mut files: Vec<GitStashFile> = parse_git_commit_files(&tracked.stdout)
        .into_iter()
        .map(|file| GitStashFile {
            path: file.path,
            status: file.status,
            original_path: file.original_path,
            untracked: false,
        })
        .collect();
    // `git stash push --include-untracked` stores new files in a third, parentless commit.
    let untracked = git_read_shared_raw(
        runtime,
        repository_root,
        GitReadKind::History,
        vec![
            OsString::from("ls-tree"),
            OsString::from("-r"),
            OsString::from("-z"),
            OsString::from("--name-only"),
            OsString::from(format!("{stash}^3")),
        ],
        request,
    )?;
    if untracked.success {
        files.extend(
            untracked
                .stdout
                .split(|byte| *byte == 0)
                .filter(|path| !path.is_empty())
                .map(|path| GitStashFile {
                    path: wire_path_bytes(path),
                    status: "A".to_string(),
                    original_path: None,
                    untracked: true,
                }),
        );
    }
    Ok(files)
}

#[tauri::command]
pub(crate) async fn git_stash_diff(
    workspace: String,
    stash: String,
    path: String,
    untracked: bool,
    context_lines: Option<usize>,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    quit_gate: State<'_, QuitGateState>,
) -> Result<DiffResult, GitErrorInfo> {
    require_object_id(&stash)?;
    let admission = quit_gate
        .admit_resource_operation(window.label())
        .map_err(|error| git_error_info(GitErrorKind::Cancelled, error))?;
    let repository_roots = Arc::clone(&state.git_repository_roots);
    let runtime = state.git_runtime.clone();
    let request = runtime.begin_request(decode_wire_path(&workspace), Some(window.label()));
    let resource = git_resource_key_async(workspace.clone(), repository_roots.clone()).await;
    run_git_blocking("Unable to read stash diff", resource, move || {
        let _admission = admission;
        let repository_root =
            cached_git_repository_root(&workspace, &repository_roots, &runtime, &request)?;
        let context_lines = context_lines
            .unwrap_or(INITIAL_DIFF_CONTEXT_LINES)
            .min(MAX_DIFF_CONTEXT_LINES);
        let diff = stash_diff(
            &repository_root,
            &stash,
            &decode_wire_path(&path),
            untracked,
            context_lines,
            &runtime,
            &request,
        )?;
        Ok(DiffResult {
            path,
            output_bytes: diff.len(),
            diff,
            staged: false,
            context_lines,
            truncated: false,
            next_context_lines: next_context_lines(context_lines),
        })
    })
    .await
}

fn stash_diff(
    repository_root: &Path,
    stash: &str,
    file_path: &Path,
    untracked: bool,
    context_lines: usize,
    runtime: &GitCoordinator,
    request: &RequestHandle,
) -> Result<String, GitErrorInfo> {
    let unified = OsString::from(format!("--unified={context_lines}"));
    let mut args = if untracked {
        // The untracked-files commit has no parent, so `show` prints each file as added.
        vec![
            OsString::from("show"),
            OsString::from("--no-ext-diff"),
            unified,
            OsString::from("--format="),
            OsString::from(format!("{stash}^3")),
        ]
    } else {
        vec![
            OsString::from("diff"),
            OsString::from("--no-ext-diff"),
            unified,
            OsString::from(format!("{stash}^1")),
            OsString::from(stash),
        ]
    };
    args.push(OsString::from("--"));
    args.push(file_path.as_os_str().to_os_string());
    let mut spec = GitCommandSpec::read(repository_root, args);
    spec.stdout_limit = MAX_DIFF_STDOUT_BYTES;
    spec.stderr_limit = DEFAULT_STDERR_LIMIT.min(128 * 1024);
    let output = runtime
        .read_shared_for(
            GitReadRequest::new(repository_root, GitReadKind::History, spec),
            request,
        )
        .map_err(|error| error.info())?
        .into_success()
        .map_err(|error| error.info())?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Stash entries shift when one is dropped; refuse to act on a reference that
/// now names a different stash than the one the user selected.
pub(crate) fn verify_stash_target(
    repository_root: &Path,
    reference: &str,
    expected_hash: &str,
    runtime: &GitCoordinator,
    request: &RequestHandle,
) -> Result<(), GitErrorInfo> {
    let current = git_read_shared_raw(
        runtime,
        repository_root,
        GitReadKind::Refs,
        vec![
            OsString::from("rev-parse"),
            OsString::from("--verify"),
            OsString::from("--quiet"),
            OsString::from(reference),
        ],
        request,
    )?;
    if current.success
        && current
            .stdout_lossy()
            .trim()
            .eq_ignore_ascii_case(expected_hash)
    {
        Ok(())
    } else {
        Err(git_error_info(
            GitErrorKind::Failed,
            "The stash list changed. Refresh it and choose the stash again.",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;

    struct Repository(PathBuf);

    impl Repository {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("pude-stash-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            let repository = Self(fs::canonicalize(path).unwrap());
            repository.git(&["init", "--quiet"]);
            repository.git(&["config", "user.name", "Stash Test"]);
            repository.git(&["config", "user.email", "stash@example.test"]);
            repository
        }

        fn git(&self, args: &[&str]) -> String {
            let output = Command::new("git")
                .args(args)
                .current_dir(&self.0)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
    }

    impl Drop for Repository {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn validates_stash_references_and_object_ids() {
        assert!(is_stash_reference("stash@{0}"));
        assert!(is_stash_reference("stash@{12}"));
        assert!(!is_stash_reference("stash@{}"));
        assert!(!is_stash_reference("stash@{-1}"));
        assert!(!is_stash_reference("stash@{0}; rm"));
        assert!(!is_stash_reference("refs/stash"));
        assert!(is_object_id(&"a".repeat(40)));
        assert!(is_object_id(&"0".repeat(64)));
        assert!(!is_object_id("HEAD"));
        assert!(!is_object_id(&"g".repeat(40)));
    }

    #[test]
    fn parses_stash_list_lines() {
        let hash = "1".repeat(40);
        let output = format!(
            "{hash}\u{1f}stash@{{0}}\u{1f}2026-10-23T10:00:00+08:00\u{1f}On main: pude stash\nbroken line\n"
        );
        assert_eq!(
            parse_stash_list(&output),
            vec![GitStash {
                index: 0,
                reference: "stash@{0}".into(),
                hash,
                created_at: "2026-10-23T10:00:00+08:00".into(),
                message: "On main: pude stash".into(),
            }]
        );
    }

    #[test]
    fn lists_stash_files_including_untracked_and_reads_their_diffs() {
        let repository = Repository::new();
        fs::write(repository.0.join("tracked.txt"), "one\n").unwrap();
        repository.git(&["add", "tracked.txt"]);
        repository.git(&["commit", "--quiet", "-m", "initial"]);
        fs::write(repository.0.join("tracked.txt"), "two\n").unwrap();
        fs::write(repository.0.join("new file.txt"), "fresh\n").unwrap();
        repository.git(&["stash", "push", "--include-untracked", "-m", "work"]);

        let runtime = GitCoordinator::new();
        let request = runtime.begin_request(&repository.0, Some("stash-test"));
        let stashes = list_stashes(&repository.0, &runtime, &request).unwrap();
        assert_eq!(stashes.len(), 1);
        assert_eq!(stashes[0].reference, "stash@{0}");
        assert!(stashes[0].message.ends_with("work"));

        let files = stash_files(&repository.0, &stashes[0].hash, &runtime, &request).unwrap();
        assert_eq!(
            files,
            vec![
                GitStashFile {
                    path: "tracked.txt".into(),
                    status: "M".into(),
                    original_path: None,
                    untracked: false
                },
                GitStashFile {
                    path: "new file.txt".into(),
                    status: "A".into(),
                    original_path: None,
                    untracked: true
                },
            ]
        );
        let tracked = stash_diff(
            &repository.0,
            &stashes[0].hash,
            Path::new("tracked.txt"),
            false,
            3,
            &runtime,
            &request,
        )
        .unwrap();
        assert!(tracked.contains("-one") && tracked.contains("+two"));
        let untracked = stash_diff(
            &repository.0,
            &stashes[0].hash,
            Path::new("new file.txt"),
            true,
            3,
            &runtime,
            &request,
        )
        .unwrap();
        assert!(untracked.contains("+fresh"));

        verify_stash_target(
            &repository.0,
            "stash@{0}",
            &stashes[0].hash,
            &runtime,
            &request,
        )
        .unwrap();
        assert!(verify_stash_target(
            &repository.0,
            "stash@{0}",
            &"0".repeat(40),
            &runtime,
            &request
        )
        .is_err());
        assert!(verify_stash_target(
            &repository.0,
            "stash@{1}",
            &stashes[0].hash,
            &runtime,
            &request
        )
        .is_err());
    }
}
