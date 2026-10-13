use std::io;
use std::path::Path;

#[cfg(windows)]
pub(super) fn move_path_to_trash(target: &Path) -> io::Result<()> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;

    const FO_DELETE: u32 = 3;
    const FOF_SILENT: u16 = 0x0004;
    const FOF_NOCONFIRMATION: u16 = 0x0010;
    const FOF_ALLOWUNDO: u16 = 0x0040;
    const FOF_NOERRORUI: u16 = 0x0400;

    if !target.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows requires an absolute path to move an item to the Recycle Bin.",
        ));
    }

    #[repr(C)]
    struct ShellFileOperation {
        window: *mut c_void,
        operation: u32,
        from: *const u16,
        to: *const u16,
        flags: u16,
        any_operations_aborted: i32,
        name_mappings: *mut c_void,
        progress_title: *const u16,
    }

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn SHFileOperationW(operation: *mut ShellFileOperation) -> i32;
    }

    let shell_path = windows_shell_path(target)?;
    if std::fs::canonicalize(&shell_path)? != std::fs::canonicalize(target)? {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "The Shell path resolves to a different item.",
        ));
    }
    let mut from: Vec<u16> = shell_path.as_os_str().encode_wide().collect();
    from.extend([0, 0]);
    let mut operation = ShellFileOperation {
        window: std::ptr::null_mut(),
        operation: FO_DELETE,
        from: from.as_ptr(),
        to: std::ptr::null(),
        flags: FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI,
        any_operations_aborted: 0,
        name_mappings: std::ptr::null_mut(),
        progress_title: std::ptr::null(),
    };

    // SAFETY: `from` is a double-NUL-terminated UTF-16 path that remains alive through the call.
    let result = unsafe { SHFileOperationW(&mut operation) };
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result));
    }
    if operation.any_operations_aborted != 0 {
        return Err(io::Error::other(
            "Windows aborted the Recycle Bin operation.",
        ));
    }

    Ok(())
}

#[cfg(windows)]
fn windows_shell_path(target: &Path) -> io::Result<std::path::PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    for component in target.components() {
        if let std::path::Component::Normal(name) = component {
            let units: Vec<u16> = name.encode_wide().collect();
            if matches!(units.last(), Some(32 | 46)) || units.contains(&(b':' as u16)) {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "This filename cannot be represented safely by the Windows Shell.",
                ));
            }
        }
    }
    let units: Vec<u16> = target.as_os_str().encode_wide().collect();
    let prefix: Vec<u16> = r"\\?\".encode_utf16().collect();
    let unc_prefix: Vec<u16> = r"\\?\UNC\".encode_utf16().collect();
    let converted = if units.starts_with(&unc_prefix) {
        [
            vec![b'\\' as u16, b'\\' as u16],
            units[unc_prefix.len()..].to_vec(),
        ]
        .concat()
    } else if units.starts_with(&prefix) {
        let rest = &units[prefix.len()..];
        if rest.len() < 3
            || !((b'A' as u16..=b'Z' as u16).contains(&rest[0])
                || (b'a' as u16..=b'z' as u16).contains(&rest[0]))
            || rest[1] != b':' as u16
            || rest[2] != b'\\' as u16
        {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "This Windows namespace is unsupported by the Recycle Bin.",
            ));
        }
        rest.to_vec()
    } else {
        units
    };
    Ok(std::path::PathBuf::from(OsString::from_wide(&converted)))
}

#[cfg(all(test, windows))]
mod windows_shell_path_tests {
    use super::*;

    #[test]
    fn shell_paths_preserve_drive_unc_and_unicode_names() {
        assert_eq!(
            windows_shell_path(Path::new(r"\\?\C:\測試 # & %\file.txt")).unwrap(),
            Path::new(r"C:\測試 # & %\file.txt")
        );
        assert_eq!(
            windows_shell_path(Path::new(r"\\?\UNC\server\share\測試.txt")).unwrap(),
            Path::new(r"\\server\share\測試.txt")
        );
        assert_eq!(
            windows_shell_path(Path::new(r"C:\ordinary.txt")).unwrap(),
            Path::new(r"C:\ordinary.txt")
        );
        assert!(
            windows_shell_path(Path::new(r"\\?\GLOBALROOT\Device\HarddiskVolume1\file.txt"))
                .is_err()
        );
    }

    #[test]
    fn namespace_alias_cannot_delete_a_different_shell_item() {
        let root = std::env::temp_dir().join(format!("pude-shell-path-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let ordinary = root.join("fixture.txt");
        std::fs::write(&ordinary, b"ordinary").unwrap();
        let canonical = std::fs::canonicalize(&ordinary).unwrap();
        let namespace_alias = canonical.with_file_name("fixture.txt.");
        std::fs::write(&namespace_alias, b"namespace-only").unwrap();
        assert!(move_path_to_trash(&namespace_alias).is_err());
        assert_eq!(std::fs::read(&ordinary).unwrap(), b"ordinary");
        assert_eq!(std::fs::read(&namespace_alias).unwrap(), b"namespace-only");
        std::fs::remove_file(namespace_alias).unwrap();
        std::fs::remove_file(ordinary).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}

#[cfg(target_os = "macos")]
pub(super) fn move_path_to_trash(target: &Path) -> io::Result<()> {
    use std::ffi::{c_char, c_void, CStr, CString};
    use std::os::unix::ffi::OsStrExt;

    type ObjcId = *mut c_void;
    type ObjcSelector = *mut c_void;

    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> ObjcId;
        fn sel_registerName(name: *const c_char) -> ObjcSelector;
        fn objc_msgSend();
    }
    #[link(name = "Foundation", kind = "framework")]
    unsafe extern "C" {}

    unsafe fn send_object(receiver: ObjcId, selector: ObjcSelector) -> ObjcId {
        let send: unsafe extern "C" fn(ObjcId, ObjcSelector) -> ObjcId =
            std::mem::transmute(objc_msgSend as *const ());
        send(receiver, selector)
    }

    unsafe fn send_file_url_with_path(
        receiver: ObjcId,
        selector: ObjcSelector,
        path: *const c_char,
        is_directory: i8,
        base_url: ObjcId,
    ) -> ObjcId {
        let send: unsafe extern "C" fn(ObjcId, ObjcSelector, *const c_char, i8, ObjcId) -> ObjcId =
            std::mem::transmute(objc_msgSend as *const ());
        send(receiver, selector, path, is_directory, base_url)
    }

    unsafe fn send_trash_item(
        receiver: ObjcId,
        selector: ObjcSelector,
        url: ObjcId,
        resulting_url: *mut ObjcId,
        error: *mut ObjcId,
    ) -> i8 {
        let send: unsafe extern "C" fn(
            ObjcId,
            ObjcSelector,
            ObjcId,
            *mut ObjcId,
            *mut ObjcId,
        ) -> i8 = std::mem::transmute(objc_msgSend as *const ());
        send(receiver, selector, url, resulting_url, error)
    }

    unsafe fn localized_error(error: ObjcId) -> String {
        if error.is_null() {
            return "macOS did not provide an error description.".to_string();
        }
        let localized_description =
            send_object(error, sel_registerName(c"localizedDescription".as_ptr()));
        if localized_description.is_null() {
            return "macOS did not provide an error description.".to_string();
        }
        let utf8_string: unsafe extern "C" fn(ObjcId, ObjcSelector) -> *const c_char =
            std::mem::transmute(objc_msgSend as *const ());
        let message = utf8_string(
            localized_description,
            sel_registerName(c"UTF8String".as_ptr()),
        );
        if message.is_null() {
            "macOS did not provide a UTF-8 error description.".to_string()
        } else {
            CStr::from_ptr(message).to_string_lossy().into_owned()
        }
    }

    let path = CString::new(target.as_os_str().as_bytes()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "The file path contains a null byte.",
        )
    })?;
    let is_directory = i8::from(
        target
            .symlink_metadata()
            .map_err(|error| io::Error::other(format!("Unable to inspect item. {error}")))?
            .file_type()
            .is_dir(),
    );

    // SAFETY: Objective-C objects and selectors are provided by Foundation, and all out pointers
    // remain valid for the synchronous message send.
    unsafe {
        let pool_class = objc_getClass(c"NSAutoreleasePool".as_ptr());
        let autorelease_pool = send_object(pool_class, sel_registerName(c"new".as_ptr()));
        let result = (|| {
            let url_class = objc_getClass(c"NSURL".as_ptr());
            let file_url = send_file_url_with_path(
                url_class,
                sel_registerName(
                    c"fileURLWithFileSystemRepresentation:isDirectory:relativeToURL:".as_ptr(),
                ),
                path.as_ptr(),
                is_directory,
                std::ptr::null_mut(),
            );
            if file_url.is_null() {
                return Err(io::Error::other("macOS could not create a file URL."));
            }

            let file_manager_class = objc_getClass(c"NSFileManager".as_ptr());
            let file_manager = send_object(
                file_manager_class,
                sel_registerName(c"defaultManager".as_ptr()),
            );
            if file_manager.is_null() {
                return Err(io::Error::other("macOS file manager is unavailable."));
            }

            let mut resulting_url = std::ptr::null_mut();
            let mut error = std::ptr::null_mut();
            let moved = send_trash_item(
                file_manager,
                sel_registerName(c"trashItemAtURL:resultingItemURL:error:".as_ptr()),
                file_url,
                &mut resulting_url,
                &mut error,
            );
            if moved == 0 {
                return Err(io::Error::other(localized_error(error)));
            }

            Ok(())
        })();

        if !autorelease_pool.is_null() {
            let drain: unsafe extern "C" fn(ObjcId, ObjcSelector) =
                std::mem::transmute(objc_msgSend as *const ());
            drain(autorelease_pool, sel_registerName(c"drain".as_ptr()));
        }
        result
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(super) fn move_path_to_trash(_target: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Moving items to the system trash is unsupported on this platform.",
    ))
}

#[cfg(all(test, target_os = "macos"))]
mod macos_trash_tests {
    use super::move_path_to_trash;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Output};
    use uuid::Uuid;

    struct MountedTrashFixture {
        directory: PathBuf,
        mount_point: PathBuf,
        image: PathBuf,
        mounted: bool,
    }

    impl MountedTrashFixture {
        fn new() -> Self {
            let directory =
                PathBuf::from("/private/tmp").join(format!("pude-trash-volume-{}", Uuid::new_v4()));
            let mount_point = directory.join("mount");
            let image = directory.join("trash-fixture.sparseimage");
            fs::create_dir_all(&mount_point)
                .expect("isolated Trash fixture directory should be created in /private/tmp");
            let mut fixture = Self {
                directory,
                mount_point,
                image,
                mounted: false,
            };

            let create = Command::new("hdiutil")
                .args([
                    "create",
                    "-size",
                    "256m",
                    "-fs",
                    "APFS",
                    "-volname",
                    "PudeTrashTest",
                    "-type",
                    "SPARSE",
                ])
                .arg(&fixture.image)
                .output()
                .expect("hdiutil should be available on macOS");
            assert_command_succeeded("create isolated APFS image", &create);

            let attach = Command::new("hdiutil")
                .args(["attach", "-nobrowse", "-mountpoint"])
                .arg(&fixture.mount_point)
                .arg(&fixture.image)
                .output()
                .expect("hdiutil should attach the isolated APFS image");
            if !attach.status.success() {
                if !detach_mountpoint(&fixture.mount_point) {
                    eprintln!(
                        "hdiutil attach failed and the fixture mount point could not be detached; preserving {}",
                        fixture.directory.display()
                    );
                    std::mem::forget(fixture);
                }
                panic!(
                    "hdiutil could not attach isolated APFS image: {}",
                    String::from_utf8_lossy(&attach.stderr)
                );
            }
            fixture.mounted = true;
            fixture
        }

        fn mount_point(&self) -> &Path {
            &self.mount_point
        }
    }

    impl Drop for MountedTrashFixture {
        fn drop(&mut self) {
            let detached = !self.mounted || detach_mountpoint(&self.mount_point);
            if detached {
                let _ = fs::remove_dir_all(&self.directory);
            } else {
                eprintln!(
                    "Could not detach isolated Trash test volume; preserving its image at {}",
                    self.image.display()
                );
            }
        }
    }

    fn assert_command_succeeded(action: &str, output: &Output) {
        assert!(
            output.status.success(),
            "hdiutil failed to {action}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn detach_mountpoint(mount_point: &Path) -> bool {
        Command::new("hdiutil")
            .args(["detach", "-quiet"])
            .arg(mount_point)
            .output()
            .is_ok_and(|output| output.status.success())
    }

    fn find_trashed_item(volume: &Path, name: &str) -> Option<PathBuf> {
        let trash_root = volume.join(".Trashes");
        let entries = fs::read_dir(trash_root).ok()?;
        for entry in entries.flatten() {
            let candidate = entry.path().join(name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
        None
    }

    #[test]
    fn foundation_trash_moves_disposable_volume_items_without_touching_user_trash() {
        let volume = MountedTrashFixture::new();
        let unique = Uuid::new_v4().to_string();
        let uid = unsafe { libc::geteuid() };
        let volume_trash = volume.mount_point().join(".Trashes").join(uid.to_string());
        fs::create_dir_all(&volume_trash)
            .expect("disposable volume Trash directory should be prepared");
        let file = volume.mount_point().join(format!("trash-{unique}.txt"));
        let folder = volume.mount_point().join(format!("trash-{unique}-folder"));
        fs::write(&file, b"restorable file contents").expect("fixture file should be written");
        fs::create_dir(&folder).expect("fixture folder should be created");
        fs::write(folder.join("nested.txt"), b"restorable nested contents")
            .expect("nested fixture file should be written");

        move_path_to_trash(&file)
            .expect("Foundation should move the fixture file to its volume Trash");
        move_path_to_trash(&folder)
            .expect("Foundation should move the fixture folder to its volume Trash");

        assert!(
            !file.exists(),
            "trashed file should leave its original path"
        );
        assert!(
            !folder.exists(),
            "trashed folder should leave its original path"
        );
        let file_name = file
            .file_name()
            .and_then(|name| name.to_str())
            .expect("fixture filename should be UTF-8");
        let folder_name = folder
            .file_name()
            .and_then(|name| name.to_str())
            .expect("fixture folder name should be UTF-8");
        let trashed_file = find_trashed_item(volume.mount_point(), file_name)
            .expect("file should be present under this disposable volume's .Trashes directory");
        let trashed_folder = find_trashed_item(volume.mount_point(), folder_name)
            .expect("folder should be present under this disposable volume's .Trashes directory");
        assert_eq!(
            fs::read(trashed_file).expect("trashed file bytes should remain readable"),
            b"restorable file contents"
        );
        assert_eq!(
            fs::read(trashed_folder.join("nested.txt"))
                .expect("trashed folder contents should remain readable"),
            b"restorable nested contents"
        );
    }
}
