// Atomic file saves: write a temporary file next to the target, then replace
// the target in one step, refusing when the file changed since it was read.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime};

use uuid::Uuid;

use crate::filesystem;
use crate::{is_windows_reparse_point, opened_file_identity, path_eq, FileSnapshot};

const TEMPORARY_FILE_PREFIX: &str = ".pude-tmp-";

pub(crate) fn save_lock_key(path: &Path) -> PathBuf {
    if let Ok(path) = fs::canonicalize(path) {
        return path;
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = path.file_name().unwrap_or_default();
    fs::canonicalize(parent)
        .map(|parent| parent.join(file_name))
        .unwrap_or_else(|_| path.to_path_buf())
}

pub(crate) fn path_lock(
    locks: &Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>,
    path: &Path,
) -> Result<Arc<Mutex<()>>, String> {
    let mut locks = locks
        .lock()
        .map_err(|_| "Unable to lock save state.".to_string())?;
    // A Weak entry is useful only while a caller owns or waits on the mutex.
    // Reap dead entries opportunistically while holding the registry lock so a
    // new caller cannot observe a stale key and create an untracked lock.
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks
        .iter()
        .find(|(registered_path, _)| path_eq(registered_path, path))
        .and_then(|(_, lock)| Weak::upgrade(lock))
    {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(path.to_path_buf(), Arc::downgrade(&lock));
    Ok(lock)
}

#[derive(Debug)]
pub(crate) enum AtomicSaveError {
    Conflict,
    Symlink,
    Io(io::Error),
    CommittedButNotDurable(io::Error),
}

pub(crate) fn format_atomic_save_error(error: AtomicSaveError) -> String {
    match error {
        AtomicSaveError::Conflict => {
            "Unable to save file. It changed on disk while saving; reload or compare before saving."
                .to_string()
        }
        AtomicSaveError::Symlink => {
            "Unable to save file. Symlink targets are not replaced automatically.".to_string()
        }
        AtomicSaveError::Io(error) => format!("Unable to save file. {error}"),
        AtomicSaveError::CommittedButNotDurable(error) => format!(
            "The file was replaced, but its folder could not be synced to storage. Reopen the file to confirm the saved contents. {error}"
        ),
    }
}

pub(crate) fn inspect_atomic_save_target(
    path: &Path,
) -> Result<Option<FileSnapshot>, AtomicSaveError> {
    match fs::symlink_metadata(path) {
        Ok(metadata)
            if metadata.file_type().is_symlink() || is_windows_reparse_point(&metadata) =>
        {
            Err(AtomicSaveError::Symlink)
        }
        Ok(_) => filesystem::save_file_metadata(path)
            .map(Some)
            .map_err(|_| AtomicSaveError::Conflict),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AtomicSaveError::Io(error)),
    }
}

pub(crate) fn save_file_atomically(
    path: &Path,
    bytes: &[u8],
    expected: Option<&FileSnapshot>,
) -> Result<(), AtomicSaveError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let initial = inspect_atomic_save_target(path)?;
    if initial.as_ref() != expected {
        return Err(AtomicSaveError::Conflict);
    }
    let original_metadata = if expected.is_some() {
        Some(fs::symlink_metadata(path).map_err(AtomicSaveError::Io)?)
    } else {
        None
    };
    if let Some(metadata) = original_metadata.as_ref() {
        if metadata.permissions().readonly() {
            return Err(AtomicSaveError::Io(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the destination file is read-only",
            )));
        }
        #[cfg(unix)]
        if metadata.mode() & 0o222 == 0 {
            return Err(AtomicSaveError::Io(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the destination file has no write permission bits",
            )));
        }
    }
    // Replacing a file gives the path a new inode, which would detach the other
    // hard links and hand the file to the saving user. Those files are rewritten
    // in place instead, which keeps them but is not atomic.
    #[cfg(unix)]
    if original_metadata
        .as_ref()
        .is_some_and(|metadata| metadata.nlink() > 1)
    {
        return write_in_place(path, bytes, expected);
    }
    remove_stale_temporary_files(parent);
    let (temporary_path, mut temporary_file) =
        create_unique_temp_file(parent).map_err(AtomicSaveError::Io)?;
    #[cfg(unix)]
    if let Some(metadata) = original_metadata.as_ref() {
        if std::os::unix::fs::fchown(&temporary_file, Some(metadata.uid()), Some(metadata.gid()))
            .is_err()
        {
            drop(temporary_file);
            let _ = fs::remove_file(&temporary_path);
            return write_in_place(path, bytes, expected);
        }
    }

    let write_result = (|| {
        temporary_file
            .write_all(bytes)
            .map_err(AtomicSaveError::Io)?;
        temporary_file.sync_all().map_err(AtomicSaveError::Io)?;
        if let (Some(metadata), Some(snapshot)) = (original_metadata.as_ref(), expected) {
            fs::set_permissions(&temporary_path, metadata.permissions())
                .map_err(AtomicSaveError::Io)?;
            copy_platform_file_metadata(path, &temporary_file, snapshot)?;
            temporary_file.sync_all().map_err(AtomicSaveError::Io)?;
        }
        Ok::<(), AtomicSaveError>(())
    })();

    if let Err(error) = write_result {
        drop(temporary_file);
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }
    let current = match inspect_atomic_save_target(path) {
        Ok(current) => current,
        Err(error) => {
            drop(temporary_file);
            let _ = fs::remove_file(&temporary_path);
            return Err(error);
        }
    };
    if current.as_ref() != expected {
        drop(temporary_file);
        let _ = fs::remove_file(&temporary_path);
        return Err(AtomicSaveError::Conflict);
    }
    drop(temporary_file);
    if let Err(error) = atomic_replace(&temporary_path, path, expected.is_some()) {
        let _ = fs::remove_file(&temporary_path);
        return Err(AtomicSaveError::Io(error));
    }
    sync_parent_directory(parent).map_err(AtomicSaveError::CommittedButNotDurable)?;
    Ok(())
}

/// Rewrites an existing file through its own inode, after checking it is still the
/// version the editor read. Used only when a replacement would lose its owner or links.
#[cfg(unix)]
fn write_in_place(
    path: &Path,
    bytes: &[u8],
    expected: Option<&FileSnapshot>,
) -> Result<(), AtomicSaveError> {
    let mut file = OpenOptions::new()
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(AtomicSaveError::Io)?;
    let metadata = file.metadata().map_err(AtomicSaveError::Io)?;
    let unchanged = expected.is_some_and(|snapshot| {
        opened_file_identity(&file, &metadata).ok() == Some(snapshot.identity.clone())
    }) && inspect_atomic_save_target(path)?.as_ref() == expected;
    if !unchanged {
        return Err(AtomicSaveError::Conflict);
    }
    file.set_len(0).map_err(AtomicSaveError::Io)?;
    file.write_all(bytes).map_err(AtomicSaveError::Io)?;
    file.sync_all().map_err(AtomicSaveError::Io)
}

/// Removes `.pude-tmp-*.tmp` files that a save interrupted by a crash left
/// behind. Each folder is checked once per run, and only files older than an
/// hour are removed, so a save still in progress in another window is safe.
fn remove_stale_temporary_files(parent: &Path) {
    static CHECKED_FOLDERS: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);
    let Ok(mut checked) = CHECKED_FOLDERS.lock() else {
        return;
    };
    if !checked
        .get_or_insert_with(HashSet::new)
        .insert(parent.to_path_buf())
    {
        return;
    }
    drop(checked);
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    let stale_before = SystemTime::now() - Duration::from_secs(60 * 60);
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with(TEMPORARY_FILE_PREFIX) && name.ends_with(".tmp")) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_file()
            && metadata
                .modified()
                .is_ok_and(|modified| modified < stale_before)
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn copy_platform_file_metadata(
    original_path: &Path,
    _replacement: &File,
    expected: &FileSnapshot,
) -> Result<(), AtomicSaveError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    #[cfg(windows)]
    options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    let original = options.open(original_path).map_err(AtomicSaveError::Io)?;
    let metadata = original.metadata().map_err(AtomicSaveError::Io)?;
    if is_windows_reparse_point(&metadata)
        || opened_file_identity(&original, &metadata).map_err(AtomicSaveError::Io)?
            != expected.identity
    {
        return Err(AtomicSaveError::Conflict);
    }
    #[cfg(target_os = "macos")]
    copy_macos_file_metadata(&original, _replacement).map_err(AtomicSaveError::Io)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn copy_macos_file_metadata(original: &File, replacement: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    use std::os::raw::{c_int, c_void};

    #[link(name = "System")]
    extern "C" {
        fn fcopyfile(from_fd: c_int, to_fd: c_int, state: *mut c_void, flags: u32) -> c_int;
    }

    const COPYFILE_ACL: u32 = 1 << 0;
    const COPYFILE_XATTR: u32 = 1 << 2;
    let copied = unsafe {
        fcopyfile(
            original.as_raw_fd(),
            replacement.as_raw_fd(),
            std::ptr::null_mut(),
            COPYFILE_ACL | COPYFILE_XATTR,
        )
    };
    if copied == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn create_unique_temp_file(parent: &Path) -> io::Result<(PathBuf, File)> {
    for _ in 0..16 {
        let temporary_path = parent.join(format!("{TEMPORARY_FILE_PREFIX}{}.tmp", Uuid::new_v4()));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
        {
            Ok(file) => return Ok((temporary_path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "unable to create a unique temporary file",
    ))
}

#[cfg(not(windows))]
pub(crate) fn atomic_replace(
    temporary: &Path,
    destination: &Path,
    replace_existing: bool,
) -> io::Result<()> {
    if replace_existing {
        return fs::rename(temporary, destination);
    }
    #[cfg(target_os = "macos")]
    {
        use std::ffi::CString;
        use std::os::raw::c_int;
        use std::os::unix::ffi::OsStrExt;

        #[link(name = "System")]
        extern "C" {
            fn renamex_np(from: *const i8, to: *const i8, flags: u32) -> c_int;
        }
        const RENAME_EXCL: u32 = 0x0000_0004;
        let temporary = CString::new(temporary.as_os_str().as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid temporary path"))?;
        let destination = CString::new(destination.as_os_str().as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid destination path"))?;
        let renamed = unsafe { renamex_np(temporary.as_ptr(), destination.as_ptr(), RENAME_EXCL) };
        if renamed == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        match fs::hard_link(temporary, destination) {
            Ok(()) => {}
            Err(error) if hard_links_unsupported(&error) => {
                copy_into_new_file(temporary, destination)?
            }
            Err(error) => return Err(error),
        }
        fs::remove_file(temporary)
    }
}

/// Filesystems such as FAT, exFAT and some network shares cannot hard link.
pub(crate) fn hard_links_unsupported(error: &io::Error) -> bool {
    #[cfg(unix)]
    let platform_code = matches!(error.raw_os_error(), Some(libc::EPERM));
    // ERROR_INVALID_FUNCTION and ERROR_NOT_SUPPORTED.
    #[cfg(windows)]
    let platform_code = matches!(error.raw_os_error(), Some(1 | 50));
    error.kind() == io::ErrorKind::Unsupported || platform_code
}

#[cfg(all(not(windows), not(target_os = "macos")))]
pub(crate) fn copy_into_new_file(source: &Path, destination: &Path) -> io::Result<()> {
    let mut source = File::open(source)?;
    let mut new_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let copied = io::copy(&mut source, &mut new_file).and_then(|_| new_file.sync_all());
    if copied.is_err() {
        let _ = fs::remove_file(destination);
    }
    copied
}

#[cfg(windows)]
pub(crate) fn atomic_replace(
    temporary: &Path,
    destination: &Path,
    replace_existing: bool,
) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
        fn ReplaceFileW(
            replaced_file_name: *const u16,
            replacement_file_name: *const u16,
            backup_file_name: *const u16,
            replace_flags: u32,
            exclude: *mut std::ffi::c_void,
            reserved: *mut std::ffi::c_void,
        ) -> i32;
    }

    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let temporary: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let replaced = unsafe {
        if replace_existing {
            ReplaceFileW(
                destination.as_ptr(),
                temporary.as_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } else {
            MoveFileExW(
                temporary.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if replaced == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> io::Result<()> {
    File::open(parent)?.sync_all()
}

#[cfg(windows)]
fn sync_parent_directory(_parent: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("pude-atomic-save-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).expect("temporary directory");
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    #[test]
    fn saving_a_hard_linked_file_updates_every_link() {
        let directory = TempDir::new();
        let file = directory.0.join("original.txt");
        let link = directory.0.join("link.txt");
        fs::write(&file, "before").expect("original file");
        fs::hard_link(&file, &link).expect("hard link");
        let snapshot = filesystem::save_file_metadata(&file).expect("snapshot");

        save_file_atomically(&file, b"after", Some(&snapshot)).expect("save");

        assert_eq!(fs::read_to_string(&link).expect("link contents"), "after");
        assert_eq!(fs::metadata(&file).expect("metadata").nlink(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn an_in_place_save_still_refuses_a_file_changed_on_disk() {
        let directory = TempDir::new();
        let file = directory.0.join("original.txt");
        fs::write(&file, "before").expect("original file");
        fs::hard_link(&file, directory.0.join("link.txt")).expect("hard link");
        let snapshot = filesystem::save_file_metadata(&file).expect("snapshot");
        fs::write(&file, "changed elsewhere").expect("external change");

        assert!(matches!(
            save_file_atomically(&file, b"after", Some(&snapshot)),
            Err(AtomicSaveError::Conflict)
        ));
        assert_eq!(
            fs::read_to_string(&file).expect("contents"),
            "changed elsewhere"
        );
    }

    #[test]
    fn stale_temporary_files_from_an_interrupted_save_are_removed() {
        let directory = TempDir::new();
        let stale = directory.0.join(".pude-tmp-stale.tmp");
        let recent = directory.0.join(".pude-tmp-recent.tmp");
        let unrelated = directory.0.join("notes.tmp");
        for path in [&stale, &recent, &unrelated] {
            fs::write(path, "x").expect("file");
        }
        let two_hours_ago = SystemTime::now() - Duration::from_secs(2 * 60 * 60);
        for path in [&stale, &unrelated] {
            File::options()
                .write(true)
                .open(path)
                .and_then(|file| file.set_modified(two_hours_ago))
                .expect("old modification time");
        }

        remove_stale_temporary_files(&directory.0);

        assert!(!stale.exists());
        assert!(recent.exists());
        assert!(unrelated.exists());
    }
}
