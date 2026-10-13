use std::io::{self, BufRead, BufReader, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    let stdin = io::stdin();
    let mut input = BufReader::new(stdin.lock());
    let flooding = Arc::new(AtomicBool::new(false));

    while let Some(message) = read_message(&mut input) {
        if message.contains("\"method\":\"pude/burst\"") {
            let Some(sequence) = numeric_field(&message, "id") else {
                continue;
            };
            if mode == "burst" {
                write_message(
                    &format!(
                        "{{\"jsonrpc\":\"2.0\",\"method\":\"textDocument/publishDiagnostics\",\"params\":{{\"uri\":\"file:///burst.rs\",\"diagnostics\":[{{\"range\":{{\"start\":{{\"line\":0,\"character\":0}},\"end\":{{\"line\":0,\"character\":0}}}},\"message\":\"diagnostic-{sequence}\"}}]}}}}"
                    ),
                    sequence == 1,
                );
                write_message(
                    &format!(
                        "{{\"jsonrpc\":\"2.0\",\"id\":{sequence},\"result\":{{\"sequence\":{sequence}}}}}"
                    ),
                    false,
                );
            }
        } else if message.contains("\"method\":\"pude/flood\"") {
            if !flooding.swap(true, Ordering::AcqRel) {
                let flooding = Arc::clone(&flooding);
                thread::spawn(move || {
                    let mut sequence = 1u64;
                    while flooding.load(Ordering::Acquire) {
                        write_message(
                            &format!(
                                "{{\"jsonrpc\":\"2.0\",\"method\":\"textDocument/publishDiagnostics\",\"params\":{{\"uri\":\"file:///flood.rs\",\"diagnostics\":[{{\"range\":{{\"start\":{{\"line\":0,\"character\":0}},\"end\":{{\"line\":0,\"character\":0}}}},\"message\":\"flood-{sequence}\"}}]}}}}"
                            ),
                            false,
                        );
                        sequence += 1;
                        thread::sleep(Duration::from_millis(1));
                    }
                });
            }
        } else if message.contains("\"method\":\"$/cancelRequest\"") {
            if let Some(request_id) = numeric_field(&message, "id") {
                flooding.store(false, Ordering::Release);
                write_message(
                    &format!(
                        "{{\"jsonrpc\":\"2.0\",\"method\":\"pude/cancelReceived\",\"params\":{{\"id\":{request_id}}}}}"
                    ),
                    false,
                );
            }
        }
    }
}

fn write_message(message: &str, split_header: bool) {
    let body = message.as_bytes();
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    let stdout = io::stdout();
    let mut output = stdout.lock();
    if split_header {
        let midpoint = header.len() / 2;
        let _ = output.write_all(&header.as_bytes()[..midpoint]);
        let _ = output.flush();
        thread::sleep(Duration::from_millis(1));
        let _ = output.write_all(&header.as_bytes()[midpoint..]);
    } else {
        let _ = output.write_all(header.as_bytes());
    }
    let split = (body.len() / 2).max(1);
    let _ = output.write_all(&body[..split]);
    let _ = output.flush();
    let _ = output.write_all(&body[split..]);
    let _ = output.flush();
}

fn numeric_field(message: &str, field: &str) -> Option<u64> {
    let marker = format!("\"{field}\":");
    let value = message.split_once(&marker)?.1.trim_start();
    let digits = value
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>();
    digits.parse().ok()
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
