use std::io::{self, BufRead, BufReader, Read, Write};

fn main() {
    #[cfg(windows)]
    if run_windows_bootstrap_test_mode() {
        return;
    }
    if let Some(first_argument) = std::env::args().nth(1) {
        // Unknown switches (for example the real `--pude-lsp-bootstrap` gate
        // arguments) make this fixture exit immediately so tests can exercise
        // the parent's early-child-exit recovery path.
        if first_argument.starts_with("--") {
            return;
        }
    }
    if std::env::args().nth(1).as_deref() == Some("crash") {
        return;
    }

    let arguments = std::env::args().collect::<Vec<_>>();
    if arguments.get(1).map(String::as_str) == Some("record-pid") {
        if let Some(pid_path) = arguments.get(2) {
            let _ = std::fs::write(pid_path, std::process::id().to_string());
        }
    }

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut input = BufReader::new(stdin.lock());
    let mut output = stdout.lock();
    let mut document_text = "";
    while let Some(message) = read_message(&mut input) {
        if message.contains("\"method\":\"textDocument/didOpen\"") {
            if message.contains("\"text\":\"window-a\"") {
                document_text = "window-a";
            } else if message.contains("\"text\":\"window-b\"") {
                document_text = "window-b";
            }
        } else if message.contains("\"method\":\"pude/document\"") {
            write_message(&mut output, &format!(
                r#"{{"jsonrpc":"2.0","id":"document","result":{{"text":"{document_text}"}}}}"#,
            ));
        } else if message.contains("\"method\":\"pude/echo\"") {
            let response =
                r#"{"jsonrpc":"2.0","id":"round-trip","result":{"echo":{"text":"hello"}}}"#;
            write_message(&mut output, response);
        } else if message.contains("\"method\":\"$/cancelRequest\"") {
            let notification =
                r#"{"jsonrpc":"2.0","method":"pude/cancelReceived","params":{"id":"round-trip"}}"#;
            write_message(&mut output, notification);
        }
    }
}

#[cfg(windows)]
fn run_windows_bootstrap_test_mode() -> bool {
    use std::ffi::c_void;
    use std::fs;
    use std::process::Command;
    use std::time::Duration;

    type Handle = *mut c_void;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const WAIT_OBJECT_0: u32 = 0;

    #[link(name = "Kernel32")]
    extern "system" {
        fn OpenEventW(access: u32, inherit: i32, name: *const u16) -> Handle;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    let args = std::env::args().collect::<Vec<_>>();
    match args.get(1).map(String::as_str) {
        Some("--pude-lsp-test-descendant") => {
            let Some(pid_path) = args.get(2) else {
                return true;
            };
            let _ = fs::write(pid_path, std::process::id().to_string());
            loop {
                std::thread::sleep(Duration::from_secs(1));
            }
        }
        Some("--pude-lsp-test-bootstrap") => {
            let (Some(event_name), Some(ready_path), Some(pid_path)) =
                (args.get(2), args.get(3), args.get(4))
            else {
                return true;
            };
            let wide_name = event_name
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let event = unsafe { OpenEventW(SYNCHRONIZE, 0, wide_name.as_ptr()) };
            if event.is_null() {
                return true;
            }
            let _ = fs::write(ready_path, "waiting");
            let wait = unsafe { WaitForSingleObject(event, 15_000) };
            unsafe {
                let _ = CloseHandle(event);
            }
            if wait != WAIT_OBJECT_0 {
                return true;
            }
            let Ok(mut child) = Command::new(std::env::current_exe().unwrap())
                .arg("--pude-lsp-test-descendant")
                .arg(pid_path)
                .spawn()
            else {
                return true;
            };
            let _ = child.wait();
            return true;
        }
        _ => false,
    }
}

fn write_message(writer: &mut impl Write, message: &str) {
    let _ = write!(writer, "Content-Length: {}\r\n\r\n", message.len());
    let _ = writer.write_all(message.as_bytes());
    let _ = writer.flush();
}

fn read_message(reader: &mut impl BufRead) -> Option<String> {
    let mut content_length = None;
    loop {
        let mut line = Vec::new();
        if reader.read_until(b'\n', &mut line).ok()? == 0 {
            return None;
        }
        while matches!(line.last(), Some(b'\n' | b'\r')) {
            line.pop();
        }
        if line.is_empty() {
            break;
        }
        let line = std::str::from_utf8(&line).ok()?;
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse::<usize>().ok();
            }
        }
    }
    let mut body = vec![0; content_length?];
    reader.read_exact(&mut body).ok()?;
    String::from_utf8(body).ok()
}
