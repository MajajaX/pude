//! Recent folders and workspaces shown when the user right-clicks pude in the
//! macOS Dock or the Windows taskbar, and the routing that opens them.
//!
//! Choosing a recent item opens it as a new project tab in the last focused
//! window. Only when no window exists does it open a new window.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::{checked_wire_path, create_editor_window, decode_wire_path, workspace_file};

/// Command-line flag: open the following folder or workspace file in the last focused window.
pub(crate) const REUSE_WINDOW_ARG: &str = "--reuse-window";
/// Command-line flag: open an empty window.
pub(crate) const NEW_WINDOW_ARG: &str = "--new-window";
pub(crate) const OPEN_RECENT_EVENT: &str = "open-recent-path";
const MAX_RECENT_ITEMS: usize = 8;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct RecentItems {
    pub(crate) folders: Vec<String>,
    pub(crate) workspaces: Vec<String>,
    pub(crate) labels: MenuLabels,
}

/// Menu text in the interface language, supplied by the renderer.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MenuLabels {
    pub(crate) new_window: String,
    pub(crate) new_window_description: String,
    pub(crate) recent_folders: String,
    pub(crate) recent_workspaces: String,
}

impl Default for MenuLabels {
    fn default() -> Self {
        Self {
            new_window: "New Window".into(),
            new_window_description: "Open a new pude window".into(),
            recent_folders: "Recent Folders".into(),
            recent_workspaces: "Recent Workspaces".into(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenRecentPayload {
    window_label: String,
    path: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LaunchRequest {
    /// No arguments: show the app as before.
    Default,
    NewWindow,
    /// A folder or `.pdw` file; `in_existing_window` adds a project tab to the last focused window.
    Open {
        path: String,
        in_existing_window: bool,
    },
}

static RECENT_ITEMS: Mutex<Option<RecentItems>> = Mutex::new(None);
static LAST_FOCUSED_WINDOW: Mutex<Option<String>> = Mutex::new(None);

#[cfg(target_os = "macos")]
pub(crate) fn recent_items() -> RecentItems {
    RECENT_ITEMS
        .lock()
        .ok()
        .and_then(|items| items.clone())
        .unwrap_or_default()
}

pub(crate) fn remember_focused_window(label: &str) {
    if let Ok(mut focused) = LAST_FOCUSED_WINDOW.lock() {
        *focused = Some(label.to_string());
    }
}

/// The renderer reports its recent lists whenever they change; every window
/// shares the same lists, so the latest report wins.
#[tauri::command(async)]
pub(crate) fn set_recent_items(
    folders: Vec<String>,
    workspaces: Vec<String>,
    labels: Option<MenuLabels>,
) {
    let items = RecentItems {
        folders: folders.into_iter().take(MAX_RECENT_ITEMS).collect(),
        workspaces: workspaces.into_iter().take(MAX_RECENT_ITEMS).collect(),
        labels: labels.unwrap_or_default(),
    };
    let Ok(mut current) = RECENT_ITEMS.lock() else {
        return;
    };
    if current.as_ref() == Some(&items) {
        return;
    }
    *current = Some(items.clone());
    drop(current);
    #[cfg(windows)]
    crate::jump_list::update(items);
    #[cfg(not(windows))]
    let _ = items;
}

/// Open a folder or workspace file as a project tab in the last focused
/// window, bringing that window forward. Falls back to a new window.
pub(crate) fn open_in_existing_window(app: &AppHandle, path: &str) {
    let focused = LAST_FOCUSED_WINDOW
        .lock()
        .ok()
        .and_then(|label| label.clone());
    let window = focused
        .and_then(|label| app.get_webview_window(&label))
        .or_else(|| app.webview_windows().into_values().next());
    let Some(window) = window else {
        if let Err(error) = create_editor_window(app, Some(path)) {
            crate::app_log::log_error(&error);
        }
        return;
    };
    let payload = OpenRecentPayload {
        window_label: window.label().to_string(),
        path: path.to_string(),
    };
    if let Err(error) = app.emit(OPEN_RECENT_EVENT, payload) {
        crate::app_log::log_error(&format!("Unable to open a recent item: {error}"));
    }
    #[cfg(target_os = "macos")]
    let _ = app.show();
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Parse the arguments of a launch: `pude`, `pude --new-window`,
/// `pude --reuse-window <path>` or `pude <path>`. Relative paths resolve
/// against `cwd`.
pub(crate) fn parse_launch_request(args: &[String], cwd: &Path) -> Result<LaunchRequest, String> {
    match args.get(1).map(String::as_str) {
        None => Ok(LaunchRequest::Default),
        Some(NEW_WINDOW_ARG) => Ok(LaunchRequest::NewWindow),
        Some(REUSE_WINDOW_ARG) => {
            let argument = args
                .get(2)
                .ok_or("Add a folder or workspace file after --reuse-window.")?;
            Ok(LaunchRequest::Open {
                path: launch_path(argument, cwd)?,
                in_existing_window: true,
            })
        }
        Some(argument) => Ok(LaunchRequest::Open {
            path: launch_path(argument, cwd)?,
            in_existing_window: false,
        }),
    }
}

fn launch_path(argument: &str, cwd: &Path) -> Result<String, String> {
    let path = PathBuf::from(argument);
    let path = if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    };
    checked_wire_path(&existing_launch_path(&path)?)
}

/// A folder, or a `.pdw` workspace file, that exists.
pub(crate) fn existing_launch_path(path: &Path) -> Result<PathBuf, String> {
    let path = std::fs::canonicalize(path)
        .map_err(|error| format!("Unable to open {}. {error}", path.display()))?;
    if path.is_dir() || (path.is_file() && workspace_file::is_workspace_file_path(&path)) {
        Ok(path)
    } else {
        Err("Open a folder or a pude workspace file (.pdw).".to_string())
    }
}

/// Wire path of an existing folder or workspace file, for window URLs.
pub(crate) fn checked_launch_path(value: &str) -> Result<String, String> {
    checked_wire_path(&existing_launch_path(&decode_wire_path(value))?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn parses_window_flags_and_paths() {
        let root = std::env::temp_dir().join(format!("pude-launch-{}", uuid::Uuid::new_v4()));
        let folder = root.join("project 資料夾");
        fs::create_dir_all(&folder).unwrap();
        let workspace = root.join("team.pdw");
        fs::write(&workspace, "{}").unwrap();
        fs::write(root.join("notes.txt"), "").unwrap();
        let args = |values: &[&str]| -> Vec<String> {
            std::iter::once("pude")
                .chain(values.iter().copied())
                .map(String::from)
                .collect()
        };
        let canonical = |path: &Path| checked_wire_path(&fs::canonicalize(path).unwrap()).unwrap();

        assert_eq!(
            parse_launch_request(&args(&[]), &root),
            Ok(LaunchRequest::Default)
        );
        assert_eq!(
            parse_launch_request(&args(&["--new-window"]), &root),
            Ok(LaunchRequest::NewWindow)
        );
        assert_eq!(
            parse_launch_request(&args(&["--reuse-window", "project 資料夾"]), &root),
            Ok(LaunchRequest::Open {
                path: canonical(&folder),
                in_existing_window: true
            })
        );
        assert_eq!(
            parse_launch_request(&args(&["team.pdw"]), &root),
            Ok(LaunchRequest::Open {
                path: canonical(&workspace),
                in_existing_window: false
            })
        );
        assert!(parse_launch_request(&args(&["--reuse-window"]), &root).is_err());
        assert!(parse_launch_request(&args(&["notes.txt"]), &root).is_err());
        assert!(parse_launch_request(&args(&["missing"]), &root).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
