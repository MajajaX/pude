//! Explorer "Add to .gitignore": lists one file or folder in the repository's
//! root `.gitignore`.

use serde::Serialize;
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use tauri::State;

use crate::git_runtime::{
    GitCommandSpec, GitCoordinator, GitReadKind, GitReadRequest, RequestHandle,
};
use crate::{
    cached_git_repository_root, decode_wire_path, format_atomic_save_error, git_error_info,
    git_resource_key_async, inspect_atomic_save_target, path_lock, run_git_blocking,
    save_file_atomically, save_lock_key, AppState, GitErrorInfo, GitErrorKind, QuitGateState,
};

type SaveLocks = Arc<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddToGitignoreResult {
    added: bool,
    tracked: bool,
}

#[tauri::command]
pub(crate) async fn add_to_gitignore<R: tauri::Runtime>(
    workspace: String,
    path: String,
    window: tauri::WebviewWindow<R>,
    state: State<'_, AppState>,
    quit_gate: State<'_, QuitGateState>,
) -> Result<AddToGitignoreResult, GitErrorInfo> {
    let admission = quit_gate
        .admit_resource_operation(window.label())
        .map_err(|error| git_error_info(GitErrorKind::Cancelled, error))?;
    let roots = Arc::clone(&state.git_repository_roots);
    let save_locks = Arc::clone(&state.save_locks);
    let runtime = state.git_runtime.clone();
    let request = runtime.begin_request(decode_wire_path(&workspace), Some(window.label()));
    let resource = git_resource_key_async(workspace.clone(), roots.clone()).await;
    run_git_blocking("Unable to add to .gitignore", resource, move || {
        let _admission = admission;
        let repository = cached_git_repository_root(&workspace, &roots, &runtime, &request)?;
        let target = decode_wire_path(&path);
        let relative = relative_to_repository(&target, &repository).map_err(failed)?;
        let is_directory = fs::symlink_metadata(&target)
            .map_err(|_| failed("Unable to add to .gitignore. The item no longer exists."))?
            .is_dir();
        let pattern = ignore_pattern(&path_bytes(&relative), is_directory).map_err(failed)?;
        let added = append_pattern(&repository.join(".gitignore"), &pattern, &save_locks)
            .map_err(failed)?;
        let tracked = is_tracked(&repository, &relative, &runtime, &request);
        Ok(AddToGitignoreResult { added, tracked })
    })
    .await
}

fn failed(message: impl Into<String>) -> GitErrorInfo {
    git_error_info(GitErrorKind::Failed, message)
}

fn relative_to_repository(target: &Path, repository: &Path) -> Result<PathBuf, String> {
    let cannot_ignore = || "Unable to add to .gitignore. This location cannot be ignored.";
    let relative = target
        .strip_prefix(repository)
        .map_err(|_| cannot_ignore())?;
    let inside_git_directory = relative
        .components()
        .next()
        .is_some_and(|part| part.as_os_str() == ".git");
    let has_parent_step = relative
        .components()
        .any(|part| part == std::path::Component::ParentDir);
    if relative.as_os_str().is_empty() || inside_git_directory || has_parent_step {
        return Err(cannot_ignore().to_string());
    }
    Ok(relative.to_path_buf())
}

#[cfg(unix)]
fn path_bytes(path: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    path.as_os_str().as_bytes().to_vec()
}

#[cfg(not(unix))]
fn path_bytes(path: &Path) -> Vec<u8> {
    path.to_string_lossy().replace('\\', "/").into_bytes()
}

/// An anchored pattern that matches this one item and no other item of the same name.
fn ignore_pattern(relative: &[u8], is_directory: bool) -> Result<Vec<u8>, String> {
    if relative.iter().any(|byte| matches!(byte, b'\n' | b'\r')) {
        return Err(
            "Unable to add to .gitignore. Names with line breaks cannot be listed.".to_string(),
        );
    }
    let content_end = relative
        .iter()
        .rposition(|byte| *byte != b' ')
        .map_or(0, |index| index + 1);
    let mut pattern = vec![b'/'];
    for (index, byte) in relative.iter().enumerate() {
        let is_wildcard = matches!(byte, b'\\' | b'*' | b'?' | b'[');
        // Git drops unescaped spaces at the end of a line; a folder's trailing slash protects them.
        let is_trailing_space = !is_directory && index >= content_end;
        if is_wildcard || is_trailing_space {
            pattern.push(b'\\');
        }
        pattern.push(*byte);
    }
    if is_directory {
        pattern.push(b'/');
    }
    Ok(pattern)
}

fn with_pattern(existing: &[u8], pattern: &[u8]) -> Option<Vec<u8>> {
    let already_listed = existing
        .split(|byte| *byte == b'\n')
        .any(|line| line.strip_suffix(b"\r").unwrap_or(line) == pattern);
    if already_listed {
        return None;
    }
    let newline: &[u8] = if existing.windows(2).any(|pair| pair == b"\r\n") {
        b"\r\n"
    } else {
        b"\n"
    };
    let mut updated = existing.to_vec();
    if !existing.is_empty() && !existing.ends_with(b"\n") {
        updated.extend_from_slice(newline);
    }
    updated.extend_from_slice(pattern);
    updated.extend_from_slice(newline);
    Some(updated)
}

fn append_pattern(
    gitignore: &Path,
    pattern: &[u8],
    save_locks: &SaveLocks,
) -> Result<bool, String> {
    let lock = path_lock(save_locks, &save_lock_key(gitignore))?;
    let _guard = lock
        .lock()
        .map_err(|_| "Unable to add to .gitignore. The save lock is unavailable.".to_string())?;
    let snapshot = inspect_atomic_save_target(gitignore).map_err(format_atomic_save_error)?;
    let existing = if snapshot.is_some() {
        fs::read(gitignore).map_err(|error| format!("Unable to add to .gitignore. {error}"))?
    } else {
        Vec::new()
    };
    let Some(updated) = with_pattern(&existing, pattern) else {
        return Ok(false);
    };
    save_file_atomically(gitignore, &updated, snapshot.as_ref())
        .map_err(format_atomic_save_error)?;
    Ok(true)
}

/// Only drives a hint in the confirmation, so a failed query counts as not tracked.
fn is_tracked(
    repository: &Path,
    relative: &Path,
    runtime: &GitCoordinator,
    request: &RequestHandle,
) -> bool {
    let mut literal_path = OsString::from(":(literal)");
    literal_path.push(relative);
    let spec = GitCommandSpec::read(
        repository.to_path_buf(),
        vec!["ls-files".into(), "-z".into(), "--".into(), literal_path],
    );
    runtime
        .read_shared_for(
            GitReadRequest::new(repository, GitReadKind::Status, spec),
            request,
        )
        .ok()
        .and_then(|output| output.into_success().ok())
        .is_some_and(|output| !output.stdout.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pattern(relative: &str, is_directory: bool) -> String {
        String::from_utf8(ignore_pattern(relative.as_bytes(), is_directory).unwrap()).unwrap()
    }

    #[test]
    fn patterns_are_anchored_and_mark_folders() {
        assert_eq!(pattern("src/app.log", false), "/src/app.log");
        assert_eq!(pattern("build", true), "/build/");
    }

    #[test]
    fn patterns_escape_what_gitignore_would_interpret() {
        assert_eq!(pattern("a*b?[c].txt", false), "/a\\*b\\?\\[c].txt");
        assert_eq!(pattern("back\\slash", false), "/back\\\\slash");
        assert_eq!(pattern("#notes", false), "/#notes");
        assert_eq!(pattern("!keep", false), "/!keep");
        assert_eq!(pattern("name  ", false), "/name\\ \\ ");
        assert_eq!(pattern("name  ", true), "/name  /");
    }

    #[test]
    fn names_with_line_breaks_are_refused() {
        assert!(ignore_pattern(b"two\nlines", false).is_err());
        assert!(ignore_pattern(b"two\rlines", false).is_err());
    }

    #[test]
    fn appending_keeps_existing_lines_and_their_line_endings() {
        assert_eq!(with_pattern(b"", b"/a").unwrap(), b"/a\n");
        assert_eq!(with_pattern(b"*.log\n", b"/a").unwrap(), b"*.log\n/a\n");
        assert_eq!(with_pattern(b"*.log", b"/a").unwrap(), b"*.log\n/a\n");
        assert_eq!(
            with_pattern(b"*.log\r\n", b"/a").unwrap(),
            b"*.log\r\n/a\r\n"
        );
        assert_eq!(
            with_pattern(b"*.log\r\n#x", b"/a").unwrap(),
            b"*.log\r\n#x\r\n/a\r\n"
        );
    }

    #[test]
    fn a_listed_pattern_is_not_added_again() {
        assert!(with_pattern(b"/a\n", b"/a").is_none());
        assert!(with_pattern(b"x\r\n/a\r\ny\r\n", b"/a").is_none());
        assert!(with_pattern(b"/ab\n", b"/a").is_some());
    }

    #[test]
    fn only_items_inside_the_repository_can_be_listed() {
        let repository = Path::new("/repo");
        assert_eq!(
            relative_to_repository(Path::new("/repo/src/a"), repository).unwrap(),
            Path::new("src/a")
        );
        assert!(relative_to_repository(Path::new("/repo"), repository).is_err());
        assert!(relative_to_repository(Path::new("/other/a"), repository).is_err());
        assert!(relative_to_repository(Path::new("/repo/.git/config"), repository).is_err());
        assert!(relative_to_repository(Path::new("/repo/a/../../b"), repository).is_err());
    }
}
