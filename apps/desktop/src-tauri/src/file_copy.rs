//! Explorer paste: copies a file, folder or link into a project folder
//! without ever replacing an existing item.

use serde::Serialize;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::{checked_wire_path, decode_wire_path};

const MAX_COPY_NAME_ATTEMPTS: usize = 10_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CopyPathResult {
    path: String,
    skipped_special_items: usize,
}

#[derive(Clone, Copy)]
enum CopyKind {
    Directory,
    File,
    Link,
    Special,
}

impl CopyKind {
    fn of(file_type: fs::FileType) -> Self {
        if file_type.is_symlink() {
            Self::Link
        } else if file_type.is_dir() {
            Self::Directory
        } else if file_type.is_file() {
            Self::File
        } else {
            Self::Special
        }
    }
}

#[tauri::command]
pub(crate) async fn copy_path(
    source: String,
    source_root: String,
    destination_directory: String,
    destination_root: String,
) -> Result<CopyPathResult, String> {
    // A large folder can take minutes, so it stays out of the shared file queue.
    tauri::async_runtime::spawn_blocking(move || {
        copy_path_sync(
            decode_wire_path(&source),
            decode_wire_path(&source_root),
            decode_wire_path(&destination_directory),
            decode_wire_path(&destination_root),
        )
    })
    .await
    .map_err(paste_failure)?
}

fn copy_path_sync(
    source: PathBuf,
    source_root: PathBuf,
    destination_directory: PathBuf,
    destination_root: PathBuf,
) -> Result<CopyPathResult, String> {
    let directory = canonical_destination(&destination_directory, &destination_root)?;
    let file_type = fs::symlink_metadata(&source)
        .map_err(|error| missing_or_failure(error, "The copied item no longer exists."))?
        .file_type();
    if !is_inside_root(&source, &source_root).map_err(paste_failure)? {
        return Err("Unable to paste item. The copied item is outside its project.".to_string());
    }
    if file_type.is_dir()
        && directory.starts_with(fs::canonicalize(&source).map_err(paste_failure)?)
    {
        return Err(
            "Unable to paste item. A folder cannot be pasted into itself or one of its subfolders."
                .to_string(),
        );
    }
    let (destination, skipped_special_items) =
        copy_without_replacing(&source, file_type, &directory, |from, to| {
            fs::copy(from, to).map(drop)
        })?;
    let copied_name = destination.file_name().unwrap_or_default();
    Ok(CopyPathResult {
        path: checked_wire_path(&destination_directory.join(copied_name))?,
        skipped_special_items,
    })
}

fn canonical_destination(directory: &Path, root: &Path) -> Result<PathBuf, String> {
    let directory = fs::canonicalize(directory)
        .map_err(|error| missing_or_failure(error, "The destination folder no longer exists."))?;
    let root = fs::canonicalize(root)
        .map_err(|error| missing_or_failure(error, "The destination folder no longer exists."))?;
    if !directory.starts_with(root) {
        return Err("Unable to paste item. The destination is outside the project.".to_string());
    }
    if !directory.is_dir() {
        return Err("Unable to paste item. The destination is not a folder.".to_string());
    }
    Ok(directory)
}

/// The last component is not resolved, so a link inside the project counts as
/// inside it wherever it points.
fn is_inside_root(path: &Path, root: &Path) -> io::Result<bool> {
    if path == root {
        return Ok(true);
    }
    let Some(parent) = path.parent() else {
        return Ok(false);
    };
    Ok(fs::canonicalize(parent)?.starts_with(fs::canonicalize(root)?))
}

fn copy_without_replacing(
    source: &Path,
    file_type: fs::FileType,
    directory: &Path,
    copy_file: impl Fn(&Path, &Path) -> io::Result<()>,
) -> Result<(PathBuf, usize), String> {
    let name = source
        .file_name()
        .ok_or("Unable to paste item. This location cannot be copied.")?;
    let kind = CopyKind::of(file_type);
    let destination = match kind {
        CopyKind::Directory => {
            create_unused_copy(directory, name, true, |path| fs::create_dir(path))
        }
        CopyKind::File => create_unused_copy(directory, name, false, |path| {
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map(drop)
        }),
        CopyKind::Link => {
            let target = fs::read_link(source).map_err(paste_failure)?;
            create_unused_copy(directory, name, false, |path| {
                create_link(&target, path, file_type)
            })
        }
        CopyKind::Special => {
            Err("Unable to paste item. Only files, folders and links can be copied.".to_string())
        }
    }?;
    let copied = match kind {
        CopyKind::Directory => copy_directory_contents(source, &destination, &copy_file),
        CopyKind::File => copy_file(source, &destination).map(|()| 0),
        CopyKind::Link | CopyKind::Special => Ok(0),
    };
    match copied {
        Ok(skipped_special_items) => Ok((destination, skipped_special_items)),
        Err(error) => {
            let _ = match kind {
                CopyKind::Directory => fs::remove_dir_all(&destination),
                _ => fs::remove_file(&destination),
            };
            Err(paste_failure(error))
        }
    }
}

/// Each name is claimed by the operation that creates it, so a name taken at
/// the last moment moves on to the next candidate instead of being replaced.
fn create_unused_copy(
    directory: &Path,
    source_name: &OsStr,
    is_directory: bool,
    create: impl Fn(&Path) -> io::Result<()>,
) -> Result<PathBuf, String> {
    for attempt in 0..MAX_COPY_NAME_ATTEMPTS {
        let candidate = directory.join(copy_name(source_name, attempt, is_directory));
        match create(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(paste_failure(error)),
        }
    }
    Err("Unable to paste item. Too many copies already use this name.".to_string())
}

fn copy_name(source_name: &OsStr, attempt: usize, is_directory: bool) -> OsString {
    if attempt == 0 {
        return source_name.to_os_string();
    }
    let source_path = Path::new(source_name);
    let stem = if is_directory {
        source_name
    } else {
        source_path.file_stem().unwrap_or(source_name)
    };
    let mut name = stem.to_os_string();
    name.push(if attempt == 1 {
        " copy".to_string()
    } else {
        format!(" copy {attempt}")
    });
    if let Some(extension) = source_path.extension().filter(|_| !is_directory) {
        name.push(".");
        name.push(extension);
    }
    name
}

/// Walks with an explicit stack so depth cannot overflow the thread. Links are
/// recreated rather than followed, so a link cycle ends the walk like any file.
fn copy_directory_contents(
    source: &Path,
    destination: &Path,
    copy_file: &impl Fn(&Path, &Path) -> io::Result<()>,
) -> io::Result<usize> {
    let mut skipped_special_items = 0;
    let mut pending = vec![(source.to_path_buf(), destination.to_path_buf())];
    let mut created_directories = Vec::new();
    while let Some((from_directory, to_directory)) = pending.pop() {
        let permissions = fs::metadata(&from_directory)
            .map_err(|error| error_at(&from_directory, error))?
            .permissions();
        created_directories.push((to_directory.clone(), permissions));
        let entries =
            fs::read_dir(&from_directory).map_err(|error| error_at(&from_directory, error))?;
        for entry in entries {
            let entry = entry.map_err(|error| error_at(&from_directory, error))?;
            let from = entry.path();
            let to = to_directory.join(entry.file_name());
            let file_type = entry.file_type().map_err(|error| error_at(&from, error))?;
            match CopyKind::of(file_type) {
                CopyKind::Directory => {
                    fs::create_dir(&to).map_err(|error| error_at(&from, error))?;
                    pending.push((from, to));
                }
                CopyKind::File => copy_file(&from, &to).map_err(|error| error_at(&from, error))?,
                CopyKind::Link => fs::read_link(&from)
                    .and_then(|target| create_link(&target, &to, file_type))
                    .map_err(|error| error_at(&from, error))?,
                CopyKind::Special => skipped_special_items += 1,
            }
        }
    }
    // Applied last because a read-only source folder must stay writable while it is filled.
    for (directory, permissions) in created_directories.into_iter().rev() {
        fs::set_permissions(&directory, permissions)
            .map_err(|error| error_at(&directory, error))?;
    }
    Ok(skipped_special_items)
}

#[cfg(unix)]
fn create_link(target: &Path, link: &Path, _file_type: fs::FileType) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn create_link(target: &Path, link: &Path, file_type: fs::FileType) -> io::Result<()> {
    use std::os::windows::fs::{symlink_dir, symlink_file, FileTypeExt};
    if file_type.is_symlink_dir() {
        symlink_dir(target, link)
    } else {
        symlink_file(target, link)
    }
}

fn error_at(path: &Path, error: io::Error) -> io::Error {
    io::Error::new(error.kind(), format!("{}: {error}", path.display()))
}

fn paste_failure(error: impl std::fmt::Display) -> String {
    format!("Unable to paste item. {error}")
}

fn missing_or_failure(error: io::Error, missing_message: &str) -> String {
    if error.kind() == io::ErrorKind::NotFound {
        format!("Unable to paste item. {missing_message}")
    } else {
        paste_failure(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire_path;
    use uuid::Uuid;

    struct Project(PathBuf);

    impl Project {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("pude-copy-{}", Uuid::new_v4()));
            fs::create_dir(&path).expect("project directory should be created");
            Self(path)
        }

        fn file(&self, relative: &str, content: &str) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, content).unwrap();
            path
        }

        fn folder(&self, relative: &str) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(&path).unwrap();
            path
        }

        fn paste(&self, source: &Path, directory: &Path) -> Result<CopyPathResult, String> {
            paste_between(source, self, directory, self)
        }

        fn read(&self, relative: &str) -> String {
            fs::read_to_string(self.0.join(relative)).unwrap()
        }
    }

    impl Drop for Project {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn paste_between(
        source: &Path,
        source_project: &Project,
        directory: &Path,
        destination_project: &Project,
    ) -> Result<CopyPathResult, String> {
        copy_path_sync(
            source.to_path_buf(),
            source_project.0.clone(),
            directory.to_path_buf(),
            destination_project.0.clone(),
        )
    }

    fn name_of(result: &CopyPathResult) -> String {
        Path::new(&result.path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn a_file_keeps_its_name_in_another_project() {
        let first = Project::new();
        let second = Project::new();
        let source = first.file("notes.md", "from first");

        let result = paste_between(&source, &first, &second.0, &second).unwrap();

        assert_eq!(name_of(&result), "notes.md");
        assert_eq!(second.read("notes.md"), "from first");
        assert_eq!(first.read("notes.md"), "from first");
    }

    #[test]
    fn a_name_collision_gets_a_new_name_and_replaces_nothing() {
        let project = Project::new();
        let source = project.file("main.test.ts", "original");
        let names: Vec<String> = (0..2)
            .map(|_| name_of(&project.paste(&source, &project.0).unwrap()))
            .collect();

        assert_eq!(names, ["main.test copy.ts", "main.test copy 2.ts"]);
        assert_eq!(project.read("main.test.ts"), "original");
        assert_eq!(project.read("main.test copy 2.ts"), "original");
    }

    #[test]
    fn dot_files_and_folders_with_dots_append_copy_to_the_whole_name() {
        let project = Project::new();
        let dot_file = project.file(".env", "A=1");
        let folder = project.folder("my.folder");

        assert_eq!(
            name_of(&project.paste(&dot_file, &project.0).unwrap()),
            ".env copy"
        );
        assert_eq!(
            name_of(&project.paste(&folder, &project.0).unwrap()),
            "my.folder copy"
        );
    }

    #[test]
    fn a_folder_copies_recursively_including_empty_folders() {
        let first = Project::new();
        let second = Project::new();
        first.file("src/lib/deep.ts", "deep");
        first.folder("src/empty");

        paste_between(&first.0.join("src"), &first, &second.0, &second).unwrap();

        assert_eq!(second.read("src/lib/deep.ts"), "deep");
        assert!(second.0.join("src/empty").is_dir());
    }

    #[test]
    fn a_folder_cannot_be_pasted_into_itself_or_its_subfolders() {
        let project = Project::new();
        let folder = project.folder("src");
        let nested = project.folder("src/lib");

        for target in [&folder, &nested] {
            let error = project.paste(&folder, target).unwrap_err();
            assert!(error.contains("into itself"), "{error}");
        }
        assert_eq!(fs::read_dir(&folder).unwrap().count(), 1);
        assert_eq!(fs::read_dir(&nested).unwrap().count(), 0);
    }

    #[test]
    fn a_folder_can_be_pasted_beside_itself() {
        let project = Project::new();
        project.file("src/a.ts", "a");

        let result = project.paste(&project.0.join("src"), &project.0).unwrap();

        assert_eq!(name_of(&result), "src copy");
        assert_eq!(project.read("src copy/a.ts"), "a");
    }

    #[test]
    fn paths_outside_their_project_are_rejected() {
        let project = Project::new();
        let outside = Project::new();
        let source = project.file("a.txt", "a");
        let outside_file = outside.file("secret.txt", "secret");

        let destination_error = paste_between(&source, &project, &outside.0, &project).unwrap_err();
        let source_error =
            paste_between(&outside_file, &project, &project.0, &project).unwrap_err();

        assert!(
            destination_error.contains("outside the project"),
            "{destination_error}"
        );
        assert!(
            source_error.contains("outside its project"),
            "{source_error}"
        );
        assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 1);
    }

    #[test]
    fn a_missing_source_reports_that_it_no_longer_exists() {
        let project = Project::new();

        let error = project
            .paste(&project.0.join("gone.txt"), &project.0)
            .unwrap_err();

        assert_eq!(
            error,
            "Unable to paste item. The copied item no longer exists."
        );
    }

    #[test]
    fn the_result_uses_the_wire_field_names_the_frontend_reads() {
        let project = Project::new();
        let source = project.file("a.txt", "a");

        let result = serde_json::to_value(project.paste(&source, &project.0).unwrap()).unwrap();

        assert_eq!(result["skippedSpecialItems"], 0);
        assert!(result["path"].as_str().unwrap().ends_with("a copy.txt"));
    }

    #[test]
    fn a_failed_copy_removes_the_partial_destination() {
        let project = Project::new();
        project.file("src/a.txt", "a");
        project.file("src/b.txt", "b");
        let source = project.0.join("src");
        let target = project.folder("target");
        let file_type = fs::symlink_metadata(&source).unwrap().file_type();
        let copies = std::sync::atomic::AtomicUsize::new(0);

        let error = copy_without_replacing(&source, file_type, &target, |from, to| {
            if copies.fetch_add(1, std::sync::atomic::Ordering::Relaxed) == 1 {
                return Err(io::Error::other("disk full"));
            }
            fs::copy(from, to).map(drop)
        })
        .unwrap_err();

        assert!(error.contains("disk full"), "{error}");
        assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
    }

    #[cfg(unix)]
    mod unix_entries {
        use super::*;
        use std::os::unix::fs::{symlink, PermissionsExt};

        #[test]
        fn links_are_recreated_without_following_them() {
            let project = Project::new();
            let outside = Project::new();
            outside.file("large/data.bin", "data");
            let folder = project.folder("src");
            symlink(outside.0.join("large"), folder.join("external")).unwrap();
            symlink("..", folder.join("cycle")).unwrap();
            symlink("missing-target", folder.join("dangling")).unwrap();

            project.paste(&folder, &project.0).unwrap();

            let copy = project.0.join("src copy");
            assert_eq!(
                fs::read_link(copy.join("external")).unwrap(),
                outside.0.join("large")
            );
            assert_eq!(fs::read_link(copy.join("cycle")).unwrap(), Path::new(".."));
            assert_eq!(
                fs::read_link(copy.join("dangling")).unwrap(),
                Path::new("missing-target")
            );
        }

        #[test]
        fn a_copied_link_is_pasted_as_a_link() {
            let project = Project::new();
            project.file("target.txt", "target");
            let link = project.0.join("alias.txt");
            symlink("target.txt", &link).unwrap();

            let result = project.paste(&link, &project.0).unwrap();

            assert_eq!(name_of(&result), "alias copy.txt");
            assert_eq!(
                fs::read_link(project.0.join("alias copy.txt")).unwrap(),
                Path::new("target.txt")
            );
        }

        #[test]
        fn a_read_only_folder_keeps_its_permissions_after_being_filled() {
            let project = Project::new();
            let folder = project.folder("locked");
            project.file("locked/a.txt", "a");
            fs::set_permissions(&folder, fs::Permissions::from_mode(0o555)).unwrap();

            let result = project.paste(&folder, &project.0);

            let copy = project.0.join("locked copy");
            let copied_mode = fs::metadata(&copy).unwrap().permissions().mode() & 0o777;
            for restored in [&folder, &copy] {
                fs::set_permissions(restored, fs::Permissions::from_mode(0o755)).unwrap();
            }
            result.unwrap();
            assert_eq!(copied_mode, 0o555);
            assert_eq!(project.read("locked copy/a.txt"), "a");
        }

        #[test]
        fn named_pipes_are_skipped_instead_of_blocking_the_copy() {
            let project = Project::new();
            let folder = project.folder("src");
            project.file("src/a.txt", "a");
            let pipe = folder.join("pipe");
            let created = std::process::Command::new("mkfifo")
                .arg(&pipe)
                .status()
                .unwrap();
            assert!(created.success());

            let result = project.paste(&folder, &project.0).unwrap();

            assert_eq!(result.skipped_special_items, 1);
            assert!(!project.0.join("src copy/pipe").exists());
            assert_eq!(project.read("src copy/a.txt"), "a");

            let error = project.paste(&pipe, &project.0).unwrap_err();
            assert!(error.contains("Only files, folders and links"), "{error}");
        }

        #[test]
        fn a_non_utf8_name_survives_the_wire_path_round_trip() {
            use std::os::unix::ffi::OsStrExt;
            let project = Project::new();
            // APFS rejects invalid UTF-8 names, so this runs only where the filesystem allows them.
            let raw = OsStr::from_bytes(b"caf\xE9.txt");
            let source = project.0.join(raw);
            if fs::write(&source, "bytes").is_err() {
                return;
            }
            let target = project.folder("target");

            let result = copy_path_sync(
                decode_wire_path(&wire_path(&source)),
                project.0.clone(),
                target.clone(),
                project.0.clone(),
            )
            .unwrap();

            assert_eq!(decode_wire_path(&result.path), target.join(raw));
        }
    }
}
