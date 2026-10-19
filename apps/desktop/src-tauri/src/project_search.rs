use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::blocking::BlockingClass;
use crate::git_repository::RepositoryRootCache;
use crate::git_runtime::{
    CancellationToken, GitCommandSpec, GitCoordinator, GitErrorKind, RequestHandle,
};
use crate::{checked_wire_path, decode_wire_path, run_blocking, AppState, QuitGateState};

const MAX_RESULTS: usize = 300;
const MAX_ENTRIES: usize = 50_000;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 100 * 1024 * 1024;
const SEARCH_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SearchMode {
    Content,
    Files,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchOptions {
    query: String,
    mode: SearchMode,
    case_sensitive: bool,
    include_ignored: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchMatch {
    path: String,
    relative_path: String,
    line: Option<usize>,
    preview: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchResults {
    matches: Vec<SearchMatch>,
    truncated: bool,
    skipped_files: usize,
}

type ActiveSearches = HashMap<String, (String, CancellationToken)>;
static SEARCHES: OnceLock<Mutex<ActiveSearches>> = OnceLock::new();
fn searches() -> &'static Mutex<ActiveSearches> {
    SEARCHES.get_or_init(Mutex::default)
}

struct SearchRegistration {
    window: String,
    id: String,
}
impl Drop for SearchRegistration {
    fn drop(&mut self) {
        if let Ok(mut searches) = searches().lock() {
            if searches
                .get(&self.window)
                .is_some_and(|(id, _)| id == &self.id)
            {
                searches.remove(&self.window);
            }
        }
    }
}

#[tauri::command]
pub(crate) fn cancel_project_search<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    request_id: String,
) {
    if let Ok(searches) = searches().lock() {
        if let Some((id, token)) = searches.get(window.label()) {
            if id == &request_id {
                token.cancel();
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn search_project<R: tauri::Runtime>(
    workspace: String,
    options: SearchOptions,
    request_id: String,
    window: tauri::WebviewWindow<R>,
    state: State<'_, AppState>,
    quit_gate: State<'_, QuitGateState>,
) -> Result<SearchResults, String> {
    let admission = quit_gate.admit_resource_operation(window.label())?;
    if options.query.is_empty() || options.query.len() > 4096 {
        return Err("Enter a search query of at most 4,096 bytes.".into());
    }
    let runtime = state.git_runtime.clone();
    let roots = Arc::clone(&state.git_repository_roots);
    let request = runtime.begin_request(decode_wire_path(&workspace), Some(window.label()));
    let token = request.token();
    let registration = SearchRegistration {
        window: window.label().into(),
        id: request_id.clone(),
    };
    if let Some((_, previous)) = searches()
        .lock()
        .map_err(|_| "Unable to start project search.")?
        .insert(window.label().into(), (request_id, token.clone()))
    {
        previous.cancel();
    }
    run_blocking("Unable to search project", BlockingClass::Misc, move || {
        let _admission = admission;
        let _registration = registration;
        search_project_sync(&workspace, &options, &runtime, &roots, &request)
    })
    .await
}

fn search_project_sync(
    workspace: &str,
    options: &SearchOptions,
    runtime: &GitCoordinator,
    roots: &RepositoryRootCache,
    request: &RequestHandle,
) -> Result<SearchResults, String> {
    let token = request.token();
    let root = fs::canonicalize(decode_wire_path(&workspace))
        .map_err(|error| format!("Unable to open project. {error}"))?;
    if !root.is_dir() {
        return Err("The project directory is no longer available.".into());
    }
    let started = Instant::now();
    let mut result = SearchResults::default();
    let paths = if options.include_ignored {
        collect_files(&root, &token, started, &mut result)?
    } else {
        match roots.resolve(&root, &runtime, &request) {
            Ok(_) => {
                let mut spec = GitCommandSpec::read(
                    &root,
                    vec![
                        "ls-files".into(),
                        "--cached".into(),
                        "--others".into(),
                        "--exclude-standard".into(),
                        "-z".into(),
                        "--".into(),
                        ".".into(),
                    ],
                );
                spec.timeout = SEARCH_TIMEOUT;
                spec.stdout_limit = 8 * 1024 * 1024;
                spec.stderr_limit = 64 * 1024;
                let output = runtime
                    .execute(spec, &token)
                    .and_then(|output| output.into_success())
                    .map_err(|error| error.info().message)?;
                let mut seen = HashSet::new();
                let mut paths = Vec::new();
                for path in output
                    .stdout
                    .split(|byte| *byte == 0)
                    .filter(|path| !path.is_empty())
                {
                    #[cfg(unix)]
                    let path = {
                        use std::os::unix::ffi::OsStringExt;
                        PathBuf::from(std::ffi::OsString::from_vec(path.to_vec()))
                    };
                    #[cfg(not(unix))]
                    let path = PathBuf::from(String::from_utf8_lossy(path).into_owned());
                    if seen.insert(path.clone()) {
                        paths.push(root.join(path));
                    }
                    if paths.len() >= MAX_ENTRIES {
                        result.truncated = true;
                        break;
                    }
                }
                paths
            }
            Err(error) if error.kind == GitErrorKind::NotRepository => {
                collect_files(&root, &token, started, &mut result)?
            }
            Err(error) => return Err(error.message),
        }
    };
    search_files(&root, paths, options, &token, started, &mut result)?;
    Ok(result)
}

fn check_cancelled(token: &CancellationToken) -> Result<(), String> {
    if token.is_cancelled() {
        Err("Project search cancelled.".into())
    } else {
        Ok(())
    }
}

fn collect_files(
    root: &Path,
    token: &CancellationToken,
    started: Instant,
    result: &mut SearchResults,
) -> Result<Vec<PathBuf>, String> {
    let mut pending = vec![root.to_path_buf()];
    let mut files = Vec::new();
    let mut scanned = 0;
    while let Some(directory) = pending.pop() {
        check_cancelled(token)?;
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(_) => {
                result.skipped_files += 1;
                continue;
            }
        };
        for entry in entries {
            check_cancelled(token)?;
            scanned += 1;
            if scanned > MAX_ENTRIES || started.elapsed() >= SEARCH_TIMEOUT {
                result.truncated = true;
                return Ok(files);
            }
            let Ok(entry) = entry else {
                result.skipped_files += 1;
                continue;
            };
            if entry.file_name() == ".git" {
                continue;
            }
            let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
                result.skipped_files += 1;
                continue;
            };
            if metadata.file_type().is_symlink() || crate::is_windows_reparse_point(&metadata) {
                continue;
            }
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                files.push(entry.path());
            }
        }
    }
    files.sort();
    Ok(files)
}

fn search_files(
    root: &Path,
    paths: Vec<PathBuf>,
    options: &SearchOptions,
    token: &CancellationToken,
    started: Instant,
    result: &mut SearchResults,
) -> Result<(), String> {
    let needle = if options.case_sensitive {
        options.query.clone()
    } else {
        options.query.to_lowercase()
    };
    let mut total_bytes = 0;
    for path in paths {
        check_cancelled(token)?;
        if started.elapsed() >= SEARCH_TIMEOUT || total_bytes >= MAX_TOTAL_BYTES {
            result.truncated = true;
            break;
        }
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            result.skipped_files += 1;
            continue;
        };
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || crate::is_windows_reparse_point(&metadata)
        {
            continue;
        }
        // A tracked path can contain a symlinked parent. Keep reads inside the selected project.
        let Ok(canonical) = fs::canonicalize(&path) else {
            result.skipped_files += 1;
            continue;
        };
        if !canonical.starts_with(root) {
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let relative_path = checked_wire_path(relative)?;
        let matches = |text: &str| {
            if options.case_sensitive {
                text.contains(&needle)
            } else {
                text.to_lowercase().contains(&needle)
            }
        };
        if matches!(options.mode, SearchMode::Files) {
            if matches(&relative_path) {
                result.matches.push(SearchMatch {
                    path: checked_wire_path(&path)?,
                    relative_path,
                    line: None,
                    preview: None,
                });
            }
        } else {
            if metadata.len() > MAX_FILE_BYTES {
                result.skipped_files += 1;
                continue;
            }
            let bytes = match crate::read_file_with_metadata(&path, MAX_FILE_BYTES) {
                Ok((bytes, _, _)) => bytes,
                Err(_) => {
                    result.skipped_files += 1;
                    continue;
                }
            };
            total_bytes += bytes.len() as u64;
            let Ok(text) = std::str::from_utf8(&bytes) else {
                result.skipped_files += 1;
                continue;
            };
            if bytes.contains(&0) {
                result.skipped_files += 1;
                continue;
            }
            for (index, line) in text.lines().enumerate() {
                check_cancelled(token)?;
                if !matches(line) {
                    continue;
                }
                let folded = if options.case_sensitive {
                    line.to_string()
                } else {
                    line.to_lowercase()
                };
                let offset = folded.find(&needle).unwrap_or(0).saturating_sub(80);
                let start = line
                    .char_indices()
                    .find(|(index, _)| *index >= offset)
                    .map(|(index, _)| index)
                    .unwrap_or(0);
                let snippet: String = line[start..].chars().take(240).collect();
                let preview = format!(
                    "{}{}{}",
                    if start > 0 { "…" } else { "" },
                    snippet,
                    if start + snippet.len() < line.len() {
                        "…"
                    } else {
                        ""
                    }
                );
                result.matches.push(SearchMatch {
                    path: checked_wire_path(&path)?,
                    relative_path: relative_path.clone(),
                    line: Some(index + 1),
                    preview: Some(preview),
                });
                if result.matches.len() >= MAX_RESULTS {
                    result.truncated = true;
                    return Ok(());
                }
            }
        }
        if result.matches.len() >= MAX_RESULTS {
            result.truncated = true;
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    struct Project(PathBuf);
    impl Project {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("pude-search-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(path.join("nested")).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
        fn search(
            &self,
            query: &str,
            mode: SearchMode,
            case_sensitive: bool,
            include_ignored: bool,
        ) -> SearchResults {
            let runtime = GitCoordinator::new();
            let roots = RepositoryRootCache::default();
            let request = runtime.begin_request(&self.0, None);
            search_project_sync(
                self.0.to_str().unwrap(),
                &SearchOptions {
                    query: query.into(),
                    mode,
                    case_sensitive,
                    include_ignored,
                },
                &runtime,
                &roots,
                &request,
            )
            .unwrap()
        }
    }
    impl Drop for Project {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn finds_nested_text_with_unicode_crlf_and_case_matching() {
        let project = Project::new();
        fs::write(
            project.0.join("nested/readme.md"),
            "First\r\n繁體中文 PuDe\r\nlast\r\n",
        )
        .unwrap();
        let result = project.search("pude", SearchMode::Content, false, true);
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].line, Some(2));
        assert_eq!(result.matches[0].relative_path, "nested/readme.md");
        assert!(result.matches[0]
            .preview
            .as_ref()
            .unwrap()
            .contains("繁體中文"));
        assert!(project
            .search("pude", SearchMode::Content, true, true)
            .matches
            .is_empty());
        assert_eq!(
            project
                .search("中文", SearchMode::Content, true, true)
                .matches
                .len(),
            1
        );
        assert_eq!(
            project
                .search("NESTED/README", SearchMode::Files, false, true)
                .matches
                .len(),
            1
        );
    }

    #[test]
    fn respects_gitignore_and_searches_ignored_files_when_requested() {
        let project = Project::new();
        assert!(Command::new("git")
            .args(["init", "--quiet"])
            .arg(&project.0)
            .status()
            .unwrap()
            .success());
        fs::write(project.0.join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(project.0.join("ignored.txt"), "needle").unwrap();
        fs::write(project.0.join("nested/visible.txt"), "needle").unwrap();
        let result = project.search("needle", SearchMode::Content, true, false);
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].relative_path, "nested/visible.txt");
        assert_eq!(
            project
                .search("needle", SearchMode::Content, true, true)
                .matches
                .len(),
            2
        );
        // A project opened below the repository root stays scoped to that folder.
        let nested = Project(project.0.join("nested"));
        assert_eq!(
            nested
                .search("needle", SearchMode::Content, true, false)
                .matches[0]
                .relative_path,
            "visible.txt"
        );
    }

    #[test]
    fn skips_binary_and_large_content_but_still_finds_their_names() {
        let project = Project::new();
        fs::write(project.0.join("binary.dat"), b"needle\0binary").unwrap();
        let large = fs::File::create(project.0.join("large.log")).unwrap();
        large.set_len(MAX_FILE_BYTES + 1).unwrap();
        let result = project.search("needle", SearchMode::Content, false, true);
        assert!(result.matches.is_empty());
        assert_eq!(result.skipped_files, 2);
        assert_eq!(
            project
                .search("large.log", SearchMode::Files, false, true)
                .matches
                .len(),
            1
        );
    }

    #[test]
    fn caps_results_and_honors_cancellation() {
        let project = Project::new();
        fs::write(
            project.0.join("many.txt"),
            "needle\n".repeat(MAX_RESULTS + 10),
        )
        .unwrap();
        let result = project.search("needle", SearchMode::Content, true, true);
        assert_eq!(result.matches.len(), MAX_RESULTS);
        assert!(result.truncated);
        let token = CancellationToken::new();
        token.cancel();
        assert!(collect_files(
            &project.0,
            &token,
            Instant::now(),
            &mut SearchResults::default()
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinks_outside_the_project() {
        use std::os::unix::fs::symlink;
        let project = Project::new();
        let outside = Project::new();
        fs::write(outside.0.join("secret.txt"), "needle").unwrap();
        symlink(&outside.0, project.0.join("linked")).unwrap();
        symlink(outside.0.join("secret.txt"), project.0.join("secret.txt")).unwrap();
        assert!(project
            .search("needle", SearchMode::Content, true, true)
            .matches
            .is_empty());
    }
}
