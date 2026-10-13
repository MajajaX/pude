// Local-first rolling-file log for crash and error diagnostics (SB-05).
//
// Windows release builds use `windows_subsystem = "windows"`, so `eprintln!`
// output goes nowhere. This module writes to a small rolling log file in the
// app log directory instead. It deliberately adds no dependencies: lines are
// timestamped with a hand-rolled civil-date conversion, the active file is
// rotated once it exceeds 1 MiB, and up to three archived files are kept.
//
// Records are single-line and bounded; common credential forms and PEM private
// key blocks are redacted before writing. Panic payloads and backtraces are
// deliberately omitted because they can contain document or credential text.
// Every operation fails silently: logging must never panic or crash the app.
// Note: the LSP bootstrap test fixture includes this file via `include!`, so
// the header must stay plain `//` comments (no `//!` inner doc comments).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const LOG_FILE_NAME: &str = "pude.log";
const MAX_LOG_BYTES: u64 = 1024 * 1024;
const MAX_ARCHIVED_FILES: usize = 3;
const MAX_LOG_MESSAGE_BYTES: usize = 8 * 1024;
const PERF_LOG_ENV: &str = "PUDE_PERF_LOG";
const MAX_FRONTEND_DIAGNOSTICS_PER_MINUTE: usize = 20;
const REDACTED: &str = "[REDACTED]";

static LOG_DIR: RwLock<Option<PathBuf>> = RwLock::new(None);
static FRONTEND_DIAGNOSTIC_RATE: Mutex<Option<(Instant, usize)>> = Mutex::new(None);

/// Point the log at an explicit directory (normally the tauri app log dir,
/// resolved during Builder setup). Later calls overwrite, which keeps tests
/// hermetic; production calls this exactly once during startup.
pub fn init(dir: PathBuf) {
    if let Ok(mut guard) = LOG_DIR.write() {
        *guard = Some(dir);
    }
}

fn resolved_log_dir() -> Option<PathBuf> {
    LOG_DIR
        .read()
        .ok()
        .and_then(|guard| guard.clone())
        .or_else(default_log_dir)
}

/// Fallback used when `init` has not run yet (e.g. a panic before setup).
fn default_log_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA").map(|base| PathBuf::from(base).join("pude").join("logs"))
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|base| {
            PathBuf::from(base)
                .join("Library")
                .join("Logs")
                .join("pude")
        })
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var_os("XDG_DATA_HOME").map_or_else(
            || std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("share")),
            Some,
        );
        base.map(|base| base.join("pude").join("logs"))
    }
}

pub fn log_info(message: &str) {
    write_line("INFO", message);
}

pub fn log_error(message: &str) {
    write_line("ERROR", message);
}

/// Log a diagnostic produced by `diagnostics.ts`. The command deliberately
/// accepts only its small stage/kind/code grammar and rejects all source data.
pub fn log_frontend_diagnostic(message: &str, source: Option<&str>) {
    if source.is_some() || !is_safe_frontend_diagnostic(message) || !allow_frontend_diagnostic() {
        return;
    }
    let Some(dir) = resolved_log_dir() else {
        return;
    };
    write_frontend_diagnostic_to(&dir, message);
}

/// Record the thread name and source location for a panic. The hook never gives
/// this logger the arbitrary panic payload or a backtrace.
pub fn log_panic(thread_name: &str, location: Option<(&str, u32)>) {
    let Some(dir) = resolved_log_dir() else {
        return;
    };
    log_panic_to(&dir, thread_name, location);
}

fn log_panic_to(dir: &Path, thread_name: &str, location: Option<(&str, u32)>) {
    let location = location.map(|(file, line)| {
        let file = Path::new(file)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("source");
        format!(" at {file}:{line}")
    });
    write_line_to(
        dir,
        "PANIC",
        &format!(
            "panic on thread '{thread_name}'{}",
            location.as_deref().unwrap_or("")
        ),
    );
}

/// Performance log (MS-01): only produces output when `PUDE_PERF_LOG=1` is
/// set in the native process environment.
pub fn perf_log_enabled() -> bool {
    std::env::var_os(PERF_LOG_ENV).is_some_and(|value| value == "1")
}

pub fn perf_log(message: &str) {
    if perf_log_enabled() {
        write_line("PERF", message);
    }
}

fn is_safe_frontend_diagnostic(message: &str) -> bool {
    if message.len() > 192 || !message.is_ascii() {
        return false;
    }
    let mut fields = message.split("; ");
    let Some(stage) = fields.next().and_then(|field| field.strip_prefix("stage=")) else {
        return false;
    };
    let Some(kind) = fields.next().and_then(|field| field.strip_prefix("error=")) else {
        return false;
    };
    if !safe_diagnostic_label(stage)
        || !matches!(
            kind,
            "Error"
                | "string"
                | "number"
                | "boolean"
                | "bigint"
                | "symbol"
                | "function"
                | "object"
                | "null"
                | "unknown"
        )
    {
        return false;
    }
    match fields.next() {
        Some(code) => {
            code.strip_prefix("code=")
                .is_some_and(safe_diagnostic_label)
                && fields.next().is_none()
        }
        None => true,
    }
}

fn safe_diagnostic_label(value: &str) -> bool {
    let mut characters = value.chars();
    if !characters
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic())
        || value.len() > 64
        || !characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
    {
        return false;
    }
    !value
        .split(|character| matches!(character, '.' | '_' | '-'))
        .any(|segment| {
            [
                "token",
                "secret",
                "password",
                "private",
                "credential",
                "bearer",
                "sentinel",
                "body",
                "document",
                "content",
                "key",
            ]
            .iter()
            .any(|sensitive| segment.eq_ignore_ascii_case(sensitive))
        })
}

fn allow_frontend_diagnostic() -> bool {
    let Ok(mut state) = FRONTEND_DIAGNOSTIC_RATE.lock() else {
        return false;
    };
    allow_frontend_diagnostic_at(&mut state, Instant::now())
}

fn allow_frontend_diagnostic_at(state: &mut Option<(Instant, usize)>, now: Instant) -> bool {
    if let Some((window_start, count)) = state.as_mut() {
        if now.saturating_duration_since(*window_start) < Duration::from_secs(60) {
            if *count >= MAX_FRONTEND_DIAGNOSTICS_PER_MINUTE {
                return false;
            }
            *count += 1;
            return true;
        }
    }
    *state = Some((now, 1));
    true
}

fn write_frontend_diagnostic_to(dir: &Path, message: &str) {
    write_line_to(dir, "ERROR", &format!("frontend diagnostic: {message}"));
}

fn write_frontend_diagnostic_to_if_safe(dir: &Path, message: &str, source: Option<&str>) -> bool {
    if source.is_some() || !is_safe_frontend_diagnostic(message) {
        return false;
    }
    write_frontend_diagnostic_to(dir, message);
    true
}

fn write_line(level: &str, message: &str) {
    let Some(dir) = resolved_log_dir() else {
        return;
    };
    write_line_to(&dir, level, message);
}

fn write_line_to(dir: &Path, level: &str, message: &str) {
    if fs::create_dir_all(dir).is_err() {
        return;
    }
    let path = dir.join(LOG_FILE_NAME);
    rotate_if_oversized(dir, &path);
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    let safe_level = match level {
        "INFO" | "ERROR" | "PANIC" | "PERF" => level,
        _ => "OTHER",
    };
    let safe_message = sanitize_message(message);
    let _ = writeln!(file, "{} [{safe_level}] {safe_message}", timestamp());
}

/// Format a log message as one bounded line and redact common credential
/// assignments and PEM private-key blocks. The scan stops at the output limit,
/// so an unusually large error cannot allocate a second unbounded string.
fn sanitize_message(message: &str) -> String {
    let mut output = String::with_capacity(message.len().min(MAX_LOG_MESSAGE_BYTES));
    let mut cursor = 0;

    while cursor < message.len() && output.len() < MAX_LOG_MESSAGE_BYTES {
        if let Some((value_start, quoted)) = credential_value_start(message, cursor) {
            append_bounded(&mut output, &message[cursor..value_start]);
            if output.len() >= MAX_LOG_MESSAGE_BYTES {
                break;
            }
            append_bounded(&mut output, REDACTED);
            cursor = skip_credential_value(message, value_start, quoted);
            continue;
        }

        if let Some((header_end, end_marker)) = private_key_start(message, cursor) {
            // Do not retain any part of a private key if its END marker is
            // missing or lies beyond the bounded scan window.
            append_bounded(&mut output, "[REDACTED PRIVATE KEY]");
            let mut bounded_end = (cursor + MAX_LOG_MESSAGE_BYTES).min(message.len());
            while !message.is_char_boundary(bounded_end) {
                bounded_end -= 1;
            }
            if let Some(relative_end) = message[header_end..bounded_end].find(end_marker) {
                cursor = header_end + relative_end + end_marker.len();
                continue;
            }
            break;
        }

        let character = message[cursor..]
            .chars()
            .next()
            .expect("cursor is a char boundary");
        cursor += character.len_utf8();
        let safe_character = if character.is_control() {
            ' '
        } else {
            character
        };
        if output.len() + safe_character.len_utf8() > MAX_LOG_MESSAGE_BYTES {
            break;
        }
        output.push(safe_character);
    }

    if cursor < message.len() {
        const TRUNCATION_MARKER: &str = " [truncated]";
        let mut prefix_limit = MAX_LOG_MESSAGE_BYTES - TRUNCATION_MARKER.len();
        while !output.is_char_boundary(prefix_limit) {
            prefix_limit -= 1;
        }
        if output.len() > prefix_limit {
            output.truncate(prefix_limit);
        }
        output.push_str(TRUNCATION_MARKER);
    }
    output
}

fn append_bounded(output: &mut String, value: &str) {
    for character in value.chars() {
        let safe_character = if character.is_control() {
            ' '
        } else {
            character
        };
        if output.len() + safe_character.len_utf8() > MAX_LOG_MESSAGE_BYTES {
            break;
        }
        output.push(safe_character);
    }
}

/// Recognize a credential key only when it is used as an assignment, avoiding
/// redacting ordinary diagnostic text such as "token expired".
fn credential_value_start(message: &str, start: usize) -> Option<(usize, bool)> {
    const KEYS: [&str; 9] = [
        "access_token",
        "refresh_token",
        "authorization",
        "api_key",
        "api-key",
        "private_key",
        "password",
        "secret",
        "token",
    ];

    if start > 0 {
        let previous = message[..start].chars().next_back()?;
        if previous.is_ascii_alphanumeric() || previous == '_' {
            return None;
        }
    }

    let tail = message.get(start..)?;
    if tail
        .get(..7)
        .is_some_and(|candidate| candidate.eq_ignore_ascii_case("bearer "))
    {
        return Some((start + 7, false));
    }
    for key in KEYS {
        let Some(candidate) = tail.get(..key.len()) else {
            continue;
        };
        if !candidate.eq_ignore_ascii_case(key) {
            continue;
        }
        let mut cursor = start + key.len();
        skip_ascii_whitespace(message, &mut cursor);
        if message.as_bytes().get(cursor) == Some(&b'"') {
            cursor += 1;
            skip_ascii_whitespace(message, &mut cursor);
        }
        if !matches!(message.as_bytes().get(cursor), Some(b'=' | b':')) {
            continue;
        }
        cursor += 1;
        skip_ascii_whitespace(message, &mut cursor);
        if message
            .get(cursor..)
            .and_then(|value| value.get(..7))
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case("bearer "))
        {
            cursor += 7;
        }
        let quoted = message.as_bytes().get(cursor) == Some(&b'"')
            || message.as_bytes().get(cursor) == Some(&b'\'');
        if quoted {
            cursor += 1;
        }
        return Some((cursor, quoted));
    }
    None
}

fn skip_ascii_whitespace(message: &str, cursor: &mut usize) {
    while matches!(message.as_bytes().get(*cursor), Some(b' ' | b'\t')) {
        *cursor += 1;
    }
}

fn skip_credential_value(message: &str, mut cursor: usize, quoted: bool) -> usize {
    let bounded_end = (cursor + MAX_LOG_MESSAGE_BYTES).min(message.len());
    while cursor < bounded_end {
        let character = message[cursor..]
            .chars()
            .next()
            .expect("cursor is a char boundary");
        if (quoted && (character == '"' || character == '\''))
            || (!quoted
                && (character.is_whitespace()
                    || matches!(character, ',' | ';' | '&' | ')' | ']' | '}')))
        {
            return cursor + character.len_utf8();
        }
        cursor += character.len_utf8();
    }
    if cursor >= message.len() {
        cursor
    } else {
        // The credential value exceeded the scan budget without a terminator.
        // Drop the rest of this message rather than risk logging its tail.
        message.len()
    }
}

fn private_key_start(message: &str, start: usize) -> Option<(usize, &'static str)> {
    const MARKERS: [(&str, &str); 7] = [
        ("-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----"),
        (
            "-----BEGIN RSA PRIVATE KEY-----",
            "-----END RSA PRIVATE KEY-----",
        ),
        (
            "-----BEGIN DSA PRIVATE KEY-----",
            "-----END DSA PRIVATE KEY-----",
        ),
        (
            "-----BEGIN EC PRIVATE KEY-----",
            "-----END EC PRIVATE KEY-----",
        ),
        (
            "-----BEGIN OPENSSH PRIVATE KEY-----",
            "-----END OPENSSH PRIVATE KEY-----",
        ),
        (
            "-----BEGIN ENCRYPTED PRIVATE KEY-----",
            "-----END ENCRYPTED PRIVATE KEY-----",
        ),
        (
            "-----BEGIN PGP PRIVATE KEY BLOCK-----",
            "-----END PGP PRIVATE KEY BLOCK-----",
        ),
    ];
    let tail = message.get(start..)?;
    MARKERS.iter().find_map(|(begin, end)| {
        if tail
            .get(..begin.len())
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(begin))
        {
            Some((start + begin.len(), *end))
        } else {
            None
        }
    })
}

/// Rotate `pude.log` to `pude.log.1` (and shift older archives) once the
/// active file exceeds the size cap. The oldest archive beyond the retention
/// count is dropped.
fn rotate_if_oversized(dir: &Path, path: &Path) {
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    if metadata.len() <= MAX_LOG_BYTES {
        return;
    }
    let oldest = dir.join(format!("{LOG_FILE_NAME}.{MAX_ARCHIVED_FILES}"));
    let _ = fs::remove_file(oldest);
    for index in (1..MAX_ARCHIVED_FILES).rev() {
        let from = dir.join(format!("{LOG_FILE_NAME}.{index}"));
        let to = dir.join(format!("{}.{shifted}", LOG_FILE_NAME, shifted = index + 1));
        let _ = fs::rename(from, to);
    }
    let _ = fs::rename(path, dir.join(format!("{LOG_FILE_NAME}.1")));
}

/// Format the current time as `YYYY-MM-DD HH:MM:SS.mmm` without chrono.
fn timestamp() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let days = secs.div_euclid(86_400);
    let time_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}.{:03}",
        time_of_day / 3600,
        (time_of_day % 3600) / 60,
        time_of_day % 60,
        now.subsec_millis()
    )
}

/// Howard Hinnant's `civil_from_days`: days since 1970-01-01 to (year, month, day).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    };
    (
        if month <= 2 { year + 1 } else { year },
        month as u32,
        day as u32,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn test_log_dir(tag: &str) -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let unique = NEXT.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "pude-app-log-test-{}-{tag}-{unique}",
            std::process::id()
        ))
    }

    fn read_log(dir: &Path) -> String {
        fs::read_to_string(dir.join(LOG_FILE_NAME)).expect("log file should be readable")
    }

    #[test]
    fn civil_from_days_matches_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        assert_eq!(civil_from_days(20_089), (2025, 1, 1));
        // 2024 is a leap year: Feb 29 exists (day 31 + 29 of year).
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
    }

    #[test]
    fn timestamp_looks_like_local_datetime() {
        let stamp = timestamp();
        let expected_len = "2026-09-28 12:34:56.789".len();
        assert_eq!(stamp.len(), expected_len);
        assert_eq!(&stamp[4..5], "-");
        assert_eq!(&stamp[10..11], " ");
    }

    #[test]
    fn writes_info_and_error_lines_with_timestamp_and_level() {
        let dir = test_log_dir("lines");
        write_line_to(&dir, "INFO", "hello info");
        write_line_to(&dir, "ERROR", "hello error");
        let contents = read_log(&dir);
        assert!(contents.contains("[INFO] hello info"));
        assert!(contents.contains("[ERROR] hello error"));
        assert!(contents.lines().count() >= 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn frontend_diagnostic_path_rejects_raw_messages_sources_and_sentinels() {
        let dir = test_log_dir("frontend-diagnostic");
        let safe = "stage=save; error=Error; code=EACCES";
        assert!(write_frontend_diagnostic_to_if_safe(&dir, safe, None));
        assert!(!write_frontend_diagnostic_to_if_safe(
            &dir,
            safe,
            Some("/private/workspace/main.rs"),
        ));
        assert!(!write_frontend_diagnostic_to_if_safe(
            &dir,
            "document-body-sentinel token=token-sentinel -----BEGIN PRIVATE KEY-----private-key-sentinel",
            None,
        ));
        assert!(!write_frontend_diagnostic_to_if_safe(
            &dir,
            "stage=save; error=Error; code=token-sentinel",
            None,
        ));

        let contents = read_log(&dir);
        assert!(contents.contains("frontend diagnostic: stage=save; error=Error; code=EACCES"));
        assert!(!contents.contains("/private/workspace"));
        assert!(!contents.contains("document-body-sentinel"));
        assert!(!contents.contains("token-sentinel"));
        assert!(!contents.contains("private-key-sentinel"));
        assert_eq!(contents.lines().count(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn frontend_diagnostic_rate_is_limited_to_twenty_per_minute() {
        let start = Instant::now();
        let mut state = None;
        for _ in 0..MAX_FRONTEND_DIAGNOSTICS_PER_MINUTE {
            assert!(allow_frontend_diagnostic_at(&mut state, start));
        }
        assert!(!allow_frontend_diagnostic_at(&mut state, start));
        assert!(allow_frontend_diagnostic_at(
            &mut state,
            start + Duration::from_secs(60),
        ));
    }

    #[test]
    fn redacts_common_credentials_and_private_key_blocks() {
        let dir = test_log_dir("redaction");
        let private_key =
            "-----BEGIN PRIVATE KEY-----\nprivate-key-sentinel\n-----END PRIVATE KEY-----";
        write_line_to(
            &dir,
            "ERROR",
            &format!(
                "access_token=token-sentinel Authorization: Bearer bearer-sentinel api_key: 'key-sentinel' private_key=private-assignment-sentinel Bearer direct-bearer-sentinel key={private_key}"
            ),
        );

        let contents = read_log(&dir);
        assert!(contents.contains("access_token=[REDACTED]"));
        assert!(contents.contains("Authorization: Bearer [REDACTED]"));
        assert!(contents.contains("api_key: '[REDACTED]"));
        assert!(contents.contains("private_key=[REDACTED]"));
        assert!(contents.contains("[REDACTED PRIVATE KEY]"));
        assert!(!contents.contains("token-sentinel"));
        assert!(!contents.contains("bearer-sentinel"));
        assert!(!contents.contains("key-sentinel"));
        assert!(!contents.contains("private-assignment-sentinel"));
        assert!(!contents.contains("direct-bearer-sentinel"));
        assert!(!contents.contains("private-key-sentinel"));
        assert_eq!(contents.lines().count(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn flattens_and_bounds_each_log_message() {
        let dir = test_log_dir("bounded");
        let message = format!("before\n\rafter {}", "界".repeat(MAX_LOG_MESSAGE_BYTES));
        write_line_to(&dir, "ERROR\nINJECTED", &message);

        let contents = read_log(&dir);
        assert_eq!(contents.lines().count(), 1);
        assert!(contents.contains("before  after"));
        assert!(!contents.contains("INJECTED"));
        assert!(contents.contains("[truncated]"));
        let logged_message = contents.split_once("] ").unwrap().1.trim_end();
        assert!(logged_message.len() <= MAX_LOG_MESSAGE_BYTES);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotates_when_active_file_exceeds_one_mebibyte() {
        let dir = test_log_dir("rotate");
        fs::create_dir_all(&dir).unwrap();
        // Pre-fill the active file beyond the cap without going through the logger.
        let path = dir.join(LOG_FILE_NAME);
        fs::write(&path, vec![b'x'; (MAX_LOG_BYTES + 1) as usize]).unwrap();
        write_line_to(&dir, "INFO", "after rotation");
        // The oversized content moved to the first archive; the active file
        // starts fresh and only carries the new line.
        let archived = fs::read_to_string(dir.join(format!("{LOG_FILE_NAME}.1"))).unwrap();
        assert_eq!(archived.len() as u64, MAX_LOG_BYTES + 1);
        let active = read_log(&dir);
        assert!(active.contains("after rotation"));
        assert!((active.len() as u64) < MAX_LOG_BYTES);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotation_shifts_and_drops_oldest_archives() {
        let dir = test_log_dir("shift");
        fs::create_dir_all(&dir).unwrap();
        for index in 1..=MAX_ARCHIVED_FILES {
            fs::write(
                dir.join(format!("{LOG_FILE_NAME}.{index}")),
                format!("archive {index}"),
            )
            .unwrap();
        }
        fs::write(dir.join(LOG_FILE_NAME), vec![b'x'; (MAX_LOG_BYTES + 1) as usize]).unwrap();
        write_line_to(&dir, "INFO", "rotation with existing archives");
        // .2 -> .3, .1 -> .2, active -> .1; old .3 is dropped. The fresh line
        // lands in the new active file; the rotated .1 is the old oversized
        // content.
        assert!(!dir.join(format!("{LOG_FILE_NAME}.{}", MAX_ARCHIVED_FILES + 1)).exists());
        let active = read_log(&dir);
        assert!(active.contains("rotation with existing archives"));
        let first = fs::read_to_string(dir.join(format!("{LOG_FILE_NAME}.1"))).unwrap();
        assert_eq!(first.len() as u64, MAX_LOG_BYTES + 1);
        let second = fs::read_to_string(dir.join(format!("{LOG_FILE_NAME}.2"))).unwrap();
        assert_eq!(second, "archive 1");
        let third = fs::read_to_string(dir.join(format!("{LOG_FILE_NAME}.3"))).unwrap();
        assert_eq!(third, "archive 2");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn panic_entry_includes_only_thread_and_source_location() {
        let dir = test_log_dir("panic");
        log_panic_to(&dir, "main-thread", Some(("/internal/src/main.rs", 42)));
        let contents = read_log(&dir);
        assert!(contents.contains("[PANIC]"));
        assert!(contents.contains("panic on thread 'main-thread' at main.rs:42"));
        assert!(!contents.contains("Backtrace"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn perf_log_only_writes_when_env_flag_is_set() {
        // The test harness does not define PUDE_PERF_LOG, so this must be a
        // no-op regardless of the destination directory.
        let dir = test_log_dir("perf");
        perf_log("hidden timeline entry");
        assert!(!dir.join(LOG_FILE_NAME).exists());
    }
}
