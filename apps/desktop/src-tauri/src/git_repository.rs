use crate::git_runtime::{
    GitCommandSpec, GitCoordinator, GitDirtyScope, GitErrorInfo, GitErrorKind, RequestHandle,
};
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[cfg(unix)]
use std::os::unix::ffi::OsStringExt;

/// A worktree root and the on-disk identity of its Git administrative data.
///
/// The identity intentionally excludes mutable HEAD/ref contents. History
/// cursors bind those separately to the actual ref snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RepositoryIdentity {
    pub worktree_root: PathBuf,
    pub git_dir: PathBuf,
    pub common_dir: PathBuf,
    git_entry: PathMarkerIdentity,
    git_dir_marker: PathMarkerIdentity,
    common_dir_marker: PathMarkerIdentity,
}

#[derive(Debug, Clone)]
pub struct ResolvedGitRepository {
    pub root: PathBuf,
    pub identity: RepositoryIdentity,
}

#[derive(Default)]
pub struct RepositoryRootCache {
    entries: Mutex<HashMap<PathBuf, ResolvedGitRepository>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PathMarkerIdentity {
    path: PathBuf,
    length: u64,
    modified_nanos: u128,
    is_file: bool,
    is_dir: bool,
    device: u64,
    file_id: u64,
    gitfile_contents: Option<Vec<u8>>,
}

impl RepositoryIdentity {
    pub fn same_repository(&self, other: &Self) -> bool {
        self == other
    }

    pub fn fingerprint(&self) -> String {
        format!(
            "{}\0{}\0{}\0{:?}\0{:?}\0{:?}",
            self.worktree_root.display(),
            self.git_dir.display(),
            self.common_dir.display(),
            self.git_entry,
            self.git_dir_marker,
            self.common_dir_marker
        )
    }
}

impl RepositoryRootCache {
    /// Resolve the nearest Git worktree containing `workspace` and revalidate
    /// its `.git` entry and administrative directories on every cache hit.
    /// A successful cache hit performs filesystem metadata checks only; it
    /// does not launch Git again.
    pub fn resolve(
        &self,
        workspace: impl AsRef<Path>,
        runtime: &GitCoordinator,
        request: &RequestHandle,
    ) -> Result<ResolvedGitRepository, GitErrorInfo> {
        let workspace = canonical_or_original(workspace.as_ref());
        let cache_key = workspace.clone();
        let cached = self
            .entries
            .lock()
            .map_err(|_| {
                error(
                    GitErrorKind::Internal,
                    "Unable to lock Git repository cache.",
                )
            })?
            .get(&cache_key)
            .cloned();

        if let Some(cached) = cached {
            if identity_is_current(&workspace, &cached) {
                request.bind_repository(&cached.root);
                return Ok(cached);
            }
            self.entries
                .lock()
                .map_err(|_| {
                    error(
                        GitErrorKind::Internal,
                        "Unable to lock Git repository cache.",
                    )
                })?
                .remove(&cache_key);
            runtime.invalidate(&cached.root, GitDirtyScope::ALL);
        }

        if request.token().is_cancelled() {
            return Err(error(GitErrorKind::Cancelled, "Git command was cancelled."));
        }
        let discovered = discover_repository(&workspace, runtime, request)?;
        let identity = capture_identity(
            &workspace,
            &discovered.root,
            discovered.git_dir,
            discovered.common_dir,
        )?;
        let resolved = ResolvedGitRepository {
            root: identity.worktree_root.clone(),
            identity,
        };
        self.entries
            .lock()
            .map_err(|_| {
                error(
                    GitErrorKind::Internal,
                    "Unable to lock Git repository cache.",
                )
            })?
            .insert(cache_key, resolved.clone());
        request.bind_repository(&resolved.root);
        Ok(resolved)
    }

    /// Return the repository key suitable for the blocking Git scheduler.
    /// Cached roots are used only while the nearest `.git` marker and its
    /// identity still match. If stale, a filesystem walk supplies the fresh
    /// nearest root without requiring a child process on the async executor.
    pub fn resource_key(&self, workspace: impl AsRef<Path>) -> PathBuf {
        let workspace = canonical_or_original(workspace.as_ref());
        if let Ok(entries) = self.entries.lock() {
            if let Some(cached) = entries.get(&workspace) {
                if identity_is_current(&workspace, cached) {
                    return cached.root.clone();
                }
            }
        }
        filesystem_repository_root(&workspace).unwrap_or(workspace)
    }

    /// Drop a workspace mapping when a watcher overflow, workspace reopen, or
    /// explicit refresh asks for fresh discovery. Git read revisions are also
    /// advanced so completed or in-flight results from the old identity cannot
    /// be reused as current data.
    pub fn invalidate_workspace(
        &self,
        workspace: impl AsRef<Path>,
        runtime: &GitCoordinator,
    ) -> Result<(), GitErrorInfo> {
        let workspace = canonical_or_original(workspace.as_ref());
        let cached = self
            .entries
            .lock()
            .map_err(|_| {
                error(
                    GitErrorKind::Internal,
                    "Unable to lock Git repository cache.",
                )
            })?
            .remove(&workspace);
        if let Some(cached) = cached {
            runtime.invalidate(cached.root, GitDirtyScope::ALL);
        }
        Ok(())
    }

    pub fn invalidate_all(&self, runtime: &GitCoordinator) -> Result<(), GitErrorInfo> {
        let cached = {
            let mut entries = self.entries.lock().map_err(|_| {
                error(
                    GitErrorKind::Internal,
                    "Unable to lock Git repository cache.",
                )
            })?;
            std::mem::take(&mut *entries)
        };
        for repository in cached.into_values() {
            runtime.invalidate(repository.root, GitDirtyScope::ALL);
        }
        Ok(())
    }
}

struct DiscoveredRepository {
    root: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
}

fn discover_repository(
    workspace: &Path,
    runtime: &GitCoordinator,
    request: &RequestHandle,
) -> Result<DiscoveredRepository, GitErrorInfo> {
    let mut spec = GitCommandSpec::read(
        workspace,
        [
            "rev-parse",
            "--path-format=absolute",
            "--show-toplevel",
            "--absolute-git-dir",
            "--git-common-dir",
        ]
        .into_iter()
        .map(OsString::from)
        .collect(),
    );
    // Discovery must observe the current `.git` structure even when a prior
    // rev-parse command is still in the Git read cache.
    spec.timeout = crate::git_runtime::DEFAULT_READ_TIMEOUT;
    spec.stdout_limit = 16 * 1024;
    spec.stderr_limit = 64 * 1024;
    let output = runtime
        .execute(spec, &request.token())
        .map_err(|error| error.info())?
        .into_success()
        .map_err(|error| error.info())?;
    let fields: Vec<&[u8]> = output
        .stdout
        .split(|byte| *byte == b'\n')
        .map(|line| line.strip_suffix(b"\r").unwrap_or(line))
        .filter(|line| !line.is_empty())
        .collect();
    if fields.len() < 3 {
        return Err(error(
            GitErrorKind::NotRepository,
            "Git did not return the worktree and administrative directory paths.",
        ));
    }
    let root = canonical_or_original(&path_from_bytes(fields[0]));
    let git_dir = canonical_or_original(&path_from_bytes(fields[1]));
    let common_dir = canonical_or_original(&path_from_bytes(fields[2]));
    if filesystem_repository_root(workspace).as_deref() != Some(root.as_path()) {
        return Err(error(
            GitErrorKind::Failed,
            "Git repository structure changed during discovery; retry the operation.",
        ));
    }
    Ok(DiscoveredRepository {
        root,
        git_dir,
        common_dir,
    })
}

fn capture_identity(
    workspace: &Path,
    root: &Path,
    git_dir: PathBuf,
    common_dir: PathBuf,
) -> Result<RepositoryIdentity, GitErrorInfo> {
    let root = canonical_or_original(root);
    let git_entry_path = root.join(".git");
    let git_entry = marker_identity(&git_entry_path)?;
    let git_dir_marker = marker_identity(&git_dir)?;
    let common_dir_marker = marker_identity(&common_dir)?;
    if filesystem_repository_root(workspace).as_deref() != Some(root.as_path()) {
        return Err(error(
            GitErrorKind::Failed,
            "Git repository structure changed while identifying the worktree; retry the operation.",
        ));
    }
    Ok(RepositoryIdentity {
        worktree_root: root,
        git_dir,
        common_dir,
        git_entry,
        git_dir_marker,
        common_dir_marker,
    })
}

fn identity_is_current(workspace: &Path, cached: &ResolvedGitRepository) -> bool {
    if filesystem_repository_root(workspace).as_deref() != Some(cached.root.as_path()) {
        return false;
    }
    capture_identity(
        workspace,
        &cached.root,
        cached.identity.git_dir.clone(),
        cached.identity.common_dir.clone(),
    )
    .is_ok_and(|current| current.identity_eq(&cached.identity))
}

impl RepositoryIdentity {
    fn identity_eq(&self, other: &Self) -> bool {
        self == other
    }
}

fn marker_identity(path: &Path) -> Result<PathMarkerIdentity, GitErrorInfo> {
    let metadata = fs::symlink_metadata(path).map_err(|error| GitErrorInfo {
        kind: GitErrorKind::Failed,
        message: format!(
            "Unable to inspect Git repository identity at {}. {error}",
            path.display()
        ),
        exit_code: None,
        stream: None,
        limit: None,
    })?;
    let identity = crate::path_file_identity(path, &metadata).map_err(|error| GitErrorInfo {
        kind: GitErrorKind::Failed,
        message: format!(
            "Unable to read Git repository identity at {}. {error}",
            path.display()
        ),
        exit_code: None,
        stream: None,
        limit: None,
    })?;
    // Directory mtime changes during normal ref/index updates, so directory
    // identity uses its stable filesystem ID. Worktree gitfiles also include
    // their contents so replacing the target path is detected immediately.
    let modified_nanos = if metadata.is_dir() {
        0
    } else {
        metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    };
    let gitfile_contents =
        if path.file_name().is_some_and(|name| name == ".git") && metadata.is_file() {
            Some(fs::read(path).map_err(|error| GitErrorInfo {
                kind: GitErrorKind::Failed,
                message: format!(
                    "Unable to read Git worktree marker at {}. {error}",
                    path.display()
                ),
                exit_code: None,
                stream: None,
                limit: None,
            })?)
        } else {
            None
        };
    Ok(PathMarkerIdentity {
        path: canonical_or_original(path),
        length: if metadata.is_dir() { 0 } else { metadata.len() },
        modified_nanos,
        is_file: metadata.is_file(),
        is_dir: metadata.is_dir(),
        device: identity.volume,
        file_id: identity.file,
        gitfile_contents,
    })
}

pub fn filesystem_repository_root(path: &Path) -> Option<PathBuf> {
    let mut current = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent()?.to_path_buf()
    };
    loop {
        if fs::symlink_metadata(current.join(".git")).is_ok() {
            return Some(canonical_or_original(&current));
        }
        if !current.pop() {
            return None;
        }
    }
}

fn canonical_or_original(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn path_from_bytes(bytes: &[u8]) -> PathBuf {
    #[cfg(unix)]
    {
        PathBuf::from(OsString::from_vec(bytes.to_vec()))
    }
    #[cfg(not(unix))]
    {
        PathBuf::from(String::from_utf8_lossy(bytes).into_owned())
    }
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
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(1);

    struct GitFixture {
        path: PathBuf,
    }

    impl GitFixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "pude-git-repository-test-{}-{}",
                std::process::id(),
                TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).expect("fixture directory");
            Self { path }
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
    }

    impl Drop for GitFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn request_for(path: &Path, runtime: &GitCoordinator) -> RequestHandle {
        runtime.begin_request(path, Some("git-repository-test"))
    }

    fn initialize_repository(path: &Path) {
        let output = Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(path)
            .output()
            .expect("git init");
        assert!(
            output.status.success(),
            "git init: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let output = Command::new("git")
            .args(["config", "user.name", "Repository Test"])
            .current_dir(path)
            .output()
            .expect("git config");
        assert!(output.status.success());
        let output = Command::new("git")
            .args(["config", "user.email", "repository@example.test"])
            .current_dir(path)
            .output()
            .expect("git config");
        assert!(output.status.success());
    }

    #[test]
    fn nested_git_init_invalidates_parent_repository_cache() {
        let fixture = GitFixture::new();
        initialize_repository(&fixture.path);
        let workspace = fixture.path.join("workspace");
        fs::create_dir(&workspace).expect("workspace");
        let cache = RepositoryRootCache::default();
        let runtime = GitCoordinator::new();
        let first_request = request_for(&workspace, &runtime);
        let first = cache
            .resolve(&workspace, &runtime, &first_request)
            .expect("parent repository discovery");
        assert_eq!(
            first.root,
            fixture.path.canonicalize().expect("canonical root")
        );

        initialize_repository(&workspace);
        assert_eq!(
            cache.resource_key(&workspace),
            workspace.canonicalize().expect("canonical workspace")
        );
        let second_request = request_for(&workspace, &runtime);
        let second = cache
            .resolve(&workspace, &runtime, &second_request)
            .expect("nested repository discovery");
        assert_eq!(
            second.root,
            workspace.canonicalize().expect("canonical nested root")
        );
        assert_ne!(first.identity, second.identity);
    }

    #[test]
    fn replacing_git_directory_changes_repository_identity() {
        let fixture = GitFixture::new();
        initialize_repository(&fixture.path);
        let cache = RepositoryRootCache::default();
        let runtime = GitCoordinator::new();
        let first = cache
            .resolve(
                &fixture.path,
                &runtime,
                &request_for(&fixture.path, &runtime),
            )
            .expect("initial discovery");

        fs::rename(fixture.path.join(".git"), fixture.path.join(".git-old"))
            .expect("move old administrative directory");
        initialize_repository(&fixture.path);
        let second = cache
            .resolve(
                &fixture.path,
                &runtime,
                &request_for(&fixture.path, &runtime),
            )
            .expect("rediscovery after git init");
        assert_eq!(first.root, second.root);
        assert_ne!(first.identity, second.identity);
    }

    #[test]
    fn a_worktree_gitfile_is_part_of_the_repository_identity() {
        let fixture = GitFixture::new();
        initialize_repository(&fixture.path);
        fs::write(fixture.path.join("tracked.txt"), "root\n").expect("tracked file");
        fixture.git(&["add", "tracked.txt"]);
        fixture.git(&["commit", "--quiet", "-m", "root"]);
        let worktree = fixture.path.join("linked-worktree");
        fixture.git(&[
            "worktree",
            "add",
            "--quiet",
            "-b",
            "linked",
            worktree.to_str().expect("UTF-8 temp path"),
        ]);

        let cache = RepositoryRootCache::default();
        let runtime = GitCoordinator::new();
        let resolved = cache
            .resolve(&worktree, &runtime, &request_for(&worktree, &runtime))
            .expect("linked worktree discovery");
        assert_eq!(
            resolved.root,
            worktree.canonicalize().expect("canonical worktree")
        );
        let common_worktree_dir = fixture
            .path
            .join(".git/worktrees")
            .canonicalize()
            .expect("canonical common worktree directory");
        assert!(resolved.identity.git_dir.starts_with(common_worktree_dir));
        assert!(worktree.join(".git").is_file());
        assert_eq!(cache.resource_key(&worktree), resolved.root);
    }

    #[test]
    fn cached_workspace_detects_transition_from_git_directory_to_worktree_gitfile() {
        let fixture = GitFixture::new();
        initialize_repository(&fixture.path);
        fs::write(fixture.path.join("root.txt"), "root\n").expect("root file");
        fixture.git(&["add", "root.txt"]);
        fixture.git(&["commit", "--quiet", "-m", "root"]);

        let workspace = fixture.path.join("workspace");
        fs::create_dir(&workspace).expect("standalone workspace");
        initialize_repository(&workspace);
        fs::write(workspace.join("local.txt"), "standalone\n").expect("local file");
        fixture.git(&[
            "-C",
            workspace.to_str().expect("UTF-8 workspace path"),
            "add",
            "local.txt",
        ]);
        fixture.git(&[
            "-C",
            workspace.to_str().expect("UTF-8 workspace path"),
            "commit",
            "--quiet",
            "-m",
            "standalone",
        ]);

        let cache = RepositoryRootCache::default();
        let runtime = GitCoordinator::new();
        let first = cache
            .resolve(&workspace, &runtime, &request_for(&workspace, &runtime))
            .expect("standalone repository discovery");
        assert!(workspace.join(".git").is_dir());

        let linked = fixture.path.join("linked");
        fixture.git(&[
            "worktree",
            "add",
            "--quiet",
            "-b",
            "linked",
            linked.to_str().expect("UTF-8 linked path"),
        ]);
        let old_workspace = fixture.path.join("workspace-old");
        fs::rename(&workspace, &old_workspace).expect("move standalone repository aside");
        fixture.git(&[
            "worktree",
            "move",
            linked.to_str().expect("UTF-8 linked path"),
            workspace.to_str().expect("UTF-8 workspace path"),
        ]);

        let second = cache
            .resolve(&workspace, &runtime, &request_for(&workspace, &runtime))
            .expect("worktree discovery after `.git` changes into a gitfile");
        assert_eq!(
            second.root,
            workspace.canonicalize().expect("canonical worktree root")
        );
        assert_ne!(first.identity, second.identity);
        assert!(workspace.join(".git").is_file());
        let expected_git_dir = fixture
            .path
            .join(".git/worktrees")
            .canonicalize()
            .expect("canonical worktree administration directory");
        assert!(second.identity.git_dir.starts_with(expected_git_dir));
    }

    #[test]
    fn a_repository_created_after_first_lookup_is_discovered() {
        let fixture = GitFixture::new();
        let cache = RepositoryRootCache::default();
        let runtime = GitCoordinator::new();
        let first_error = cache
            .resolve(
                &fixture.path,
                &runtime,
                &request_for(&fixture.path, &runtime),
            )
            .expect_err("workspace initially has no repository");
        assert_eq!(first_error.kind, GitErrorKind::NotRepository);

        initialize_repository(&fixture.path);
        let resolved = cache
            .resolve(
                &fixture.path,
                &runtime,
                &request_for(&fixture.path, &runtime),
            )
            .expect("repository created after the initial lookup");
        assert_eq!(
            resolved.root,
            fixture.path.canonicalize().expect("canonical root")
        );
    }
}
