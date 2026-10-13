// Shared Windows LSP bootstrap protocol.
//
// This file is the single source of truth for the bootstrap wire protocol
// between the desktop app and its bootstrap child process. It is compiled in
// two places:
//
// - as the `lsp_bootstrap_protocol` module of the desktop binary (declared
//   `#[cfg(windows)]` in `main.rs`), whose `main` calls `run_if_requested`
//   before starting Tauri;
// - verbatim, via `include!`, into the test helper binary under
//   `tests/fixtures/`, so integration tests launch a child that speaks
//   exactly the same protocol instead of the test harness binary (which has
//   no bootstrap branch and exits with an unrecognized-option error).
//
// The module is std-only so the helper can be built with a bare `rustc`
// invocation from the tests. The payload uses a small length-prefixed binary
// encoding (no JSON) so both sides decode it identically without external
// crates. Plain comments only: the file is also `include!`d inside a module
// block, where inner doc comments and inner attributes are not permitted.
use std::ffi::{c_void, OsStr};
use std::fs::File;
use std::io::{self, Read};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;
use std::process::Command;
use std::time::Duration;

pub const LSP_BOOTSTRAP_ARGUMENT: &str = "--pude-lsp-bootstrap";
pub const MAX_LSP_BOOTSTRAP_PAYLOAD_BYTES: usize = 128 * 1024;
const LSP_BOOTSTRAP_WAIT: Duration = Duration::from_secs(15);

const SYNCHRONIZE: u32 = 0x0010_0000;
const GENERIC_READ: u32 = 0x8000_0000;
const OPEN_EXISTING: u32 = 3;
const FILE_ATTRIBUTE_NORMAL: u32 = 0x0000_0080;
const WAIT_OBJECT_0: u32 = 0;
const INVALID_HANDLE_VALUE: isize = -1;

type Handle = *mut c_void;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootstrapPayload {
    pub executable: String,
    pub args: Vec<String>,
}

pub fn encode_payload(payload: &BootstrapPayload) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    write_length_prefixed_string(&mut body, &payload.executable)?;
    write_u32(&mut body, payload.args.len() as u32);
    for argument in &payload.args {
        write_length_prefixed_string(&mut body, argument)?;
    }
    if body.is_empty() || body.len() > MAX_LSP_BOOTSTRAP_PAYLOAD_BYTES {
        return Err("LSP bootstrap payload exceeds the size limit.".to_string());
    }
    let mut framed = Vec::with_capacity(body.len() + 4);
    write_u32(&mut framed, body.len() as u32);
    framed.extend_from_slice(&body);
    Ok(framed)
}

fn write_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn write_length_prefixed_string(output: &mut Vec<u8>, value: &str) -> Result<(), String> {
    let length = u32::try_from(value.len())
        .map_err(|_| "LSP bootstrap payload field is too large.".to_string())?;
    write_u32(output, length);
    output.extend_from_slice(value.as_bytes());
    Ok(())
}

fn decode_payload_body(body: &[u8]) -> Result<BootstrapPayload, String> {
    const MAX_ARGS: usize = 128;
    let mut cursor = 0usize;
    let executable = read_length_prefixed_string(body, &mut cursor)?;
    let arg_count = read_u32(body, &mut cursor)? as usize;
    if arg_count > MAX_ARGS {
        return Err("LSP bootstrap payload argument count is invalid.".to_string());
    }
    let mut args = Vec::with_capacity(arg_count);
    for _ in 0..arg_count {
        args.push(read_length_prefixed_string(body, &mut cursor)?);
    }
    if cursor != body.len() {
        return Err("LSP bootstrap payload contains trailing data.".to_string());
    }
    Ok(BootstrapPayload { executable, args })
}

fn read_u32(body: &[u8], cursor: &mut usize) -> Result<u32, String> {
    let end = cursor
        .checked_add(4)
        .filter(|end| *end <= body.len())
        .ok_or_else(|| "LSP bootstrap payload is truncated.".to_string())?;
    let value = u32::from_le_bytes(body[*cursor..end].try_into().unwrap());
    *cursor = end;
    Ok(value)
}

fn read_length_prefixed_string(body: &[u8], cursor: &mut usize) -> Result<String, String> {
    let length = read_u32(body, cursor)? as usize;
    let end = cursor
        .checked_add(length)
        .filter(|end| *end <= body.len())
        .ok_or_else(|| "LSP bootstrap payload is truncated.".to_string())?;
    let value = String::from_utf8(body[*cursor..end].to_vec())
        .map_err(|_| "LSP bootstrap payload is not valid UTF-8.".to_string())?;
    *cursor = end;
    Ok(value)
}

#[link(name = "Kernel32")]
extern "system" {
    fn OpenEventW(access: u32, inherit: i32, name: *const u16) -> Handle;
    fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    fn CloseHandle(handle: Handle) -> i32;
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

/// Runs the bootstrap child protocol when the process was launched with
/// `--pude-lsp-bootstrap <gate event> <payload pipe>`. Returns `true` when the
/// argument matched and the process is expected to exit inside this call, or
/// `false` when the caller should continue with its normal `main`.
pub fn run_if_requested() -> bool {
    let mut arguments = std::env::args_os();
    let _executable = arguments.next();
    let Some(mode) = arguments.next() else {
        return false;
    };
    if mode != OsStr::new(LSP_BOOTSTRAP_ARGUMENT) {
        return false;
    }
    let (Some(event_name), Some(pipe_name)) = (arguments.next(), arguments.next()) else {
        crate::app_log::log_error("LSP bootstrap is missing its gate or payload pipe.");
        return true;
    };
    if arguments.next().is_some() {
        crate::app_log::log_error("LSP bootstrap received unexpected command-line arguments.");
        return true;
    }

    let event_name = wide_os(&event_name);
    let event = unsafe { OpenEventW(SYNCHRONIZE, 0, event_name.as_ptr()) };
    if event.is_null() {
        crate::app_log::log_error(&format!(
            "LSP bootstrap could not open its startup gate. {}",
            io::Error::last_os_error()
        ));
        return true;
    }
    let wait = unsafe {
        WaitForSingleObject(
            event,
            LSP_BOOTSTRAP_WAIT.as_millis().min(u32::MAX as u128) as u32,
        )
    };
    unsafe {
        let _ = CloseHandle(event);
    }
    if wait != WAIT_OBJECT_0 {
        crate::app_log::log_error(&format!("LSP bootstrap startup gate timed out or failed ({wait})."));
        return true;
    }

    match receive_payload(&pipe_name).and_then(run_server) {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            crate::app_log::log_error(&format!("LSP bootstrap failed. {error}"));
            std::process::exit(1);
        }
    }
}

fn receive_payload(pipe_name: &OsStr) -> Result<BootstrapPayload, String> {
    let pipe_name = wide_os(pipe_name);
    let handle = unsafe {
        CreateFileW(
            pipe_name.as_ptr(),
            GENERIC_READ,
            0,
            std::ptr::null_mut(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle as isize == INVALID_HANDLE_VALUE {
        return Err(format!(
            "Unable to open LSP bootstrap payload pipe. {}",
            io::Error::last_os_error()
        ));
    }
    let mut pipe = unsafe { File::from_raw_handle(handle) };
    let mut length = [0u8; 4];
    pipe.read_exact(&mut length)
        .map_err(|error| format!("Unable to read LSP bootstrap payload length. {error}"))?;
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > MAX_LSP_BOOTSTRAP_PAYLOAD_BYTES {
        return Err("LSP bootstrap payload length is invalid.".to_string());
    }
    let mut body = vec![0; length];
    pipe.read_exact(&mut body)
        .map_err(|error| format!("Unable to read LSP bootstrap payload. {error}"))?;
    decode_payload_body(&body)
}

fn run_server(payload: BootstrapPayload) -> Result<i32, String> {
    let status = Command::new(payload.executable)
        .args(payload.args)
        .status()
        .map_err(|error| format!("Unable to start the approved LSP server. {error}"))?;
    Ok(status.code().unwrap_or(1))
}

fn wide_os(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}
