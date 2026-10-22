use std::io;
use std::os::windows::ffi::OsStrExt;
use std::process::{Command, Stdio};

const CTRL_C_EVENT: u32 = 0;
const CTRL_BREAK_EVENT: u32 = 1;

#[link(name = "kernel32")]
extern "system" {
    fn SetConsoleCtrlHandler(
        handler: Option<unsafe extern "system" fn(u32) -> i32>,
        add: i32,
    ) -> i32;
    fn OpenEventW(access: u32, inherit: i32, name: *const u16) -> *mut std::ffi::c_void;
    fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
}

/// Ctrl+C and Ctrl+Break reach every process on the console. The shell and its jobs
/// handle them; the bootstrap must outlive them, or the whole terminal ends.
unsafe extern "system" fn keep_running_on_interrupt(event: u32) -> i32 {
    (event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT) as i32
}

fn run() -> Result<i32, String> {
    // A handler, unlike SetConsoleCtrlHandler(NULL, TRUE), is not inherited, so the
    // shell and its children still receive the interrupt.
    if unsafe { SetConsoleCtrlHandler(Some(keep_running_on_interrupt), 1) } == 0 {
        return Err(format!(
            "Unable to protect the terminal bootstrap from interrupts: {}",
            io::Error::last_os_error()
        ));
    }
    let mut arguments = std::env::args_os().skip(1);
    let (Some(event_name), Some(shell), Some(working_directory)) =
        (arguments.next(), arguments.next(), arguments.next())
    else {
        return Err(
            "Terminal bootstrap requires its startup event, shell and working directory.".into(),
        );
    };
    if !event_name
        .to_string_lossy()
        .starts_with("Local\\pude-terminal-")
    {
        return Err("Invalid terminal bootstrap arguments.".into());
    }
    let wide_name = event_name
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let event = unsafe { OpenEventW(0x0010_0000, 0, wide_name.as_ptr()) };
    if event.is_null() {
        return Err(format!(
            "Unable to open the terminal startup event: {}",
            io::Error::last_os_error()
        ));
    }
    let wait = unsafe { WaitForSingleObject(event, 15_000) };
    unsafe {
        CloseHandle(event);
    }
    if wait != 0 {
        return Err(format!(
            "Terminal startup gate timed out or failed: {wait}."
        ));
    }
    Command::new(shell)
        .args(arguments)
        .current_dir(working_directory)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map(|status| status.code().unwrap_or(1))
        .map_err(|error| format!("Unable to start the terminal shell: {error}"))
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
