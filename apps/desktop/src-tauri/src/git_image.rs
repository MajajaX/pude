use std::ffi::OsString;
use std::path::Path;
use std::sync::Arc;

use tauri::State;

use crate::filesystem::{validate_preview_image, MAX_IMAGE_PREVIEW_BYTES};
use crate::git_runtime::{
    GitCommandSpec, GitCoordinator, GitErrorInfo, GitErrorKind, RequestHandle,
};
use crate::git_stash::is_object_id;
use crate::{
    cached_git_repository_root, decode_wire_path, ensure_request_active, git_error_info,
    git_resource_key_async, run_git_blocking, AppState, QuitGateState,
};

/// Reads one version of an image from Git for the image diff: the staged copy
/// (`revision` empty), `HEAD`, a commit, or a commit's parent (`<commit>^`,
/// `<commit>^1`, `<commit>^3` for a stash's untracked files). An image that does
/// not exist in that version is returned as an empty response.
#[tauri::command]
pub(crate) async fn git_image(
    workspace: String,
    revision: String,
    path: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    quit_gate: State<'_, QuitGateState>,
) -> Result<tauri::ipc::Response, GitErrorInfo> {
    let object = image_object_name(&revision, &decode_wire_path(&path))?;
    let admission = quit_gate
        .admit_resource_operation(window.label())
        .map_err(|error| git_error_info(GitErrorKind::Cancelled, error))?;
    let repository_roots = Arc::clone(&state.git_repository_roots);
    let runtime = state.git_runtime.clone();
    let request = runtime.begin_request(decode_wire_path(&workspace), Some(window.label()));
    let resource = git_resource_key_async(workspace.clone(), repository_roots.clone()).await;
    run_git_blocking("Unable to read the image from Git", resource, move || {
        let _admission = admission;
        let repository_root =
            cached_git_repository_root(&workspace, &repository_roots, &runtime, &request)?;
        let bytes = read_git_image(&repository_root, object, &runtime, &request)?;
        if let Some(bytes) = &bytes {
            validate_preview_image(&decode_wire_path(&path), bytes)
                .map_err(|message| git_error_info(GitErrorKind::Failed, message))?;
        }
        Ok(tauri::ipc::Response::new(bytes.unwrap_or_default()))
    })
    .await
}

/// `<revision>:<path>`, or `:0:<path>` for the staged copy.
fn image_object_name(revision: &str, path: &Path) -> Result<OsString, GitErrorInfo> {
    let commit = revision
        .strip_suffix("^1")
        .or_else(|| revision.strip_suffix("^3"))
        .or_else(|| revision.strip_suffix('^'))
        .unwrap_or(revision);
    let valid_revision = revision.is_empty() || revision == "HEAD" || is_object_id(commit);
    if !valid_revision {
        return Err(git_error_info(
            GitErrorKind::Failed,
            "An image version must be the index, HEAD or a commit identified by its full object ID.",
        ));
    }
    if path.as_os_str().is_empty() || path.to_string_lossy().contains('\n') {
        return Err(git_error_info(
            GitErrorKind::Failed,
            "Choose an image file from the change list.",
        ));
    }
    let mut object = OsString::from(if revision.is_empty() { ":0" } else { revision });
    object.push(":");
    object.push(path.as_os_str());
    Ok(object)
}

/// Runs `git cat-file --batch` so a missing image is reported as `missing`
/// instead of an error, and returns `None` for it.
fn read_git_image(
    repository_root: &Path,
    object: OsString,
    runtime: &GitCoordinator,
    request: &RequestHandle,
) -> Result<Option<Vec<u8>>, GitErrorInfo> {
    ensure_request_active(request)?;
    let mut input = object_name_bytes(&object);
    input.push(b'\n');
    let mut spec = GitCommandSpec::read(
        repository_root.to_path_buf(),
        vec![OsString::from("cat-file"), OsString::from("--batch")],
    );
    spec.stdin = Some(Arc::from(input));
    spec.stdout_limit = MAX_IMAGE_PREVIEW_BYTES as usize + 1024;
    let output = runtime
        .execute(spec, &request.token())
        .and_then(|output| output.into_success())
        .map_err(|error| error.info())?;
    parse_batch_blob(&output.stdout)
}

#[cfg(unix)]
fn object_name_bytes(object: &OsString) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    object.as_bytes().to_vec()
}

#[cfg(not(unix))]
fn object_name_bytes(object: &OsString) -> Vec<u8> {
    object.to_string_lossy().replace('\\', "/").into_bytes()
}

fn parse_batch_blob(stdout: &[u8]) -> Result<Option<Vec<u8>>, GitErrorInfo> {
    let header_end = stdout
        .iter()
        .position(|byte| *byte == b'\n')
        .unwrap_or(stdout.len());
    let header = String::from_utf8_lossy(&stdout[..header_end]).into_owned();
    if header.ends_with(" missing") || header.ends_with(" ambiguous") {
        return Ok(None);
    }
    let mut fields = header.split(' ');
    let object_type = fields.nth(1);
    let size = fields.next().and_then(|size| size.parse::<usize>().ok());
    let Some(size) = size.filter(|_| object_type == Some("blob")) else {
        return Err(git_error_info(
            GitErrorKind::Failed,
            "This path is not a file in that version.",
        ));
    };
    if size as u64 > MAX_IMAGE_PREVIEW_BYTES {
        return Err(git_error_info(
            GitErrorKind::OutputLimit,
            "The image is too large to preview.",
        ));
    }
    let content_start = header_end + 1;
    if stdout.len() < content_start + size {
        return Err(git_error_info(
            GitErrorKind::Failed,
            "Git returned an incomplete image.",
        ));
    }
    Ok(Some(stdout[content_start..content_start + size].to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;

    const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8,
        0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    struct Repository(PathBuf);

    impl Repository {
        fn new(name: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("pude-git-image-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("repository directory");
            let repository = Self(path);
            repository.git(&["init", "--quiet"]);
            repository.git(&["config", "user.name", "Image Test"]);
            repository.git(&["config", "user.email", "image@example.test"]);
            repository
        }

        fn git(&self, args: &[&str]) -> String {
            let output = Command::new("git")
                .args(args)
                .current_dir(&self.0)
                .output()
                .expect("git executable");
            assert!(output.status.success(), "git {args:?}");
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }

        fn read(&self, revision: &str, path: &str) -> Option<Vec<u8>> {
            let runtime = GitCoordinator::new();
            let request = runtime.begin_request(&self.0, Some("image-test"));
            let object = image_object_name(revision, Path::new(path)).expect("object name");
            read_git_image(&self.0, object, &runtime, &request).expect("image read")
        }
    }

    impl Drop for Repository {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn reads_each_version_and_reports_missing_ones_as_none() {
        let repository = Repository::new("versions");
        fs::create_dir_all(repository.0.join("assets")).unwrap();
        assert_eq!(repository.read("HEAD", "assets/logo.png"), None);

        fs::write(repository.0.join("assets/logo.png"), PNG_1X1).unwrap();
        repository.git(&["add", "assets/logo.png"]);
        assert_eq!(
            repository.read("", "assets/logo.png").as_deref(),
            Some(PNG_1X1)
        );
        assert_eq!(repository.read("HEAD", "assets/logo.png"), None);

        repository.git(&["commit", "--quiet", "-m", "logo"]);
        let commit = repository.git(&["rev-parse", "HEAD"]);
        assert_eq!(
            repository.read("HEAD", "assets/logo.png").as_deref(),
            Some(PNG_1X1)
        );
        assert_eq!(
            repository.read(&commit, "assets/logo.png").as_deref(),
            Some(PNG_1X1)
        );
        assert_eq!(
            repository.read(&format!("{commit}^"), "assets/logo.png"),
            None
        );
        assert_eq!(repository.read("", "assets/other.png"), None);
    }

    #[test]
    fn rejects_revisions_other_than_index_head_and_full_commits() {
        let path = Path::new("logo.png");
        for revision in ["main", "HEAD~1", "abc123", "HEAD^", ":/message"] {
            assert!(image_object_name(revision, path).is_err(), "{revision}");
        }
        let commit = "a".repeat(40);
        for revision in [
            String::new(),
            "HEAD".to_string(),
            commit.clone(),
            format!("{commit}^"),
            format!("{commit}^1"),
            format!("{commit}^3"),
        ] {
            assert!(image_object_name(&revision, path).is_ok(), "{revision}");
        }
        assert_eq!(
            image_object_name("", path).unwrap(),
            OsString::from(":0:logo.png")
        );
    }

    #[test]
    fn rejects_a_directory_in_place_of_an_image() {
        let error = parse_batch_blob(b"0123 tree 30\n").unwrap_err();
        assert_eq!(error.kind, GitErrorKind::Failed);
    }
}
