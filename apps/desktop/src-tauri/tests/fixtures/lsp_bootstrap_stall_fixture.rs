//! Adversarial bootstrap launcher fixture: connects to the payload pipe so the
//! parent's overlapped `ConnectNamedPipe` completes, then never reads. Used to
//! prove the parent's payload write honors its startup deadline and cancels
//! the pending I/O instead of blocking forever.

#[cfg(windows)]
fn main() {
    use std::ffi::{c_void, OsStr};
    use std::os::windows::ffi::OsStrExt;

    type Handle = *mut c_void;
    const GENERIC_READ: u32 = 0x8000_0000;
    const OPEN_EXISTING: u32 = 3;
    const FILE_ATTRIBUTE_NORMAL: u32 = 0x0000_0080;
    const INVALID_HANDLE_VALUE: isize = -1;

    #[link(name = "Kernel32")]
    extern "system" {
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share_mode: u32,
            security_attributes: *mut c_void,
            creation_disposition: u32,
            flags: u32,
            template_file: Handle,
        ) -> Handle;
    }

    let arguments = std::env::args_os().collect::<Vec<_>>();
    // The launcher arguments are `--pude-lsp-bootstrap <gate event> <pipe>`.
    let Some(pipe_name) = arguments.get(3) else {
        std::process::exit(2);
    };
    let wide = OsStr::new(pipe_name)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ,
            0,
            std::ptr::null_mut(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle as isize == INVALID_HANDLE_VALUE {
        eprintln!(
            "stall fixture CreateFile failed: {}",
            std::io::Error::last_os_error()
        );
        std::process::exit(3);
    }
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}

#[cfg(not(windows))]
fn main() {}
