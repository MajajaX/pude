use crate::git_runtime::{
    GitCommandOutput, GitCommandSpec, GitCoordinator, GitErrorInfo, GitReadKind, GitReadRequest,
    RequestHandle, DEFAULT_STDERR_LIMIT,
};
use std::ffi::OsString;
use std::path::Path;

pub const INITIAL_DIFF_CONTEXT_LINES: usize = 3;
pub const MAX_DIFF_CONTEXT_LINES: usize = 100;
pub const MAX_DIFF_STDOUT_BYTES: usize = 2 * 1024 * 1024;

/// Build a Git diff query with explicit, bounded context for every mode.
/// `untracked` selects `--no-index` against the platform's null device.
pub fn diff_args(
    file_path: &Path,
    staged: bool,
    untracked: bool,
    context_lines: usize,
) -> Vec<OsString> {
    let context_lines = context_lines.min(MAX_DIFF_CONTEXT_LINES);
    let mut args = vec![OsString::from("diff")];
    if untracked {
        args.push(OsString::from("--no-index"));
    }
    args.push(OsString::from("--no-ext-diff"));
    args.push(OsString::from(format!("--unified={context_lines}")));
    if staged && !untracked {
        args.push(OsString::from("--cached"));
    }
    args.push(OsString::from("--"));
    if untracked {
        args.push(OsString::from(null_device_path()));
    }
    args.push(file_path.as_os_str().to_os_string());
    args
}

pub fn diff_spec(repository: &Path, args: Vec<OsString>) -> GitCommandSpec {
    let mut spec = GitCommandSpec::read(repository, args);
    spec.stdout_limit = MAX_DIFF_STDOUT_BYTES;
    spec.stderr_limit = DEFAULT_STDERR_LIMIT.min(128 * 1024);
    spec
}

/// Run a bounded staged, unstaged, or untracked diff. A native output limit is
/// returned as the structured `outputLimit` error kind, never as an empty diff.
pub fn read_git_diff(
    runtime: &GitCoordinator,
    repository: &Path,
    request: &RequestHandle,
    file_path: &Path,
    staged: bool,
    untracked: bool,
    context_lines: usize,
) -> Result<GitCommandOutput, GitErrorInfo> {
    let args = diff_args(file_path, staged, untracked, context_lines);
    let output = runtime
        .read_shared_for(
            GitReadRequest::new(repository, GitReadKind::Status, diff_spec(repository, args)),
            request,
        )
        .map_err(|error| error.info())?;
    if output.success || (untracked && output.exit_code == Some(1) && !output.stdout.is_empty()) {
        Ok(output)
    } else {
        Err(output
            .into_success()
            .expect_err("failed Git diff output")
            .info())
    }
}

pub fn read_git_commit_diff(
    runtime: &GitCoordinator,
    repository: &Path,
    request: &RequestHandle,
    commit: &str,
    file_path: &Path,
    context_lines: usize,
) -> Result<GitCommandOutput, GitErrorInfo> {
    let context_lines = context_lines.min(MAX_DIFF_CONTEXT_LINES);
    let mut spec = GitCommandSpec::read(
        repository,
        vec![
            OsString::from("show"),
            OsString::from("--no-ext-diff"),
            OsString::from(format!("--unified={context_lines}")),
            OsString::from("--format="),
            OsString::from(commit),
            OsString::from("--"),
            file_path.as_os_str().to_os_string(),
        ],
    );
    spec.stdout_limit = MAX_DIFF_STDOUT_BYTES;
    spec.stderr_limit = DEFAULT_STDERR_LIMIT.min(128 * 1024);
    let output = runtime
        .read_shared_for(
            GitReadRequest::new(repository, GitReadKind::History, spec),
            request,
        )
        .map_err(|error| error.info())?;
    output.into_success().map_err(|error| error.info())
}

pub fn next_context_lines(context_lines: usize) -> Option<usize> {
    let context_lines = context_lines.min(MAX_DIFF_CONTEXT_LINES);
    (context_lines < MAX_DIFF_CONTEXT_LINES).then_some(
        context_lines
            .saturating_mul(2)
            .max(context_lines + 1)
            .min(MAX_DIFF_CONTEXT_LINES),
    )
}

fn null_device_path() -> &'static str {
    #[cfg(windows)]
    {
        "NUL"
    }
    #[cfg(not(windows))]
    {
        "/dev/null"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_runtime::{GitCoordinator, GitErrorKind};
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(1);

    struct GitFixture {
        path: PathBuf,
        runtime: GitCoordinator,
    }

    impl GitFixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "pude-git-diff-test-{}-{}",
                std::process::id(),
                TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).expect("fixture directory");
            let fixture = Self {
                path,
                runtime: GitCoordinator::new(),
            };
            fixture.git(&["init", "--quiet"]);
            fixture.git(&["config", "user.name", "Diff Test"]);
            fixture.git(&["config", "user.email", "diff@example.test"]);
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

        fn request(&self) -> RequestHandle {
            self.runtime.begin_request(&self.path, Some("diff-test"))
        }
    }

    impl Drop for GitFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn every_diff_mode_has_explicit_small_context_and_native_byte_limit() {
        let path = Path::new("file with spaces.txt");
        for (staged, untracked) in [(true, false), (false, false), (false, true)] {
            let args = diff_args(path, staged, untracked, INITIAL_DIFF_CONTEXT_LINES);
            let args: Vec<String> = args
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            assert!(args.iter().any(|arg| arg == "--unified=3"));
            assert!(!args.iter().any(|arg| arg.contains("999999")));
            assert_eq!(
                args.iter().filter(|arg| arg.as_str() == "--cached").count(),
                usize::from(staged && !untracked)
            );
        }
        assert_eq!(
            diff_spec(Path::new("/tmp"), Vec::new()).stdout_limit,
            MAX_DIFF_STDOUT_BYTES
        );
        assert_eq!(next_context_lines(3), Some(6));
        assert_eq!(next_context_lines(80), Some(100));
        assert_eq!(next_context_lines(100), None);
    }

    #[test]
    fn twenty_mib_file_changes_at_head_middle_and_tail_return_bounded_real_hunks() {
        let fixture = GitFixture::new();
        let path = fixture.path.join("large.txt");
        let mut lines: Vec<String> = (0..250_000)
            .map(|index| format!("line-{index:06} ordinary-content-for-diff-context-1234567890-abcdefghij-abcdefghij-abcdefghij"))
            .collect();
        lines[0] = "HEAD original ordinary-content-for-diff-context-1234567890-abcdefghij-abcdefghij-abcdefghij".to_string();
        lines[124_999] = "MIDDLE original ordinary-content-for-diff-context-1234567890-abcdefghij-abcdefghij-abcdefghij".to_string();
        lines[249_999] = "TAIL original ordinary-content-for-diff-context-1234567890-abcdefghij-abcdefghij-abcdefghij".to_string();
        let content = format!("{}\n", lines.join("\n"));
        assert!(
            content.len() >= 20 * 1024 * 1024,
            "fixture should exceed 20 MiB"
        );
        fs::write(&path, content).expect("large fixture");
        fixture.git(&["add", "large.txt"]);
        fixture.git(&["commit", "--quiet", "-m", "large baseline"]);

        lines[0] = "HEAD changed ordinary-content-for-diff-context-1234567890-abcdefghij-abcdefghij-abcdefghij".to_string();
        lines[124_999] = "MIDDLE changed ordinary-content-for-diff-context-1234567890-abcdefghij-abcdefghij-abcdefghij".to_string();
        lines[249_999] = "TAIL changed ordinary-content-for-diff-context-1234567890-abcdefghij-abcdefghij-abcdefghij".to_string();
        fs::write(&path, format!("{}\n", lines.join("\n"))).expect("large changes");

        let request = fixture.request();
        let output = read_git_diff(
            &fixture.runtime,
            &fixture.path,
            &request,
            Path::new("large.txt"),
            false,
            false,
            INITIAL_DIFF_CONTEXT_LINES,
        )
        .expect("bounded large-file diff");
        let diff = output.stdout_lossy();
        assert!(diff.contains("HEAD original") && diff.contains("HEAD changed"));
        assert!(diff.contains("MIDDLE original") && diff.contains("MIDDLE changed"));
        assert!(diff.contains("TAIL original") && diff.contains("TAIL changed"));
        assert!(diff.contains("@@ -1,4 +1,4 @@"));
        assert!(diff.contains("@@ -124997,7 +124997,7 @@"));
        assert!(diff.contains("@@ -249997,4 +249997,4 @@"));
        assert!(
            output.stdout.len() < 64 * 1024,
            "context output should stay local to hunks"
        );
    }

    #[test]
    fn oversized_single_change_is_a_structured_output_limit_error() {
        let fixture = GitFixture::new();
        let path = fixture.path.join("long-line.txt");
        fs::write(&path, format!("{}\n", "a".repeat(1_100_000))).expect("long baseline");
        fixture.git(&["add", "long-line.txt"]);
        fixture.git(&["commit", "--quiet", "-m", "long baseline"]);
        fs::write(&path, format!("{}\n", "b".repeat(1_100_000))).expect("long replacement");
        let request = fixture.request();
        let error = read_git_diff(
            &fixture.runtime,
            &fixture.path,
            &request,
            Path::new("long-line.txt"),
            false,
            false,
            INITIAL_DIFF_CONTEXT_LINES,
        )
        .expect_err("long hunk exceeds output budget");
        assert_eq!(error.kind, GitErrorKind::OutputLimit);
        assert_eq!(error.stream.as_deref(), Some("stdout"));
        assert_eq!(error.limit, Some(MAX_DIFF_STDOUT_BYTES));
    }

    #[test]
    fn commit_diff_propagates_invalid_commit_and_preserves_valid_empty_diff() {
        let fixture = GitFixture::new();
        fs::write(fixture.path.join("tracked.txt"), "tracked\n").expect("tracked file");
        fixture.git(&["add", "tracked.txt"]);
        fixture.git(&["commit", "--quiet", "-m", "tracked baseline"]);
        let commit = fixture.git(&["rev-parse", "HEAD"]);

        let valid = read_git_commit_diff(
            &fixture.runtime,
            &fixture.path,
            &fixture.request(),
            &commit,
            Path::new("missing.txt"),
            INITIAL_DIFF_CONTEXT_LINES,
        )
        .expect("a valid commit with no matching path has an empty diff");
        assert!(valid.success);
        assert!(valid.stdout.is_empty());

        let invalid_commit = "0000000000000000000000000000000000000000";
        let error = read_git_commit_diff(
            &fixture.runtime,
            &fixture.path,
            &fixture.request(),
            invalid_commit,
            Path::new("tracked.txt"),
            INITIAL_DIFF_CONTEXT_LINES,
        )
        .expect_err("Git must reject an unknown commit");
        assert_eq!(error.kind, GitErrorKind::Failed);
        assert!(error.message.contains("bad object") || error.message.contains("unknown revision"));
    }
}
