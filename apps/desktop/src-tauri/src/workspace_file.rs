//! pude workspace files (`.pdw`): a small JSON list of folders that open
//! together in one project tab. Folder paths are stored relative to the
//! workspace file when they share a parent folder, so a workspace checked into
//! a repository keeps working from another clone location.

use std::fs;
use std::path::{Component, Path, PathBuf};

use rfd::FileDialog;
use serde::{Deserialize, Serialize};

use crate::{
    checked_wire_path, decode_wire_path, format_atomic_save_error, inspect_atomic_save_target,
    read_file_with_metadata, save_file_atomically,
};

pub(crate) const WORKSPACE_FILE_EXTENSION: &str = "pdw";
const MAX_WORKSPACE_FILE_BYTES: u64 = 256 * 1024;
const MAX_WORKSPACE_FOLDERS: usize = 64;

#[derive(Debug, Deserialize, Serialize)]
struct WorkspaceFileContent {
    version: u32,
    folders: Vec<WorkspaceFolderEntry>,
}

#[derive(Debug, Deserialize, Serialize)]
struct WorkspaceFolderEntry {
    path: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceFile {
    path: String,
    name: String,
    /// Existing folders in file order, as canonical wire paths.
    folders: Vec<String>,
    /// Folders listed in the file that no longer exist.
    missing: Vec<String>,
}

pub(crate) fn is_workspace_file_path(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case(WORKSPACE_FILE_EXTENSION))
}

#[tauri::command]
pub(crate) async fn open_workspace_file_dialog() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        FileDialog::new()
            .add_filter("pude workspace", &[WORKSPACE_FILE_EXTENSION])
            .pick_file()
            .and_then(|path| checked_wire_path(&path).ok())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub(crate) async fn save_workspace_file_dialog(default_name: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        FileDialog::new()
            .add_filter("pude workspace", &[WORKSPACE_FILE_EXTENSION])
            .set_file_name(&default_name)
            .save_file()
            .map(|path| {
                if is_workspace_file_path(&path) {
                    path
                } else {
                    path.with_extension(WORKSPACE_FILE_EXTENSION)
                }
            })
            .and_then(|path| checked_wire_path(&path).ok())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command(async)]
pub(crate) fn read_workspace_file(path: String) -> Result<WorkspaceFile, String> {
    read_workspace_file_sync(&decode_wire_path(&path))
}

#[tauri::command(async)]
pub(crate) fn write_workspace_file(path: String, folders: Vec<String>) -> Result<(), String> {
    write_workspace_file_sync(&decode_wire_path(&path), &folders)
}

pub(crate) fn read_workspace_file_sync(path: &Path) -> Result<WorkspaceFile, String> {
    if !is_workspace_file_path(path) {
        return Err("Choose a pude workspace file (.pdw).".into());
    }
    let path = fs::canonicalize(path)
        .map_err(|error| format!("Unable to open the workspace file. {error}"))?;
    let (bytes, _, _) = read_file_with_metadata(&path, MAX_WORKSPACE_FILE_BYTES)
        .map_err(|_| "Unable to read the workspace file.".to_string())?;
    let content: WorkspaceFileContent = serde_json::from_slice(&bytes)
        .map_err(|error| format!("The workspace file is not valid. {error}"))?;
    if content.version != 1 {
        return Err("This workspace file was made by a newer version of pude.".into());
    }
    if content.folders.is_empty() || content.folders.len() > MAX_WORKSPACE_FOLDERS {
        return Err(format!(
            "A workspace file must list between 1 and {MAX_WORKSPACE_FOLDERS} folders."
        ));
    }
    let base = path.parent().unwrap_or_else(|| Path::new("/"));
    let mut folders = Vec::new();
    let mut missing = Vec::new();
    for entry in content.folders {
        let folder = resolve_folder(base, &entry.path);
        match fs::canonicalize(&folder) {
            Ok(folder) if folder.is_dir() => {
                let folder = checked_wire_path(&folder)?;
                if !folders.contains(&folder) {
                    folders.push(folder);
                }
            }
            _ => missing.push(folder.to_string_lossy().into_owned()),
        }
    }
    Ok(WorkspaceFile {
        path: checked_wire_path(&path)?,
        name: workspace_name(&path),
        folders,
        missing,
    })
}

pub(crate) fn write_workspace_file_sync(path: &Path, folders: &[String]) -> Result<(), String> {
    if !is_workspace_file_path(path) {
        return Err("Workspace files must use the .pdw extension.".into());
    }
    if folders.is_empty() || folders.len() > MAX_WORKSPACE_FOLDERS {
        return Err(format!(
            "A workspace must contain between 1 and {MAX_WORKSPACE_FOLDERS} folders."
        ));
    }
    let base = path
        .parent()
        .and_then(|parent| fs::canonicalize(parent).ok())
        .ok_or("The folder for the workspace file is unavailable.")?;
    let folders = folders
        .iter()
        .map(|folder| {
            let folder = decode_wire_path(folder);
            let stored = relative_folder_path(&base, &folder).unwrap_or(folder);
            stored
                .to_str()
                .map(|path| WorkspaceFolderEntry {
                    path: path.to_string(),
                })
                .ok_or_else(|| {
                    "Folder paths that are not valid UTF-8 cannot be saved in a workspace file."
                        .to_string()
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut json = serde_json::to_vec_pretty(&WorkspaceFileContent {
        version: 1,
        folders,
    })
    .map_err(|error| format!("Unable to save the workspace file. {error}"))?;
    json.push(b'\n');
    let destination = base.join(path.file_name().ok_or("Choose a workspace file name.")?);
    let expected = inspect_atomic_save_target(&destination).map_err(format_atomic_save_error)?;
    save_file_atomically(&destination, &json, expected.as_ref()).map_err(format_atomic_save_error)
}

fn workspace_name(path: &Path) -> String {
    path.file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Workspace".into())
}

/// Resolve a stored folder path. Relative paths use `/` on every platform and
/// are relative to the folder that contains the workspace file.
fn resolve_folder(base: &Path, stored: &str) -> PathBuf {
    let path = Path::new(stored);
    if path.is_absolute() || path.has_root() {
        return path.to_path_buf();
    }
    stored
        .split(['/', '\\'])
        .filter(|part| !part.is_empty() && *part != ".")
        .fold(base.to_path_buf(), |path, part| {
            if part == ".." {
                path.parent().map(Path::to_path_buf).unwrap_or(path)
            } else {
                path.join(part)
            }
        })
}

/// `folder` relative to `base` with `/` separators, when both share a parent
/// folder below the filesystem root; `None` keeps the absolute path.
fn relative_folder_path(base: &Path, folder: &Path) -> Option<PathBuf> {
    let base: Vec<Component> = base.components().collect();
    let target: Vec<Component> = folder.components().collect();
    let shared = base
        .iter()
        .zip(&target)
        .take_while(|(left, right)| left == right)
        .count();
    let shared_normal = base[..shared]
        .iter()
        .filter(|component| matches!(component, Component::Normal(_)))
        .count();
    if shared_normal == 0 {
        return None;
    }
    let mut parts: Vec<String> = vec!["..".to_string(); base.len() - shared];
    for component in &target[shared..] {
        parts.push(component.as_os_str().to_str()?.to_string());
    }
    Some(PathBuf::from(if parts.is_empty() {
        ".".to_string()
    } else {
        parts.join("/")
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("pude-workspace-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn wire(path: &Path) -> String {
        checked_wire_path(path).unwrap()
    }

    #[test]
    fn stores_nearby_folders_relative_to_the_workspace_file() {
        let base = Path::new("/home/me/projects/app");
        assert_eq!(
            relative_folder_path(base, Path::new("/home/me/projects/app/web")),
            Some(PathBuf::from("web"))
        );
        assert_eq!(
            relative_folder_path(base, Path::new("/home/me/projects/api")),
            Some(PathBuf::from("../api"))
        );
        assert_eq!(relative_folder_path(base, base), Some(PathBuf::from(".")));
        assert_eq!(relative_folder_path(base, Path::new("/opt/tools")), None);
        assert_eq!(
            resolve_folder(base, "../api/"),
            PathBuf::from("/home/me/projects/api")
        );
        assert_eq!(
            resolve_folder(base, "./web"),
            PathBuf::from("/home/me/projects/app/web")
        );
    }

    #[test]
    fn writes_and_reads_a_workspace_file() {
        let scratch = Scratch::new();
        let web = scratch.0.join("app/web");
        let api = scratch.0.join("api 服務");
        fs::create_dir_all(&web).unwrap();
        fs::create_dir_all(&api).unwrap();
        let file = scratch.0.join("app/team.pdw");
        write_workspace_file_sync(&file, &[wire(&web), wire(&api), wire(&web)]).unwrap();
        let saved = fs::read_to_string(&file).unwrap();
        assert!(saved.contains("\"path\": \"web\""));
        assert!(saved.contains("\"path\": \"../api 服務\""));

        fs::remove_dir_all(&api).unwrap();
        let workspace = read_workspace_file_sync(&file).unwrap();
        assert_eq!(workspace.name, "team");
        assert_eq!(workspace.folders, vec![wire(&web)]);
        assert_eq!(workspace.missing.len(), 1);
        assert!(workspace.missing[0].ends_with("api 服務"));
    }

    #[test]
    fn rejects_other_extensions_empty_and_newer_files() {
        let scratch = Scratch::new();
        assert!(
            write_workspace_file_sync(&scratch.0.join("team.json"), &[wire(&scratch.0)]).is_err()
        );
        assert!(write_workspace_file_sync(&scratch.0.join("team.pdw"), &[]).is_err());
        let file = scratch.0.join("future.pdw");
        fs::write(&file, r#"{"version":2,"folders":[{"path":"."}]}"#).unwrap();
        assert!(read_workspace_file_sync(&file).is_err());
        fs::write(&file, "not json").unwrap();
        assert!(read_workspace_file_sync(&file).is_err());
    }
}
