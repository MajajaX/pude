//! Filesystem commands: directory listing, file read/save, path
//! create/rename/delete, and text decoding/serialization. Extracted from
//! main.rs. Shared helpers (wire paths, atomic-save infrastructure,
//! fingerprints) stay in main.rs and are used via `crate::` paths.

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io;
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt as UnixMetadataExt;
#[cfg(windows)]
use std::os::windows::fs::MetadataExt as WindowsMetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use tauri::{State, WebviewWindow};

#[cfg(test)]
use crate::atomic_replace;
use crate::blocking::BlockingClass;
use crate::platform_trash;
use crate::{
    checked_wire_path, content_fingerprint, decode_text_bytes, decode_wire_path,
    format_atomic_save_error, format_limited_read_error, is_windows_reparse_point,
    path_file_identity, path_lock, preferred_line_ending, read_file_with_metadata, run_blocking,
    save_file_atomically, save_lock_key, serialize_save_content, timestamp, wire_path, AppState,
    FileSnapshot, QuitGateState, ReadFileResult, MAX_FILE_READ_BYTES,
};
#[cfg(test)]
use uuid::Uuid;

const MAX_IMAGE_PREVIEW_BYTES: u64 = 8 * 1024 * 1024;
const MAX_IMAGE_PREVIEW_DIMENSION: u32 = 16_384;
const MAX_IMAGE_PREVIEW_PIXELS: u64 = 16_777_216;
const MAX_DIRECTORY_LISTING_ENTRIES: usize = 10_000;
const MAX_DIRECTORY_LISTING_BYTES: usize = 4 * 1024 * 1024;
const MAX_PENDING_DIRECTORY_CANCELLATIONS: usize = 128;

#[cfg(test)]
#[path = "filesystem_performance_tests.rs"]
mod performance_tests;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DirectoryEntry {
    name: String,
    path: String,
    kind: String,
    size: Option<u64>,
    modified_at: Option<u128>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DirectoryPartialError {
    kind: String,
    count: usize,
    message: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectoryListingResult {
    entries: Vec<DirectoryEntry>,
    partial_error: Option<DirectoryPartialError>,
    incomplete: bool,
    stop_reason: Option<String>,
    max_entries: usize,
    scanned_entries: usize,
    entries_bytes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveFileResult {
    modified_at: u128,
    size: usize,
    fingerprint: String,
    identity: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAsDestinationInspection {
    exists: bool,
    token: String,
}

#[tauri::command]
pub(crate) async fn list_directory(
    path: String,
    request_id: Option<String>,
) -> Result<DirectoryListingResult, String> {
    let cancellation = register_directory_listing(request_id.as_deref())?;
    run_blocking("Unable to list directory", BlockingClass::File, move || {
        let _registration = cancellation;
        let token = _registration
            .as_ref()
            .map(|registration| &registration.cancelled);
        list_directory_sync_with_cancellation(path, token.map(Arc::as_ref))
    })
    .await
}

#[tauri::command]
pub(crate) fn cancel_directory_listing(request_id: String) -> Result<bool, String> {
    cancel_directory_listing_sync(&request_id)
}

fn list_directory_sync(path: String) -> Result<DirectoryListingResult, String> {
    list_directory_sync_with_cancellation(path, None)
}

fn list_directory_sync_with_cancellation(
    path: String,
    cancellation: Option<&AtomicBool>,
) -> Result<DirectoryListingResult, String> {
    list_directory_sync_with_path_encoder(path, cancellation, checked_wire_path)
}

fn list_directory_sync_with_path_encoder(
    path: String,
    cancellation: Option<&AtomicBool>,
    encode_path: impl Fn(&Path) -> Result<String, String>,
) -> Result<DirectoryListingResult, String> {
    let directory = decode_wire_path(&path);
    let mut entries = Vec::with_capacity(MAX_DIRECTORY_LISTING_ENTRIES.min(1024));
    let mut partial_error = None;
    let mut incomplete = false;
    let mut stop_reason = None;
    let mut scanned_entries = 0_usize;
    // Reserve enough space for the response envelope and bounded partial
    // error before admitting entry JSON into the payload budget.
    const RESPONSE_ENVELOPE_RESERVE: usize = 8 * 1024;
    let entries_byte_budget = MAX_DIRECTORY_LISTING_BYTES - RESPONSE_ENVELOPE_RESERVE;
    let mut entries_bytes = 2_usize; // opening and closing brackets for `entries`
    if cancellation.is_some_and(|token| token.load(Ordering::Relaxed)) {
        return Ok(DirectoryListingResult {
            entries,
            partial_error,
            incomplete: true,
            stop_reason: Some("cancelled".to_string()),
            max_entries: MAX_DIRECTORY_LISTING_ENTRIES,
            scanned_entries,
            entries_bytes,
        });
    }
    let read_dir =
        fs::read_dir(&directory).map_err(|error| format!("Unable to read directory. {error}"))?;
    for item_result in read_dir {
        if cancellation.is_some_and(|token| token.load(Ordering::Relaxed)) {
            incomplete = true;
            stop_reason = Some("cancelled".to_string());
            break;
        }
        scanned_entries = scanned_entries.saturating_add(1);
        if scanned_entries > MAX_DIRECTORY_LISTING_ENTRIES {
            incomplete = true;
            stop_reason = Some("entryLimit".to_string());
            break;
        }
        let item = match item_result {
            Ok(item) => item,
            Err(error) => {
                set_directory_partial_error(&mut partial_error, "entry", error);
                continue;
            }
        };
        let item_path = item.path();
        let wire_item_path = match encode_path(&item_path) {
            Ok(path) => path,
            Err(error) => {
                set_directory_partial_error(&mut partial_error, "unsupported_path", error);
                continue;
            }
        };
        // DirEntry::file_type() reuses the directory enumerator's own
        // data (FindNextFile on Windows, d_type on Unix) instead of opening a
        // fresh handle per entry with fs::symlink_metadata. DirEntry's
        // metadata() is equally symlink-safe and costs no extra syscall on
        // Windows, so size/mtime stay free there; on Unix they are skipped
        // until a consumer actually needs them.
        let file_type = match item.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                set_directory_partial_error(&mut partial_error, "metadata", error);
                continue;
            }
        };
        let kind = if file_type.is_symlink() {
            "symlink"
        } else if file_type.is_dir() {
            "directory"
        } else {
            "file"
        };
        #[cfg(windows)]
        let (size, modified_at) = match item.metadata() {
            Ok(metadata) => {
                let modified_at = match metadata.modified() {
                    Ok(modified_at) => timestamp(modified_at),
                    Err(error) => {
                        set_directory_partial_error(&mut partial_error, "metadata", error);
                        None
                    }
                };
                (
                    if file_type.is_file() {
                        Some(metadata.len())
                    } else {
                        None
                    },
                    modified_at,
                )
            }
            Err(error) => {
                set_directory_partial_error(&mut partial_error, "metadata", error);
                (None, None)
            }
        };
        #[cfg(not(windows))]
        let (size, modified_at) = (None, None);
        let name = item.file_name().to_string_lossy().to_string();
        let kind = kind.to_string();
        let entry = DirectoryEntry {
            name,
            path: wire_item_path,
            kind,
            size,
            modified_at,
        };
        let entry_bytes = serde_json::to_vec(&entry)
            .map_err(|error| format!("Unable to encode directory entry. {error}"))?
            .len();
        let separator_bytes = usize::from(!entries.is_empty());
        let next_entries_bytes = entries_bytes
            .saturating_add(separator_bytes)
            .saturating_add(entry_bytes);
        if next_entries_bytes > entries_byte_budget {
            incomplete = true;
            stop_reason = Some("byteLimit".to_string());
            break;
        }
        entries_bytes = next_entries_bytes;
        entries.push(entry);
    }
    entries.sort_by_cached_key(|entry| {
        let name = entry.name.to_lowercase();
        let directory_rank = if entry.kind == "directory" {
            0_u8
        } else {
            1_u8
        };
        (directory_rank, name)
    });
    if cancellation.is_some_and(|token| token.load(Ordering::Relaxed)) {
        incomplete = true;
        stop_reason = Some("cancelled".to_string());
    }
    Ok(DirectoryListingResult {
        entries,
        partial_error,
        incomplete,
        stop_reason,
        max_entries: MAX_DIRECTORY_LISTING_ENTRIES,
        scanned_entries,
        entries_bytes,
    })
}

#[derive(Default)]
struct DirectoryListingCancellationRegistry {
    active: HashMap<String, Arc<AtomicBool>>,
    cancelled_before_start: VecDeque<String>,
}

static DIRECTORY_LISTING_CANCELLATIONS: OnceLock<Mutex<DirectoryListingCancellationRegistry>> =
    OnceLock::new();

fn directory_listing_cancellations() -> &'static Mutex<DirectoryListingCancellationRegistry> {
    DIRECTORY_LISTING_CANCELLATIONS
        .get_or_init(|| Mutex::new(DirectoryListingCancellationRegistry::default()))
}

struct DirectoryListingRegistration {
    request_id: String,
    cancelled: Arc<AtomicBool>,
}

impl Drop for DirectoryListingRegistration {
    fn drop(&mut self) {
        if let Ok(mut registry) = directory_listing_cancellations().lock() {
            if registry
                .active
                .get(&self.request_id)
                .is_some_and(|current| Arc::ptr_eq(current, &self.cancelled))
            {
                registry.active.remove(&self.request_id);
            }
        }
    }
}

fn register_directory_listing(
    request_id: Option<&str>,
) -> Result<Option<DirectoryListingRegistration>, String> {
    let Some(request_id) = request_id else {
        return Ok(None);
    };
    if request_id.is_empty() || request_id.len() > 128 {
        return Err("Unable to list directory. The request identifier is invalid.".to_string());
    }
    let mut registry = directory_listing_cancellations()
        .lock()
        .map_err(|_| "Unable to list directory. Cancellation is unavailable.".to_string())?;
    if registry.active.contains_key(request_id) {
        return Err("Unable to list directory. This request is already active.".to_string());
    }
    let cancelled_before_start = registry
        .cancelled_before_start
        .iter()
        .position(|pending| pending == request_id)
        .map(|index| registry.cancelled_before_start.remove(index).is_some())
        .unwrap_or(false);
    let cancelled = Arc::new(AtomicBool::new(cancelled_before_start));
    registry
        .active
        .insert(request_id.to_string(), Arc::clone(&cancelled));
    Ok(Some(DirectoryListingRegistration {
        request_id: request_id.to_string(),
        cancelled,
    }))
}

fn cancel_directory_listing_sync(request_id: &str) -> Result<bool, String> {
    if request_id.is_empty() || request_id.len() > 128 {
        return Err(
            "Unable to cancel directory listing. The request identifier is invalid.".to_string(),
        );
    }
    let mut registry = directory_listing_cancellations().lock().map_err(|_| {
        "Unable to cancel directory listing. Cancellation is unavailable.".to_string()
    })?;
    if let Some(cancelled) = registry.active.get(request_id) {
        cancelled.store(true, Ordering::Relaxed);
        Ok(true)
    } else {
        if !registry
            .cancelled_before_start
            .iter()
            .any(|pending| pending == request_id)
        {
            registry
                .cancelled_before_start
                .push_back(request_id.to_string());
            if registry.cancelled_before_start.len() > MAX_PENDING_DIRECTORY_CANCELLATIONS {
                registry.cancelled_before_start.pop_front();
            }
        }
        Ok(true)
    }
}

fn set_directory_partial_error(
    partial_error: &mut Option<DirectoryPartialError>,
    kind: &str,
    error: impl std::fmt::Display,
) {
    let message = error.to_string().chars().take(1024).collect();
    if let Some(partial_error) = partial_error {
        partial_error.count = partial_error.count.saturating_add(1);
    } else {
        *partial_error = Some(DirectoryPartialError {
            kind: kind.to_string(),
            count: 1,
            message,
        });
    }
}

#[tauri::command]
pub(crate) async fn read_file(path: String) -> Result<ReadFileResult, String> {
    run_blocking("Unable to read file", BlockingClass::File, move || {
        read_file_sync(path)
    })
    .await
}

#[tauri::command]
pub(crate) async fn read_workspace_image(
    path: String,
    workspace: String,
) -> Result<tauri::ipc::Response, String> {
    run_blocking("Unable to preview image", BlockingClass::File, move || {
        read_workspace_image_sync(path, workspace).map(tauri::ipc::Response::new)
    })
    .await
}

#[tauri::command]
pub(crate) async fn path_exists(path: String) -> Result<bool, String> {
    run_blocking("Unable to inspect path", BlockingClass::File, move || {
        path_exists_sync(path)
    })
    .await
}

fn path_exists_sync(path: String) -> Result<bool, String> {
    let file_path = decode_wire_path(&path);
    match fs::symlink_metadata(file_path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Unable to inspect path. {error}")),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StatFilesRequest {
    paths: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StatFileEntry {
    path: String,
    exists: bool,
    modified_at: Option<u128>,
    size: Option<u64>,
    identity: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StatFilesResult {
    entries: Vec<StatFileEntry>,
}

#[tauri::command]
pub(crate) async fn stat_files(request: StatFilesRequest) -> Result<StatFilesResult, String> {
    run_blocking("Unable to inspect files", BlockingClass::File, move || {
        stat_files_sync(request.paths)
    })
    .await
}

fn stat_files_sync(paths: Vec<String>) -> Result<StatFilesResult, String> {
    let mut entries = Vec::with_capacity(paths.len());
    for path in paths {
        entries.push(stat_file_entry(path)?);
    }
    Ok(StatFilesResult { entries })
}

fn stat_file_entry(path: String) -> Result<StatFileEntry, String> {
    let file_path = decode_wire_path(&path);
    let metadata = match fs::symlink_metadata(&file_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(StatFileEntry {
                path,
                exists: false,
                modified_at: None,
                size: None,
                identity: None,
            });
        }
        Err(error) => return Err(format!("Unable to inspect path. {error}")),
    };
    // Match the symlink/reparse-point guard used by read/save — never
    // follow links or open a reparse point. The path still exists, but it
    // cannot be compared as a regular file, so every comparable field is null
    // and the frontend falls back to `read_file` for the precise error.
    if metadata.file_type().is_symlink() || is_windows_reparse_point(&metadata) {
        return Ok(StatFileEntry {
            path,
            exists: true,
            modified_at: None,
            size: None,
            identity: None,
        });
    }
    // modifiedAt uses the same millisecond representation as `read_file`.
    let modified_at = metadata.modified().ok().and_then(timestamp);
    let size = if metadata.is_file() {
        Some(metadata.len())
    } else {
        None
    };
    let identity = path_file_identity(&file_path, &metadata)
        .ok()
        .map(|identity| identity.wire());
    Ok(StatFileEntry {
        path,
        exists: true,
        modified_at,
        size,
        identity,
    })
}

fn read_file_sync(path: String) -> Result<ReadFileResult, String> {
    let file_path = decode_wire_path(&path);
    let (bytes, metadata, identity) = read_file_with_metadata(&file_path, MAX_FILE_READ_BYTES)
        .map_err(|error| format_limited_read_error("read file", error))?;
    let size = bytes.len();
    let fingerprint = content_fingerprint(&bytes);
    let (content, line_endings, bom) = decode_text_bytes(&bytes)?;
    let line_ending = preferred_line_ending(&line_endings);
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(timestamp)
        .unwrap_or_default();
    Ok(ReadFileResult {
        path: checked_wire_path(&file_path)?,
        content,
        encoding: if bom { "utf-8-bom" } else { "utf-8" }.to_string(),
        line_ending: line_ending.to_string(),
        line_endings,
        bom,
        modified_at,
        size,
        fingerprint,
        identity: Some(identity.wire()),
    })
}

fn verify_saved_bytes<F>(
    saved_bytes: &[u8],
    serialized: &[u8],
    mut fingerprint: F,
) -> Result<String, ()>
where
    F: FnMut(&[u8]) -> String,
{
    let saved_fingerprint = fingerprint(saved_bytes);
    if saved_fingerprint != fingerprint(serialized) {
        return Err(());
    }
    Ok(saved_fingerprint)
}

fn read_workspace_image_sync(path: String, workspace: String) -> Result<Vec<u8>, String> {
    let workspace_root = fs::canonicalize(decode_wire_path(&workspace))
        .map_err(|error| format!("Unable to inspect the workspace. {error}"))?;
    let requested_path = decode_wire_path(&path);
    let requested_metadata = fs::symlink_metadata(&requested_path)
        .map_err(|error| format!("Unable to inspect the image. {error}"))?;
    if requested_metadata.file_type().is_symlink() || is_windows_reparse_point(&requested_metadata)
    {
        return Err("Symlink images are not supported.".to_string());
    }
    let image_path = fs::canonicalize(&requested_path)
        .map_err(|error| format!("Unable to inspect the image. {error}"))?;
    if !image_path.starts_with(&workspace_root) {
        return Err("Images can only be previewed from the current workspace.".to_string());
    }

    let (bytes, _, _) = read_file_with_metadata(&image_path, MAX_IMAGE_PREVIEW_BYTES)
        .map_err(|error| format_limited_read_error("preview image", error))?;
    let mime_type = image_mime_type(&bytes).ok_or_else(|| {
        "Only PNG, JPEG, GIF, WebP, and BMP images can be previewed. Animated images, ICO, and AVIF are not supported.".to_string()
    })?;
    let expected_mime_type = requested_path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .and_then(|extension| match extension.as_str() {
            "png" => Some("image/png"),
            "jpg" | "jpeg" => Some("image/jpeg"),
            "gif" => Some("image/gif"),
            "webp" => Some("image/webp"),
            "bmp" => Some("image/bmp"),
            _ => None,
        })
        .ok_or_else(|| {
            "This image extension is not supported. Use PNG, JPEG, GIF, WebP, or BMP.".to_string()
        })?;
    if expected_mime_type != mime_type {
        return Err("The image contents do not match the file extension.".to_string());
    }
    validate_image_dimensions(bytes.as_slice(), mime_type)?;
    // Return the raw bytes as a binary IPC response (ArrayBuffer on the
    // frontend) instead of base64 inside a JSON payload.
    Ok(bytes)
}

fn image_mime_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else {
        None
    }
}

fn validate_image_dimensions(bytes: &[u8], mime_type: &str) -> Result<(), String> {
    let dimensions = match mime_type {
        "image/png" => png_dimensions(bytes)?,
        "image/jpeg" => jpeg_dimensions(bytes)?,
        "image/gif" => gif_dimensions(bytes)?,
        "image/webp" => webp_dimensions(bytes)?,
        "image/bmp" => bmp_dimensions(bytes)?,
        _ => return Err("This image format cannot be previewed safely.".to_string()),
    };
    validate_image_size(dimensions.0, dimensions.1)
}

fn validate_image_size(width: u32, height: u32) -> Result<(), String> {
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(image_dimensions_error)?;
    if width == 0
        || height == 0
        || width > MAX_IMAGE_PREVIEW_DIMENSION
        || height > MAX_IMAGE_PREVIEW_DIMENSION
        || pixels > MAX_IMAGE_PREVIEW_PIXELS
    {
        return Err(format!(
            "This image exceeds the preview limit of {MAX_IMAGE_PREVIEW_PIXELS} pixels or {MAX_IMAGE_PREVIEW_DIMENSION} pixels per side."
        ));
    }
    Ok(())
}

fn image_dimensions_error() -> String {
    "The image dimensions could not be read safely, so it cannot be previewed.".to_string()
}

fn png_dimensions(bytes: &[u8]) -> Result<(u32, u32), String> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(image_dimensions_error());
    }
    let mut position = 8_usize;
    let mut dimensions = None;
    let mut saw_image_data = false;
    let mut saw_end = false;
    while position < bytes.len() {
        let chunk_length = u32::from_be_bytes(
            bytes
                .get(position..position + 4)
                .ok_or_else(image_dimensions_error)?
                .try_into()
                .map_err(|_| image_dimensions_error())?,
        ) as usize;
        let chunk_type = bytes
            .get(position + 4..position + 8)
            .ok_or_else(image_dimensions_error)?;
        let chunk_start = position.checked_add(8).ok_or_else(image_dimensions_error)?;
        let chunk_end = chunk_start
            .checked_add(chunk_length)
            .and_then(|end| end.checked_add(4))
            .filter(|end| *end <= bytes.len())
            .ok_or_else(image_dimensions_error)?;
        let data = &bytes[chunk_start..chunk_start + chunk_length];
        if chunk_type == b"IHDR" {
            if dimensions.is_some() || data.len() != 13 || position != 8 {
                return Err(image_dimensions_error());
            }
            dimensions = Some((
                u32::from_be_bytes(
                    data[0..4]
                        .try_into()
                        .map_err(|_| image_dimensions_error())?,
                ),
                u32::from_be_bytes(
                    data[4..8]
                        .try_into()
                        .map_err(|_| image_dimensions_error())?,
                ),
            ));
        } else if chunk_type == b"acTL" {
            return Err("Animated images are not supported in preview.".to_string());
        } else if chunk_type == b"IDAT" {
            saw_image_data = true;
        }
        position = chunk_end;
        if chunk_type == b"IEND" {
            if chunk_length != 0 {
                return Err(image_dimensions_error());
            }
            saw_end = true;
            break;
        }
    }
    if !saw_image_data || !saw_end || position != bytes.len() {
        return Err(image_dimensions_error());
    }
    dimensions.ok_or_else(image_dimensions_error)
}

fn jpeg_dimensions(bytes: &[u8]) -> Result<(u32, u32), String> {
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return Err(image_dimensions_error());
    }
    let mut position = 2_usize;
    let mut dimensions = None;
    let mut saw_scan_header = false;
    while position < bytes.len() {
        if bytes[position] != 0xff {
            return Err(image_dimensions_error());
        }
        while bytes.get(position) == Some(&0xff) {
            position += 1;
        }
        let marker = *bytes.get(position).ok_or_else(image_dimensions_error)?;
        position += 1;
        if marker == 0xd9 {
            break;
        }
        if marker == 0xda {
            let segment_length = u16::from_be_bytes(
                bytes
                    .get(position..position + 2)
                    .ok_or_else(image_dimensions_error)?
                    .try_into()
                    .map_err(|_| image_dimensions_error())?,
            ) as usize;
            let scan_components =
                usize::from(*bytes.get(position + 2).ok_or_else(image_dimensions_error)?);
            let expected_segment_length = scan_components
                .checked_mul(2)
                .and_then(|components| components.checked_add(6))
                .ok_or_else(image_dimensions_error)?;
            let segment_end = position
                .checked_add(segment_length)
                .filter(|end| *end <= bytes.len())
                .ok_or_else(image_dimensions_error)?;
            if scan_components == 0 || segment_length != expected_segment_length {
                return Err(image_dimensions_error());
            }
            let _scan_header = bytes
                .get(position..segment_end)
                .ok_or_else(image_dimensions_error)?;
            saw_scan_header = true;
            break;
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        let segment_length = u16::from_be_bytes(
            bytes
                .get(position..position + 2)
                .ok_or_else(image_dimensions_error)?
                .try_into()
                .map_err(|_| image_dimensions_error())?,
        ) as usize;
        if segment_length < 2 {
            return Err(image_dimensions_error());
        }
        let segment_end = position
            .checked_add(segment_length)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(image_dimensions_error)?;
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
            let component_count =
                usize::from(*bytes.get(position + 7).ok_or_else(image_dimensions_error)?);
            let expected_segment_length = component_count
                .checked_mul(3)
                .and_then(|components| components.checked_add(8))
                .ok_or_else(image_dimensions_error)?;
            if component_count == 0 || segment_length != expected_segment_length {
                return Err(image_dimensions_error());
            }
            let height = u16::from_be_bytes(
                bytes[position + 3..position + 5]
                    .try_into()
                    .map_err(|_| image_dimensions_error())?,
            ) as u32;
            let width = u16::from_be_bytes(
                bytes[position + 5..position + 7]
                    .try_into()
                    .map_err(|_| image_dimensions_error())?,
            ) as u32;
            if dimensions.is_some() {
                return Err(image_dimensions_error());
            }
            dimensions = Some((width, height));
        }
        position = segment_end;
    }
    if !saw_scan_header {
        return Err(image_dimensions_error());
    }
    dimensions.ok_or_else(image_dimensions_error)
}

fn gif_dimensions(bytes: &[u8]) -> Result<(u32, u32), String> {
    if !(bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) || bytes.len() < 13 {
        return Err(image_dimensions_error());
    }
    let width = u16::from_le_bytes([bytes[6], bytes[7]]) as u32;
    let height = u16::from_le_bytes([bytes[8], bytes[9]]) as u32;
    let packed = bytes[10];
    let global_table_bytes = if packed & 0x80 != 0 {
        3_usize
            .checked_mul(1_usize << (usize::from(packed & 0x07) + 1))
            .ok_or_else(image_dimensions_error)?
    } else {
        0
    };
    let mut position = 13_usize
        .checked_add(global_table_bytes)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(image_dimensions_error)?;
    let mut image_count = 0_usize;
    let mut saw_trailer = false;
    while position < bytes.len() {
        match bytes[position] {
            0x3b => {
                saw_trailer = true;
                position += 1;
                break;
            }
            0x21 => {
                position = position
                    .checked_add(2)
                    .filter(|end| *end <= bytes.len())
                    .ok_or_else(image_dimensions_error)?;
                position = gif_subblocks_end(bytes, position)?;
            }
            0x2c => {
                let descriptor_end = position
                    .checked_add(10)
                    .filter(|end| *end <= bytes.len())
                    .ok_or_else(image_dimensions_error)?;
                let frame_width =
                    u16::from_le_bytes([bytes[position + 5], bytes[position + 6]]) as u32;
                let frame_height =
                    u16::from_le_bytes([bytes[position + 7], bytes[position + 8]]) as u32;
                if frame_width == 0
                    || frame_height == 0
                    || frame_width > width
                    || frame_height > height
                {
                    return Err(image_dimensions_error());
                }
                image_count = image_count.saturating_add(1);
                if image_count > 1 {
                    return Err("Animated images are not supported in preview.".to_string());
                }
                let descriptor_flags = bytes[position + 9];
                let local_table_bytes = if descriptor_flags & 0x80 != 0 {
                    3_usize
                        .checked_mul(1_usize << (usize::from(descriptor_flags & 0x07) + 1))
                        .ok_or_else(image_dimensions_error)?
                } else {
                    0
                };
                let data_start = descriptor_end
                    .checked_add(local_table_bytes)
                    .and_then(|start| start.checked_add(1))
                    .filter(|end| *end <= bytes.len())
                    .ok_or_else(image_dimensions_error)?;
                position = gif_subblocks_end(bytes, data_start)?;
            }
            _ => return Err(image_dimensions_error()),
        }
    }
    if !saw_trailer || position != bytes.len() || image_count != 1 {
        return Err(image_dimensions_error());
    }
    Ok((width, height))
}

fn gif_subblocks_end(bytes: &[u8], mut position: usize) -> Result<usize, String> {
    loop {
        let length = usize::from(*bytes.get(position).ok_or_else(image_dimensions_error)?);
        position += 1;
        if length == 0 {
            return Ok(position);
        }
        position = position
            .checked_add(length)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(image_dimensions_error)?;
    }
}

fn webp_dimensions(bytes: &[u8]) -> Result<(u32, u32), String> {
    if bytes.len() < 12 || !bytes.starts_with(b"RIFF") || bytes.get(8..12) != Some(b"WEBP") {
        return Err(image_dimensions_error());
    }
    let riff_length = u32::from_le_bytes(
        bytes[4..8]
            .try_into()
            .map_err(|_| image_dimensions_error())?,
    ) as usize;
    let container_end = riff_length
        .checked_add(8)
        .filter(|end| *end == bytes.len() && *end >= 12)
        .ok_or_else(image_dimensions_error)?;
    let mut position = 12_usize;
    let mut canvas = None;
    let mut image_dimensions = None;
    while position < container_end {
        let chunk_header_end = position.checked_add(8).ok_or_else(image_dimensions_error)?;
        let chunk_header = bytes
            .get(position..chunk_header_end)
            .ok_or_else(image_dimensions_error)?;
        let chunk_type = &chunk_header[..4];
        let chunk_length = u32::from_le_bytes(
            chunk_header[4..8]
                .try_into()
                .map_err(|_| image_dimensions_error())?,
        ) as usize;
        let data_start = position.checked_add(8).ok_or_else(image_dimensions_error)?;
        let data_end = data_start
            .checked_add(chunk_length)
            .filter(|end| *end <= container_end)
            .ok_or_else(image_dimensions_error)?;
        let data = &bytes[data_start..data_end];
        if chunk_type == b"ANIM" || chunk_type == b"ANMF" {
            return Err("Animated images are not supported in preview.".to_string());
        } else if chunk_type == b"VP8X" {
            if canvas.is_some() || image_dimensions.is_some() || data.len() != 10 {
                return Err(image_dimensions_error());
            }
            if data[0] & 0x02 != 0 {
                return Err("Animated images are not supported in preview.".to_string());
            }
            canvas = Some((
                read_u24_le(&data[4..7])?.saturating_add(1),
                read_u24_le(&data[7..10])?.saturating_add(1),
            ));
        } else if chunk_type == b"VP8 " {
            if image_dimensions.is_some()
                || data.len() < 10
                || data.get(3..6) != Some(&[0x9d, 0x01, 0x2a][..])
            {
                return Err(image_dimensions_error());
            }
            let width = u16::from_le_bytes([data[6], data[7]]) & 0x3fff;
            let height = u16::from_le_bytes([data[8], data[9]]) & 0x3fff;
            image_dimensions = Some((u32::from(width), u32::from(height)));
        } else if chunk_type == b"VP8L" {
            if image_dimensions.is_some() || data.len() < 5 || data[0] != 0x2f {
                return Err(image_dimensions_error());
            }
            let width = 1 + u32::from(data[1]) + (u32::from(data[2] & 0x3f) << 8);
            let height = 1
                + u32::from(data[2] >> 6)
                + (u32::from(data[3]) << 2)
                + (u32::from(data[4] & 0x0f) << 10);
            image_dimensions = Some((width, height));
        }
        position = data_end
            .checked_add(chunk_length & 1)
            .filter(|end| *end <= container_end)
            .ok_or_else(image_dimensions_error)?;
    }
    let dimensions = image_dimensions.ok_or_else(image_dimensions_error)?;
    if let Some(canvas) = canvas {
        validate_image_size(canvas.0, canvas.1)?;
        if canvas != dimensions {
            return Err(image_dimensions_error());
        }
    }
    Ok(dimensions)
}

fn read_u24_le(bytes: &[u8]) -> Result<u32, String> {
    let values: [u8; 3] = bytes.try_into().map_err(|_| image_dimensions_error())?;
    Ok(u32::from(values[0]) | (u32::from(values[1]) << 8) | (u32::from(values[2]) << 16))
}

fn bmp_dimensions(bytes: &[u8]) -> Result<(u32, u32), String> {
    if bytes.len() < 26 || !bytes.starts_with(b"BM") {
        return Err(image_dimensions_error());
    }
    let dib_size = u32::from_le_bytes(
        bytes[14..18]
            .try_into()
            .map_err(|_| image_dimensions_error())?,
    );
    if dib_size == 12 {
        let width = u16::from_le_bytes([bytes[18], bytes[19]]) as u32;
        let height = u16::from_le_bytes([bytes[20], bytes[21]]) as u32;
        return Ok((width, height));
    }
    if dib_size < 40 || bytes.len() < 26 || bytes.len() < 14_usize.saturating_add(dib_size as usize)
    {
        return Err(image_dimensions_error());
    }
    let width = i32::from_le_bytes(
        bytes[18..22]
            .try_into()
            .map_err(|_| image_dimensions_error())?,
    );
    let height = i32::from_le_bytes(
        bytes[22..26]
            .try_into()
            .map_err(|_| image_dimensions_error())?,
    );
    let height = height.checked_abs().ok_or_else(image_dimensions_error)?;
    Ok((
        u32::try_from(width).map_err(|_| image_dimensions_error())?,
        u32::try_from(height).map_err(|_| image_dimensions_error())?,
    ))
}

#[cfg(test)]
fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or_default();
        let third = chunk.get(2).copied().unwrap_or_default();
        encoded.push(ALPHABET[(first >> 2) as usize] as char);
        encoded.push(ALPHABET[(((first & 0b11) << 4) | (second >> 4)) as usize] as char);
        encoded.push(if chunk.len() > 1 {
            ALPHABET[(((second & 0b1111) << 2) | (third >> 6)) as usize] as char
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            ALPHABET[(third & 0b0011_1111) as usize] as char
        } else {
            '='
        });
    }
    encoded
}

#[tauri::command]
pub(crate) async fn save_file<R: tauri::Runtime>(
    path: String,
    content: String,
    line_ending: String,
    line_endings: Option<String>,
    bom: Option<bool>,
    expected_modified_at: Option<u128>,
    expected_size: Option<usize>,
    expected_fingerprint: Option<String>,
    window: WebviewWindow<R>,
    quit_gate: State<'_, QuitGateState>,
    state: State<'_, AppState>,
) -> Result<SaveFileResult, String> {
    let admission = quit_gate.admit_resource_operation(window.label())?;
    let save_locks = Arc::clone(&state.save_locks);
    run_blocking("Unable to save file", BlockingClass::File, move || {
        let _admission = admission;
        save_file_sync(
            path,
            content,
            line_ending,
            line_endings,
            bom.unwrap_or(false),
            expected_modified_at,
            expected_size,
            expected_fingerprint,
            save_locks,
        )
    })
    .await
}

pub(super) fn save_file_sync(
    path: String,
    content: String,
    line_ending: String,
    line_endings: Option<String>,
    bom: bool,
    expected_modified_at: Option<u128>,
    expected_size: Option<usize>,
    expected_fingerprint: Option<String>,
    save_locks: Arc<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>>,
) -> Result<SaveFileResult, String> {
    let serialized = serialize_save_content(&content, line_endings.as_deref(), &line_ending, bom)?;
    let file_path = decode_wire_path(&path);
    checked_wire_path(&file_path)?;
    let snapshot = save_file_metadata(&file_path)?;
    if expected_fingerprint.is_none() {
        return Err(
            "Unable to save file. The current disk version is unknown; reload the file before saving so external changes are protected."
                .to_string(),
        );
    }
    if expected_modified_at.is_some_and(|expected| expected != snapshot.modified_at)
        || expected_size.is_some_and(|expected| expected != snapshot.size)
        || expected_fingerprint
            .as_deref()
            .is_some_and(|expected| expected != snapshot.fingerprint)
    {
        return Err(
            "Unable to save file. The file changed on disk; reload or compare before saving."
                .to_string(),
        );
    }
    let lock_key = save_lock_key(&file_path);
    let lock = path_lock(&save_locks, &lock_key)?;
    let _guard = lock
        .lock()
        .map_err(|_| "Unable to save file. The save lock is unavailable.".to_string())?;
    let locked_snapshot = save_file_metadata(&file_path)?;
    if locked_snapshot != snapshot
        || expected_modified_at.is_some_and(|expected| expected != locked_snapshot.modified_at)
        || expected_size.is_some_and(|expected| expected != locked_snapshot.size)
        || expected_fingerprint
            .as_deref()
            .is_some_and(|expected| expected != locked_snapshot.fingerprint)
    {
        return Err(
            "Unable to save file. The file changed on disk; reload or compare before saving."
                .to_string(),
        );
    }
    save_file_atomically(&file_path, &serialized, Some(&locked_snapshot))
        .map_err(|error| format_atomic_save_error(error))?;
    let (saved_bytes, saved_metadata, saved_identity) =
        read_file_with_metadata(&file_path, MAX_FILE_READ_BYTES)
            .map_err(|error| format_limited_read_error("read saved file", error))?;
    let saved_fingerprint = verify_saved_bytes(&saved_bytes, &serialized, content_fingerprint)
        .map_err(|()| {
            "Unable to finish saving file. It changed again immediately after replacement; reload or compare before saving."
                .to_string()
        })?;
    Ok(SaveFileResult {
        modified_at: saved_metadata
            .modified()
            .ok()
            .and_then(timestamp)
            .unwrap_or_default(),
        size: saved_bytes.len(),
        fingerprint: saved_fingerprint,
        identity: saved_identity.wire(),
    })
}

#[tauri::command]
pub(crate) async fn inspect_save_as_destination(
    path: String,
) -> Result<SaveAsDestinationInspection, String> {
    run_blocking(
        "Unable to inspect save destination",
        BlockingClass::File,
        move || inspect_save_as_destination_sync(path),
    )
    .await
}

fn inspect_save_as_destination_sync(path: String) -> Result<SaveAsDestinationInspection, String> {
    let file_path = decode_wire_path(&path);
    checked_wire_path(&file_path)?;
    ensure_save_parent_exists(&file_path)?;
    let snapshot = save_as_destination_snapshot(&file_path)?;
    Ok(SaveAsDestinationInspection {
        exists: snapshot.is_some(),
        token: save_as_destination_token(&file_path, snapshot.as_ref()),
    })
}

#[tauri::command]
pub(crate) async fn save_file_as(
    path: String,
    destination_state: String,
    content: String,
    line_ending: String,
    line_endings: Option<String>,
    bom: Option<bool>,
    window: WebviewWindow,
    quit_gate: State<'_, QuitGateState>,
    state: State<'_, AppState>,
) -> Result<SaveFileResult, String> {
    let admission = quit_gate.admit_resource_operation(window.label())?;
    let save_locks = Arc::clone(&state.save_locks);
    run_blocking("Unable to save file", BlockingClass::File, move || {
        let _admission = admission;
        save_file_as_sync(
            path,
            destination_state,
            content,
            line_ending,
            line_endings,
            bom.unwrap_or(false),
            save_locks,
        )
    })
    .await
}

pub(super) fn save_file_as_sync(
    path: String,
    destination_state: String,
    content: String,
    line_ending: String,
    line_endings: Option<String>,
    bom: bool,
    save_locks: Arc<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>>,
) -> Result<SaveFileResult, String> {
    let serialized = serialize_save_content(&content, line_endings.as_deref(), &line_ending, bom)?;
    let file_path = decode_wire_path(&path);
    checked_wire_path(&file_path)?;
    ensure_save_parent_exists(&file_path)?;
    let lock_key = save_lock_key(&file_path);
    let lock = path_lock(&save_locks, &lock_key)?;
    let _guard = lock
        .lock()
        .map_err(|_| "Unable to save file. The save lock is unavailable.".to_string())?;
    let current_snapshot = save_as_destination_snapshot(&file_path)?;
    if save_as_destination_token(&file_path, current_snapshot.as_ref()) != destination_state {
        return Err(
            "Unable to save file. The destination changed while Save As was awaiting confirmation; review it again before replacing it."
                .to_string(),
        );
    }
    save_file_atomically(&file_path, &serialized, current_snapshot.as_ref())
        .map_err(|error| format_atomic_save_error(error))?;
    let (saved_bytes, saved_metadata, saved_identity) =
        read_file_with_metadata(&file_path, MAX_FILE_READ_BYTES)
            .map_err(|error| format_limited_read_error("read saved file", error))?;
    let saved_fingerprint = verify_saved_bytes(&saved_bytes, &serialized, content_fingerprint)
        .map_err(|()| {
            "Unable to finish Save As. The destination changed immediately after replacement; reload or compare before saving."
                .to_string()
        })?;
    Ok(SaveFileResult {
        modified_at: saved_metadata
            .modified()
            .ok()
            .and_then(timestamp)
            .unwrap_or_default(),
        size: saved_bytes.len(),
        fingerprint: saved_fingerprint,
        identity: saved_identity.wire(),
    })
}

fn ensure_save_parent_exists(file_path: &Path) -> Result<(), String> {
    let parent = file_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if !parent.is_dir() {
        return Err("Unable to save file. The destination folder does not exist.".to_string());
    }
    Ok(())
}

fn save_as_destination_snapshot(path: &Path) -> Result<Option<FileSnapshot>, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => save_file_metadata(path).map(Some),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Unable to inspect save destination. {error}")),
    }
}

fn save_as_destination_token(path: &Path, snapshot: Option<&FileSnapshot>) -> String {
    let normalized_path = wire_path(&save_lock_key(path));
    let mut token = format!("save-as-v1:{}:{}", normalized_path.len(), normalized_path);
    match snapshot {
        None => token.push_str(":missing"),
        Some(snapshot) => {
            #[cfg(unix)]
            let platform_state = format!("unix:{}", snapshot.mode);
            #[cfg(windows)]
            let platform_state = format!("windows:{}", snapshot.attributes);
            token.push_str(&format!(
                ":file:{}:{}:{}:{}:{}:{}",
                snapshot.modified_at,
                snapshot.size,
                snapshot.fingerprint,
                snapshot.identity.volume,
                snapshot.identity.file,
                platform_state,
            ));
        }
    }
    token
}

pub(crate) fn save_file_metadata(path: &Path) -> Result<FileSnapshot, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("Unable to save file. {error}"))?;
    if metadata.file_type().is_symlink() || is_windows_reparse_point(&metadata) {
        return Err(
            "Unable to save file. Symlink targets are not replaced automatically.".to_string(),
        );
    }
    if !metadata.is_file() {
        return Err("Unable to save file. The selected path is not a regular file.".to_string());
    }
    let initial_identity = path_file_identity(path, &metadata)
        .map_err(|error| format!("Unable to save file. {error}"))?;
    let (bytes, opened_metadata, opened_identity) =
        read_file_with_metadata(path, MAX_FILE_READ_BYTES)
            .map_err(|error| format_limited_read_error("fingerprint file before saving", error))?;
    if initial_identity != opened_identity {
        return Err(
            "Unable to save file. The file was replaced while its contents were being checked; reload it before saving."
                .to_string(),
        );
    }
    decode_text_bytes(&bytes).map_err(|_| {
        "Unable to save file. Only UTF-8 and UTF-8 with BOM text files are supported.".to_string()
    })?;
    Ok(FileSnapshot {
        modified_at: opened_metadata
            .modified()
            .ok()
            .and_then(timestamp)
            .unwrap_or_default(),
        size: bytes.len(),
        fingerprint: content_fingerprint(&bytes),
        identity: opened_identity,
        #[cfg(unix)]
        mode: opened_metadata.mode(),
        #[cfg(windows)]
        attributes: opened_metadata.file_attributes(),
    })
}

#[tauri::command]
pub(crate) async fn create_file(path: String) -> Result<(), String> {
    run_blocking("Unable to create file", BlockingClass::File, move || {
        create_file_sync(path)
    })
    .await
}

fn create_file_sync(path: String) -> Result<(), String> {
    let path = decode_wire_path(&path);
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(|_| ())
        .map_err(|error| format!("Unable to create file. {error}"))
}

#[tauri::command]
pub(crate) async fn create_directory(path: String) -> Result<(), String> {
    run_blocking("Unable to create folder", BlockingClass::File, move || {
        create_directory_sync(path)
    })
    .await
}

fn create_directory_sync(path: String) -> Result<(), String> {
    fs::create_dir(decode_wire_path(&path))
        .map_err(|error| format!("Unable to create folder. {error}"))
}

#[tauri::command]
pub(crate) async fn rename_path(from: String, to: String) -> Result<(), String> {
    run_blocking("Unable to rename item", BlockingClass::File, move || {
        rename_path_sync(from, to)
    })
    .await
}

fn rename_path_sync(from: String, to: String) -> Result<(), String> {
    let from = decode_wire_path(&from);
    let to = decode_wire_path(&to);
    match fs::symlink_metadata(&to) {
        Ok(_) => {
            return Err("Unable to rename item. The destination already exists.".to_string());
        }
        Err(error) if error.kind() != io::ErrorKind::NotFound => {
            return Err(format!("Unable to rename item. {error}"));
        }
        Err(_) => {}
    }
    rename_without_replacement(&from, &to).map_err(|error| {
        if error.kind() == io::ErrorKind::AlreadyExists {
            "Unable to rename item. The destination already exists.".to_string()
        } else {
            format!("Unable to rename item. {error}")
        }
    })
}

#[cfg(target_os = "macos")]
fn rename_without_replacement(from: &Path, to: &Path) -> io::Result<()> {
    use std::ffi::CString;

    #[link(name = "System")]
    unsafe extern "C" {
        fn renameatx_np(
            from_directory: i32,
            from_path: *const std::ffi::c_char,
            to_directory: i32,
            to_path: *const std::ffi::c_char,
            flags: u32,
        ) -> i32;
    }

    let from = CString::new(from.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL byte"))?;
    let to = CString::new(to.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL byte"))?;
    const AT_FDCWD: i32 = -2;
    const RENAME_EXCL: u32 = 0x0000_0004;
    let result =
        unsafe { renameatx_np(AT_FDCWD, from.as_ptr(), AT_FDCWD, to.as_ptr(), RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn rename_without_replacement(from: &Path, to: &Path) -> io::Result<()> {
    use std::ffi::CString;

    #[link(name = "c")]
    unsafe extern "C" {
        fn renameat2(
            from_directory: i32,
            from_path: *const std::ffi::c_char,
            to_directory: i32,
            to_path: *const std::ffi::c_char,
            flags: u32,
        ) -> i32;
    }

    let from = CString::new(from.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL byte"))?;
    let to = CString::new(to.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL byte"))?;
    const AT_FDCWD: i32 = -100;
    const RENAME_NOREPLACE: u32 = 0x0000_0001;
    let result = unsafe {
        renameat2(
            AT_FDCWD,
            from.as_ptr(),
            AT_FDCWD,
            to.as_ptr(),
            RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn rename_without_replacement(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }

    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    let moved = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn rename_without_replacement(_from: &Path, _to: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "exclusive rename is unavailable on this platform",
    ))
}

#[tauri::command]
pub(crate) async fn delete_path(path: String) -> Result<(), String> {
    run_blocking(
        "Unable to move item to the system trash",
        BlockingClass::File,
        move || delete_path_sync(path),
    )
    .await
}

fn delete_path_sync(path: String) -> Result<(), String> {
    let target = decode_wire_path(&path);
    delete_path_with(&target, platform_trash::move_path_to_trash)
}

fn delete_path_with(
    target: &Path,
    move_to_trash: impl FnOnce(&Path) -> io::Result<()>,
) -> Result<(), String> {
    fs::symlink_metadata(target).map_err(|error| {
        format!("Unable to find item before moving it to the system trash. {error}")
    })?;
    move_to_trash(target)
        .map_err(|error| format!("Unable to move item to the system trash. {error}"))
}

#[cfg(test)]
mod file_operation_tests {
    use super::*;
    #[cfg(target_os = "macos")]
    use std::sync::atomic::{AtomicBool, Ordering};
    #[cfg(target_os = "macos")]
    use std::thread;
    #[cfg(target_os = "macos")]
    use std::time::Duration;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("pude-file-ops-{}", Uuid::new_v4()));
            fs::create_dir(&path).expect("temporary test directory should be created");
            Self(path)
        }

        #[cfg(target_os = "macos")]
        fn private_tmp() -> Self {
            let path =
                PathBuf::from("/private/tmp").join(format!("pude-file-ops-{}", Uuid::new_v4()));
            fs::create_dir(&path)
                .expect("temporary test directory should be created in /private/tmp");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn destination_state(path: &Path) -> String {
        inspect_save_as_destination_sync(wire_path(path))
            .expect("Save As destination should be inspectable")
            .token
    }

    #[test]
    fn workspace_image_preview_reads_a_real_webp_from_its_workspace() {
        let workspace = TempDir::new();
        let image_path = workspace.path().join("preview.webp");
        let bundled_image = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("public")
            .join("pude-logo.webp");
        fs::copy(bundled_image, &image_path).expect("test image should be copied");

        let bytes = read_workspace_image_sync(wire_path(&image_path), wire_path(workspace.path()))
            .expect("a WebP image inside the workspace should be previewable");

        assert_eq!(
            image_mime_type(&bytes),
            Some("image/webp"),
            "raw bytes should carry the WebP signature"
        );
        assert_eq!(
            fs::read(&image_path).expect("source image should be readable"),
            bytes,
            "the binary response should be the exact file bytes"
        );
    }

    #[test]
    fn workspace_image_preview_rejects_text_and_paths_outside_the_workspace() {
        let workspace = TempDir::new();
        let text_path = workspace.path().join("not-an-image.png");
        fs::write(&text_path, b"plain text").expect("test file should be created");
        let error = read_workspace_image_sync(wire_path(&text_path), wire_path(workspace.path()))
            .expect_err("a text file with an image extension should be rejected");
        assert!(error.contains("Only PNG"));

        let mismatch_path = workspace.path().join("mismatch.png");
        fs::write(&mismatch_path, b"GIF89a").expect("test image should be created");
        let error =
            read_workspace_image_sync(wire_path(&mismatch_path), wire_path(workspace.path()))
                .expect_err("image bytes that do not match the extension should be rejected");
        assert!(error.contains("do not match the file extension"));

        let outside = TempDir::new();
        let image_path = outside.path().join("outside.png");
        fs::write(&image_path, b"\x89PNG\r\n\x1a\n").expect("test image should be created");
        let error = read_workspace_image_sync(wire_path(&image_path), wire_path(workspace.path()))
            .expect_err("a path outside the selected workspace should be rejected");
        assert!(error.contains("current workspace"));
    }

    #[test]
    fn base64_encoding_handles_padding() {
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
    }

    #[test]
    fn stat_files_reports_metadata_identity_and_missing_paths() {
        let directory = TempDir::new();
        let file_path = directory.path().join("stat-target.txt");
        fs::write(&file_path, b"hello").expect("file should be created");
        let missing_path = directory.path().join("missing.txt");

        let result = stat_files_sync(vec![wire_path(&file_path), wire_path(&missing_path)])
            .expect("stat should succeed");

        assert_eq!(result.entries.len(), 2);
        let entry = &result.entries[0];
        assert_eq!(entry.path, wire_path(&file_path));
        assert!(entry.exists);
        assert_eq!(entry.size, Some(5));
        assert!(entry.modified_at.is_some());
        let identity = entry
            .identity
            .as_deref()
            .expect("identity should be present");
        assert!(identity.contains(':'));

        let missing = &result.entries[1];
        assert_eq!(missing.path, wire_path(&missing_path));
        assert!(!missing.exists);
        assert_eq!(missing.size, None);
        assert_eq!(missing.modified_at, None);
        assert_eq!(missing.identity, None);
    }

    #[test]
    fn stat_files_modified_at_matches_read_file_milliseconds() {
        let directory = TempDir::new();
        let file_path = directory.path().join("mtime.txt");
        fs::write(&file_path, b"content").expect("file should be created");

        let file = read_file_sync(wire_path(&file_path)).expect("file should be readable");
        let result = stat_files_sync(vec![wire_path(&file_path)]).expect("stat should succeed");

        assert_eq!(
            result.entries[0].modified_at,
            Some(file.modified_at),
            "stat_files must use the same millisecond representation as read_file"
        );
        assert_eq!(result.entries[0].size, Some(file.size as u64));
    }

    #[cfg(unix)]
    #[test]
    fn stat_files_marks_symlinks_without_following_them() {
        let directory = TempDir::new();
        let target = directory.path().join("target.txt");
        fs::write(&target, b"target").expect("file should be created");
        let link = directory.path().join("link.txt");
        std::os::unix::fs::symlink(&target, &link).expect("symlink should be created");

        let result = stat_files_sync(vec![wire_path(&link)]).expect("stat should succeed");

        let entry = &result.entries[0];
        assert!(entry.exists);
        assert_eq!(entry.size, None);
        assert_eq!(entry.modified_at, None);
        assert_eq!(entry.identity, None);
    }

    #[test]
    fn rename_moves_source_when_destination_is_absent() {
        let directory = TempDir::new();
        let source = directory.path().join("source.txt");
        let destination = directory.path().join("destination.txt");
        fs::write(&source, b"source contents").expect("source should be created");

        rename_path_sync(wire_path(&source), wire_path(&destination))
            .expect("an absent destination should allow a rename");

        assert!(!source.exists());
        assert_eq!(
            fs::read(&destination).expect("destination should contain the source"),
            b"source contents"
        );
    }

    #[test]
    fn rename_rejects_existing_destination_without_replacing_it() {
        let directory = TempDir::new();
        let source = directory.path().join("source.txt");
        let destination = directory.path().join("destination.txt");
        fs::write(&source, b"source contents").expect("source should be created");
        fs::write(&destination, b"destination contents").expect("destination should be created");

        let error = rename_path_sync(wire_path(&source), wire_path(&destination))
            .expect_err("an existing destination must not be replaced");

        assert!(error.contains("destination already exists"));
        assert_eq!(
            fs::read(&source).expect("source should be preserved"),
            b"source contents"
        );
        assert_eq!(
            fs::read(&destination).expect("destination should be preserved"),
            b"destination contents"
        );
    }

    #[test]
    fn rename_rejects_existing_directory_destination() {
        let directory = TempDir::new();
        let source = directory.path().join("source.txt");
        let destination = directory.path().join("destination");
        fs::write(&source, b"source contents").expect("source should be created");
        fs::create_dir(&destination).expect("destination directory should be created");

        let error = rename_path_sync(wire_path(&source), wire_path(&destination))
            .expect_err("an existing directory must not be replaced");

        assert!(error.contains("destination already exists"));
        assert!(source.is_file());
        assert!(destination.is_dir());
    }

    #[test]
    fn atomic_save_as_never_replaces_a_destination_created_after_inspection() {
        let directory = TempDir::new();
        let temporary = directory.path().join(".pude-tmp-test.tmp");
        let destination = directory.path().join("created-during-save.txt");
        fs::write(&temporary, b"editor contents").expect("temporary should exist");
        fs::write(&destination, b"external contents").expect("destination should appear");

        let error = atomic_replace(&temporary, &destination, false)
            .expect_err("atomic Save As must not overwrite a newly created file");

        assert!(
            error.kind() == io::ErrorKind::AlreadyExists || error.kind() == io::ErrorKind::Other
        );
        assert_eq!(
            fs::read(&destination).expect("external file should be preserved"),
            b"external contents"
        );
        assert_eq!(
            fs::read(&temporary).expect("failed replacement should retain the temporary file"),
            b"editor contents"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn save_as_writes_exact_mixed_newline_bytes_for_new_and_existing_destinations() {
        let directory = TempDir::private_tmp();
        let destination = directory.path().join("save-as.txt");
        let save_locks = Arc::new(Mutex::new(HashMap::new()));
        let new_destination_state = destination_state(&destination);

        let created = save_file_as_sync(
            wire_path(&destination),
            new_destination_state,
            "first\nsecond\n".to_string(),
            "lf".to_string(),
            Some("cl".to_string()),
            true,
            Arc::clone(&save_locks),
        )
        .expect("Save As should create the new destination");
        let expected_created_bytes = b"\xef\xbb\xbffirst\r\nsecond\n";
        assert_eq!(
            fs::read(&destination).expect("new destination should be readable"),
            expected_created_bytes
        );
        assert_eq!(created.size, expected_created_bytes.len());
        assert_eq!(
            created.fingerprint,
            content_fingerprint(expected_created_bytes)
        );

        let existing_destination_state = destination_state(&destination);
        let overwritten = save_file_as_sync(
            wire_path(&destination),
            existing_destination_state,
            "replacement\nline".to_string(),
            "crlf".to_string(),
            Some("l".to_string()),
            false,
            save_locks,
        )
        .expect("Save As should atomically overwrite the selected existing file");
        let expected_overwritten_bytes = b"replacement\nline";
        assert_eq!(
            fs::read(&destination).expect("overwritten destination should be readable"),
            expected_overwritten_bytes
        );
        assert_eq!(overwritten.size, expected_overwritten_bytes.len());
        assert_eq!(
            overwritten.fingerprint,
            content_fingerprint(expected_overwritten_bytes)
        );
    }

    #[test]
    fn save_as_rejects_a_destination_created_after_confirmation_snapshot() {
        let directory = TempDir::new();
        let path = directory.path().join("appeared-after-confirmation.txt");
        let inspection = inspect_save_as_destination_sync(wire_path(&path))
            .expect("missing destination should be inspectable");
        assert!(!inspection.exists);

        fs::write(&path, b"external file that appeared during confirmation")
            .expect("external destination should be created");
        let error = save_file_as_sync(
            wire_path(&path),
            inspection.token,
            "editor contents\n".to_string(),
            "lf".to_string(),
            Some(String::new()),
            false,
            Arc::new(Mutex::new(HashMap::new())),
        )
        .expect_err("the pre-confirmation missing state must not authorize overwriting a new file");

        assert!(error.contains("destination changed while Save As was awaiting confirmation"));
        assert_eq!(
            fs::read(&path).expect("external destination should remain readable"),
            b"external file that appeared during confirmation"
        );
    }

    #[test]
    fn save_as_rejects_existing_destination_bytes_changed_after_confirmation_snapshot() {
        let directory = TempDir::new();
        let path = directory.path().join("edited-after-confirmation.txt");
        fs::write(&path, b"before confirmation").expect("destination should be created");
        let state = destination_state(&path);
        fs::write(&path, b"external edit after confirmation")
            .expect("external destination edit should be written");

        let error = save_file_as_sync(
            wire_path(&path),
            state,
            "editor contents\n".to_string(),
            "lf".to_string(),
            Some(String::new()),
            false,
            Arc::new(Mutex::new(HashMap::new())),
        )
        .expect_err("the old destination bytes must not authorize an overwrite");

        assert!(error.contains("destination changed while Save As was awaiting confirmation"));
        assert_eq!(
            fs::read(&path).expect("externally edited destination should remain readable"),
            b"external edit after confirmation"
        );
    }

    #[test]
    fn save_as_rejects_identical_bytes_at_a_replacement_file_identity() {
        let directory = TempDir::new();
        let path = directory.path().join("replaced-after-confirmation.txt");
        let original = directory.path().join("original-held-open.txt");
        fs::write(&path, b"same visible bytes").expect("destination should be created");
        let original_metadata = fs::metadata(&path).expect("original metadata should be available");
        let original_modified = original_metadata
            .modified()
            .expect("original modification time should be available");
        #[cfg(unix)]
        let original_mode = original_metadata.mode();
        let original_snapshot =
            save_file_metadata(&path).expect("original destination snapshot should be available");
        let state = destination_state(&path);
        fs::rename(&path, &original).expect("original file identity should remain alive");
        fs::write(&path, b"same visible bytes").expect("replacement should use identical bytes");
        fs::set_permissions(&path, original_metadata.permissions())
            .expect("replacement should preserve original permissions");
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("replacement should be open for timestamp restoration")
            .set_times(fs::FileTimes::new().set_modified(original_modified))
            .expect("replacement should preserve original modification time");
        let replacement_metadata =
            fs::metadata(&path).expect("replacement metadata should be available");
        let replacement_snapshot = save_file_metadata(&path)
            .expect("replacement destination snapshot should be available");
        assert_ne!(
            replacement_snapshot.identity, original_snapshot.identity,
            "holding the original inode should give the replacement a distinct identity"
        );
        assert_eq!(replacement_snapshot.size, original_snapshot.size);
        assert_eq!(
            replacement_snapshot.fingerprint,
            original_snapshot.fingerprint
        );
        assert_eq!(
            replacement_snapshot.modified_at,
            original_snapshot.modified_at
        );
        assert_eq!(
            replacement_metadata
                .modified()
                .expect("replacement modification time should be available"),
            original_modified,
            "the identity test must hold modification time constant"
        );
        #[cfg(unix)]
        assert_eq!(
            replacement_metadata.mode(),
            original_mode,
            "the identity test must hold file mode constant"
        );

        let error = save_file_as_sync(
            wire_path(&path),
            state,
            "editor contents\n".to_string(),
            "lf".to_string(),
            Some(String::new()),
            false,
            Arc::new(Mutex::new(HashMap::new())),
        )
        .expect_err("a replacement file identity must invalidate overwrite confirmation");

        assert!(error.contains("destination changed while Save As was awaiting confirmation"));
        assert_eq!(
            fs::read(&path).expect("replacement destination should remain readable"),
            b"same visible bytes"
        );
        assert_eq!(
            fs::read(&original).expect("original destination object should remain preserved"),
            b"same visible bytes"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn atomic_replacements_never_expose_partial_file_contents_to_readers() {
        let directory = TempDir::new();
        let path = directory.path().join("atomic-reader.txt");
        let contents_a = Arc::new(vec![b'a'; 512 * 1024]);
        let contents_b = Arc::new(vec![b'b'; 512 * 1024]);
        fs::write(&path, contents_a.as_slice()).expect("initial file should be created");

        let reader_path = path.clone();
        let reader_contents_a = Arc::clone(&contents_a);
        let reader_contents_b = Arc::clone(&contents_b);
        let late_phase = Arc::new(AtomicBool::new(false));
        let reader_late_phase = Arc::clone(&late_phase);
        let (ready_sender, ready_receiver) = std::sync::mpsc::sync_channel(0);
        let (early_b_sender, early_b_receiver) = std::sync::mpsc::sync_channel(0);
        let (late_b_sender, late_b_receiver) = std::sync::mpsc::sync_channel(0);
        let (finish_sender, finish_receiver) = std::sync::mpsc::channel();
        let reader = thread::spawn(move || {
            let mut samples = 0;
            let mut saw_early_b = false;
            let mut saw_late_b = false;
            loop {
                let observed = fs::read(&reader_path)
                    .expect("the destination should remain present during replacement");
                assert!(
                    observed.as_slice() == reader_contents_a.as_slice()
                        || observed.as_slice() == reader_contents_b.as_slice(),
                    "a reader must see one complete version, never truncated or mixed bytes"
                );
                samples += 1;
                if samples == 1 {
                    ready_sender
                        .send(())
                        .expect("writer should wait for the first reader sample");
                }
                if observed.as_slice() == reader_contents_b.as_slice() {
                    if !saw_early_b {
                        early_b_sender
                            .send(())
                            .expect("writer should wait for the first B replacement");
                        saw_early_b = true;
                    }
                    if reader_late_phase.load(Ordering::Acquire) && !saw_late_b {
                        late_b_sender
                            .send(())
                            .expect("writer should wait for a later B replacement");
                        saw_late_b = true;
                    }
                }
                match finish_receiver.try_recv() {
                    Ok(()) | Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
                    Err(std::sync::mpsc::TryRecvError::Empty) => {
                        thread::sleep(Duration::from_millis(1));
                    }
                }
            }
            samples
        });

        ready_receiver
            .recv()
            .expect("reader should observe the initial complete file");
        let mut expected = Some(save_file_metadata(&path).expect("snapshot should be readable"));
        for index in 0..24 {
            let next = if index % 2 == 0 {
                contents_b.as_slice()
            } else {
                contents_a.as_slice()
            };
            save_file_atomically(&path, next, expected.as_ref())
                .expect("atomic replacement should complete");
            expected = Some(save_file_metadata(&path).expect("new snapshot should be readable"));
            if index == 0 {
                early_b_receiver
                    .recv()
                    .expect("reader should observe the first B version during replacement");
            } else if index == 22 {
                late_phase.store(true, Ordering::Release);
                late_b_receiver
                    .recv()
                    .expect("reader should observe a later B version during replacement");
            }
        }
        drop(finish_sender);

        let samples = reader.join().expect("reader should finish without a panic");
        assert!(
            samples >= 3,
            "the reader should sample the initial file and both synchronized replacement phases"
        );
        assert_eq!(
            fs::read(&path).expect("final file should be readable"),
            *contents_a
        );
    }

    #[test]
    fn delete_moves_files_and_directories_through_the_trash_operation() {
        let directory = TempDir::new();
        let trash = directory.path().join("test-trash");
        fs::create_dir(&trash).expect("test trash directory should be created");

        let file = directory.path().join("source.txt");
        let trashed_file = trash.join("source.txt");
        fs::write(&file, b"file contents").expect("source file should be created");
        delete_path_with(&file, |source| fs::rename(source, &trashed_file))
            .expect("a successful trash operation should complete");
        assert!(!file.exists());
        assert_eq!(
            fs::read(&trashed_file).expect("trashed file should retain its contents"),
            b"file contents"
        );

        let folder = directory.path().join("source-folder");
        let trashed_folder = trash.join("source-folder");
        fs::create_dir(&folder).expect("source folder should be created");
        fs::write(folder.join("nested.txt"), b"nested contents")
            .expect("nested file should be created");
        delete_path_with(&folder, |source| fs::rename(source, &trashed_folder))
            .expect("a successful trash operation should complete for folders");
        assert!(!folder.exists());
        assert_eq!(
            fs::read(trashed_folder.join("nested.txt"))
                .expect("trashed folder should retain nested contents"),
            b"nested contents"
        );
    }

    #[test]
    fn delete_preserves_source_when_the_trash_operation_fails() {
        let directory = TempDir::new();
        let source = directory.path().join("source.txt");
        fs::write(&source, b"keep these contents").expect("source file should be created");
        let mut operation_called = false;

        let error = delete_path_with(&source, |attempted_source| {
            operation_called = true;
            assert_eq!(attempted_source, source.as_path());
            Err(io::Error::other("Recycle Bin is unavailable"))
        })
        .expect_err("a failed trash operation should be reported");

        assert!(operation_called);
        assert!(error.contains("Unable to move item to the system trash"));
        assert_eq!(
            fs::read(&source).expect("failed trash operation must preserve the source"),
            b"keep these contents"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rename_rejects_symlink_destination_without_replacing_the_link() {
        let directory = TempDir::new();
        let source = directory.path().join("source.txt");
        let target = directory.path().join("target.txt");
        let destination = directory.path().join("destination.txt");
        fs::write(&source, b"source contents").expect("source should be created");
        fs::write(&target, b"target contents").expect("target should be created");
        std::os::unix::fs::symlink(&target, &destination)
            .expect("destination symlink should exist");

        let error = rename_path_sync(wire_path(&source), wire_path(&destination))
            .expect_err("an existing symlink must not be replaced");

        assert!(error.contains("destination already exists"));
        assert_eq!(
            fs::read(&source).expect("source should be preserved"),
            b"source contents"
        );
        assert_eq!(
            fs::read_link(&destination).expect("symlink should be preserved"),
            target
        );
        assert_eq!(
            fs::read(&target).expect("symlink target should be preserved"),
            b"target contents"
        );
    }

    #[test]
    fn save_rejects_oversized_normalized_content_before_replacing_file() {
        let directory = TempDir::new();
        let path = directory.path().join("document.txt");
        fs::write(&path, b"original contents").expect("file should be created");
        let content = format!("{}\n", "x".repeat(MAX_FILE_READ_BYTES as usize - 1));
        let locks = Arc::new(Mutex::new(HashMap::new()));

        let error = save_file_sync(
            wire_path(&path),
            content,
            "crlf".to_string(),
            None,
            false,
            None,
            None,
            None,
            locks,
        )
        .expect_err("CRLF expansion beyond the limit must be rejected before writing");

        assert!(error.contains("file is too large"));
        assert_eq!(
            fs::read(&path).expect("the original file should be readable"),
            b"original contents"
        );
    }

    #[test]
    fn mixed_eol_utf8_bom_round_trip_preserves_original_bytes() {
        let directory = TempDir::new();
        let path = directory.path().join("mixed.txt");
        let original = b"\xef\xbb\xbfalpha\r\nbeta\ngamma\r\n";
        fs::write(&path, original).expect("file should be created");

        let file = read_file_sync(wire_path(&path)).expect("UTF-8 BOM text should be readable");
        assert_eq!(file.content, "alpha\nbeta\ngamma\n");
        assert_eq!(file.encoding, "utf-8-bom");
        assert!(file.bom);
        assert_eq!(file.line_endings, "clc");
        assert_eq!(file.line_ending, "crlf");
        save_file_sync(
            wire_path(&path),
            file.content.clone(),
            file.line_ending.clone(),
            Some(file.line_endings.clone()),
            file.bom,
            Some(file.modified_at),
            Some(file.size),
            Some(file.fingerprint.clone()),
            Arc::new(Mutex::new(HashMap::new())),
        )
        .expect("unmodified file should save");
        assert_eq!(
            fs::read(&path).expect("saved file should be readable"),
            original
        );
        let reread =
            read_file_sync(wire_path(&path)).expect("saved UTF-8 BOM text should be readable");
        assert_eq!(reread.content, file.content);
        assert_eq!(reread.line_endings, file.line_endings);
        assert_eq!(reread.bom, file.bom);
    }

    #[test]
    fn bom_only_file_round_trips_without_inventing_content_or_newlines() {
        let directory = TempDir::new();
        let path = directory.path().join("empty-bom.txt");
        let original = b"\xef\xbb\xbf";
        fs::write(&path, original).expect("file should be created");

        let file = read_file_sync(wire_path(&path)).expect("BOM-only text should be readable");
        assert_eq!(file.content, "");
        assert_eq!(file.line_endings, "");
        assert!(file.bom);
        assert_eq!(
            serialize_save_content("", Some(""), "lf", true).expect("BOM should be retained"),
            original
        );
    }

    #[test]
    fn localized_edit_preserves_unchanged_line_endings() {
        let directory = TempDir::new();
        let path = directory.path().join("localized.txt");
        fs::write(&path, b"alpha\r\nbeta\ngamma\r\n").expect("file should be created");
        let original = read_file_sync(wire_path(&path)).expect("file should be readable");

        save_file_sync(
            wire_path(&path),
            "alpha!\nbeta\ngamma\n".to_string(),
            original.line_ending.clone(),
            Some(original.line_endings.clone()),
            original.bom,
            Some(original.modified_at),
            Some(original.size),
            Some(original.fingerprint),
            Arc::new(Mutex::new(HashMap::new())),
        )
        .expect("localized edit should save");

        assert_eq!(
            fs::read(&path).expect("saved file should be readable"),
            b"alpha!\r\nbeta\ngamma\r\n"
        );
    }

    #[test]
    fn inserted_and_deleted_lines_use_the_supplied_per_line_metadata() {
        let inserted =
            serialize_save_content("alpha\ninserted\nbeta\ngamma", Some("ccl"), "lf", false)
                .expect("inserted lines should serialize");
        assert_eq!(inserted, b"alpha\r\ninserted\r\nbeta\ngamma");

        let deleted = serialize_save_content("alpha\ngamma", Some("c"), "lf", false)
            .expect("deleted lines should serialize");
        assert_eq!(deleted, b"alpha\r\ngamma");
    }

    #[test]
    fn unsupported_encoding_is_rejected_without_changing_disk_bytes() {
        let directory = TempDir::new();
        let path = directory.path().join("utf16.txt");
        let original = b"\xff\xfeh\0i\0";
        fs::write(&path, original).expect("file should be created");

        let error = read_file_sync(wire_path(&path)).expect_err("non-UTF-8 should be rejected");
        assert!(error.contains("Only UTF-8 and UTF-8 with BOM"));

        let save_error = save_file_sync(
            wire_path(&path),
            "replacement".to_string(),
            "lf".to_string(),
            Some(String::new()),
            false,
            None,
            None,
            None,
            Arc::new(Mutex::new(HashMap::new())),
        )
        .expect_err("unsupported encoding must not be overwritten through save");
        assert!(save_error.contains("Only UTF-8 and UTF-8 with BOM"));
        assert_eq!(
            fs::read(&path).expect("file should remain readable"),
            original
        );
    }

    #[test]
    fn lone_cr_line_endings_are_rejected_without_changing_disk_bytes() {
        let directory = TempDir::new();
        let path = directory.path().join("old-mac.txt");
        let original = b"alpha\rbeta";
        fs::write(&path, original).expect("file should be created");

        let error = read_file_sync(wire_path(&path)).expect_err("lone CR should be rejected");
        assert!(error.contains("Only LF and CRLF"));
        assert_eq!(
            fs::read(&path).expect("file should remain readable"),
            original
        );
    }

    #[test]
    fn exactly_twenty_mib_is_allowed_and_bom_or_expansion_over_limit_is_rejected() {
        let exact = "x".repeat(MAX_FILE_READ_BYTES as usize);
        let exact_bytes = serialize_save_content(&exact, Some(""), "lf", false)
            .expect("exactly 20 MiB should be allowed");
        assert_eq!(exact_bytes.len() as u64, MAX_FILE_READ_BYTES);
        assert!(serialize_save_content(&exact, Some(""), "lf", true).is_err());

        let with_newline = format!("{exact}\n");
        assert!(serialize_save_content(&with_newline, Some("c"), "crlf", false).is_err());
    }

    #[test]
    fn read_rejects_files_over_twenty_mib() {
        let directory = TempDir::new();
        let path = directory.path().join("oversized.txt");
        let original = vec![b'x'; MAX_FILE_READ_BYTES as usize + 1];
        fs::write(&path, &original).expect("oversized file should be created");

        let error =
            read_file_sync(wire_path(&path)).expect_err("files over 20 MiB must be rejected");

        assert!(error.contains("file is too large to open"));
        assert_eq!(
            fs::metadata(&path).expect("file should remain").len(),
            original.len() as u64
        );
    }

    #[test]
    fn save_as_over_limit_leaves_existing_destination_untouched() {
        let directory = TempDir::new();
        let path = directory.path().join("destination.txt");
        fs::write(&path, b"destination").expect("destination should be created");
        let content = "x".repeat(MAX_FILE_READ_BYTES as usize);
        let locks = Arc::new(Mutex::new(HashMap::new()));
        let state = destination_state(&path);

        let error = save_file_as_sync(
            wire_path(&path),
            state,
            content,
            "lf".to_string(),
            Some(String::new()),
            true,
            locks,
        )
        .expect_err("BOM would exceed the save limit");
        assert!(error.contains("file is too large to save"));
        assert_eq!(
            fs::read(&path).expect("destination should remain readable"),
            b"destination"
        );
    }

    #[test]
    fn save_rejects_external_change_before_replacing_it() {
        let directory = TempDir::new();
        let path = directory.path().join("changed.txt");
        fs::write(&path, b"original\n").expect("file should be created");
        let original = read_file_sync(wire_path(&path)).expect("file should be readable");
        fs::write(&path, b"external\n").expect("external change should be written");
        let locks = Arc::new(Mutex::new(HashMap::new()));

        let error = save_file_sync(
            wire_path(&path),
            "local\n".to_string(),
            original.line_ending.clone(),
            Some(original.line_endings.clone()),
            original.bom,
            Some(original.modified_at),
            Some(original.size),
            Some(original.fingerprint),
            locks,
        )
        .expect_err("a changed file must not be replaced");
        assert!(error.contains("changed on disk"));
        assert_eq!(
            fs::read(&path).expect("file should remain readable"),
            b"external\n"
        );
    }

    #[test]
    fn second_window_cannot_save_using_a_stale_disk_fingerprint() {
        let directory = TempDir::new();
        let path = directory.path().join("shared.txt");
        fs::write(&path, b"initial\n").expect("file should be created");
        let original = read_file_sync(wire_path(&path)).expect("file should be readable");

        save_file_sync(
            wire_path(&path),
            "first window\n".to_string(),
            original.line_ending.clone(),
            Some(original.line_endings.clone()),
            original.bom,
            Some(original.modified_at),
            Some(original.size),
            Some(original.fingerprint.clone()),
            Arc::new(Mutex::new(HashMap::new())),
        )
        .expect("the first window should save its current version");

        let stale_error = save_file_sync(
            wire_path(&path),
            "second window\n".to_string(),
            original.line_ending,
            Some(original.line_endings),
            original.bom,
            Some(original.modified_at),
            Some(original.size),
            Some(original.fingerprint),
            Arc::new(Mutex::new(HashMap::new())),
        )
        .expect_err("a second window must not replace the first window's save");

        assert!(stale_error.contains("changed on disk"));
        assert_eq!(
            fs::read(&path).expect("the first window's save should remain"),
            b"first window\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn save_preserves_unix_file_mode_bits() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let directory = TempDir::new();
        let path = directory.path().join("executable.txt");
        fs::write(&path, b"before\n").expect("file should be created");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o751))
            .expect("file mode should be set");
        let original = read_file_sync(wire_path(&path)).expect("file should be readable");

        save_file_sync(
            wire_path(&path),
            "after\n".to_string(),
            original.line_ending,
            Some(original.line_endings),
            original.bom,
            Some(original.modified_at),
            Some(original.size),
            Some(original.fingerprint),
            Arc::new(Mutex::new(HashMap::new())),
        )
        .expect("file should save");

        assert_eq!(
            fs::metadata(&path)
                .expect("saved file metadata should be readable")
                .mode()
                & 0o777,
            0o751
        );
    }

    #[cfg(unix)]
    #[test]
    fn save_refuses_a_read_only_file_without_changing_its_bytes_or_mode() {
        use std::os::unix::fs::MetadataExt;
        use std::os::unix::fs::PermissionsExt;

        let directory = TempDir::new();
        let path = directory.path().join("read-only.txt");
        fs::write(&path, b"protected\n").expect("file should be created");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444))
            .expect("file should become read-only");
        let original = read_file_sync(wire_path(&path)).expect("file should be readable");

        let error = save_file_sync(
            wire_path(&path),
            "replacement\n".to_string(),
            original.line_ending,
            Some(original.line_endings),
            original.bom,
            Some(original.modified_at),
            Some(original.size),
            Some(original.fingerprint),
            Arc::new(Mutex::new(HashMap::new())),
        )
        .expect_err("saving a read-only file should produce a clear error");

        assert!(error.contains("read-only"));
        assert_eq!(
            fs::read(&path).expect("original should remain"),
            b"protected\n"
        );
        assert_eq!(
            fs::metadata(&path)
                .expect("file metadata should be readable")
                .mode()
                & 0o777,
            0o444
        );
    }

    #[cfg(windows)]
    #[test]
    fn save_preserves_windows_file_attributes_and_named_streams() {
        use std::os::windows::ffi::OsStrExt;

        #[link(name = "kernel32")]
        extern "system" {
            fn GetFileAttributesW(path: *const u16) -> u32;
            fn SetFileAttributesW(path: *const u16, attributes: u32) -> i32;
        }

        let directory = TempDir::new();
        let path = directory.path().join("hidden.txt");
        fs::write(&path, b"before\n").expect("file should be created");
        let path_w: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let attributes = unsafe { GetFileAttributesW(path_w.as_ptr()) };
        assert_ne!(attributes, u32::MAX, "file attributes should be available");
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x0000_0002;
        assert_ne!(
            unsafe { SetFileAttributesW(path_w.as_ptr(), attributes | FILE_ATTRIBUTE_HIDDEN) },
            0,
            "test file should become hidden"
        );
        let stream = PathBuf::from(format!("{}:pude-test", path.display()));
        fs::write(&stream, b"keep-stream").expect("named data stream should be created on NTFS");
        let original = read_file_sync(wire_path(&path)).expect("file should be readable");

        save_file_sync(
            wire_path(&path),
            "after\n".to_string(),
            original.line_ending,
            Some(original.line_endings),
            original.bom,
            Some(original.modified_at),
            Some(original.size),
            Some(original.fingerprint),
            Arc::new(Mutex::new(HashMap::new())),
        )
        .expect("file should save");

        let saved_attributes = unsafe { GetFileAttributesW(path_w.as_ptr()) };
        assert_ne!(saved_attributes, u32::MAX);
        assert_ne!(saved_attributes & FILE_ATTRIBUTE_HIDDEN, 0);
        assert_eq!(
            fs::read(&stream).expect("named stream should survive replacement"),
            b"keep-stream"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn save_preserves_macos_extended_attributes() {
        use std::ffi::CString;
        use std::os::raw::{c_char, c_int, c_void};
        use std::os::unix::ffi::OsStrExt;

        #[link(name = "System")]
        extern "C" {
            fn setxattr(
                path: *const c_char,
                name: *const c_char,
                value: *const c_void,
                size: usize,
                position: u32,
                options: c_int,
            ) -> c_int;
            fn getxattr(
                path: *const c_char,
                name: *const c_char,
                value: *mut c_void,
                size: usize,
                position: u32,
                options: c_int,
            ) -> isize;
        }

        let directory = TempDir::new();
        let path = directory.path().join("with-xattr.txt");
        let name = CString::new("com.pude.test").expect("attribute name should be valid");
        let value = b"preserve-me";
        fs::write(&path, b"before\n").expect("file should be created");
        let path_c = CString::new(path.as_os_str().as_bytes()).expect("path should be valid");
        let set = unsafe {
            setxattr(
                path_c.as_ptr(),
                name.as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                0,
                0,
            )
        };
        assert_eq!(set, 0, "test attribute should be set");
        let original = read_file_sync(wire_path(&path)).expect("file should be readable");

        save_file_sync(
            wire_path(&path),
            "after\n".to_string(),
            original.line_ending,
            Some(original.line_endings),
            original.bom,
            Some(original.modified_at),
            Some(original.size),
            Some(original.fingerprint),
            Arc::new(Mutex::new(HashMap::new())),
        )
        .expect("file should save");

        let mut actual = vec![0; value.len()];
        let size = unsafe {
            getxattr(
                path_c.as_ptr(),
                name.as_ptr(),
                actual.as_mut_ptr().cast(),
                actual.len(),
                0,
                0,
            )
        };
        assert_eq!(size, value.len() as isize);
        assert_eq!(actual, value);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_read_and_save_return_an_identifiable_error_without_touching_target() {
        let directory = TempDir::new();
        let target = directory.path().join("target.txt");
        let link = directory.path().join("link.txt");
        fs::write(&target, b"keep\n").expect("target should be created");
        std::os::unix::fs::symlink(&target, &link).expect("symlink should be created");

        let read_error = read_file_sync(wire_path(&link)).expect_err("symlink read is unsupported");
        assert!(read_error.contains("Symlink files are not supported"));
        let save_error = save_file_as_sync(
            wire_path(&link),
            "unused-invalid-destination-state".to_string(),
            "overwrite\n".to_string(),
            "lf".to_string(),
            Some(String::new()),
            false,
            Arc::new(Mutex::new(HashMap::new())),
        )
        .expect_err("Save As must not replace a symlink");
        assert!(save_error.contains("Symlink"));
        assert_eq!(fs::read(&target).expect("target should remain"), b"keep\n");
        assert_eq!(fs::read_link(&link).expect("link should remain"), target);
    }

    #[test]
    fn path_exists_distinguishes_existing_and_missing_destinations() {
        let directory = TempDir::new();
        let existing = directory.path().join("existing.txt");
        let missing = directory.path().join("missing.txt");
        fs::write(&existing, b"existing contents").expect("file should be created");

        assert!(path_exists_sync(wire_path(&existing)).expect("existing path should be inspected"));
        assert!(!path_exists_sync(wire_path(&missing)).expect("missing path should be inspected"));
    }
}

#[cfg(test)]
mod directory_partial_error_tests {
    use super::set_directory_partial_error;

    #[test]
    fn partial_errors_keep_a_bounded_message_and_aggregate_count() {
        let mut partial_error = None;
        set_directory_partial_error(&mut partial_error, "entry", "first failure");
        set_directory_partial_error(&mut partial_error, "metadata", "second failure");
        let partial_error = partial_error.expect("the first partial error should be retained");
        assert_eq!(partial_error.kind, "entry");
        assert_eq!(partial_error.count, 2);
        assert_eq!(partial_error.message, "first failure");
    }
}

#[cfg(test)]
mod saved_fingerprint_tests {
    use super::{content_fingerprint, verify_saved_bytes};

    #[test]
    fn saved_buffer_fingerprint_is_computed_once_and_reused_for_validation_and_result() {
        let saved = b"the exact bytes on disk";
        let serialized = b"the bytes that were staged";
        let mut saved_hash_calls = 0;
        let mut serialized_hash_calls = 0;
        let fingerprint = verify_saved_bytes(saved, serialized, |bytes| {
            if bytes == saved {
                saved_hash_calls += 1;
                "matching-fingerprint".to_string()
            } else {
                assert_eq!(bytes, serialized);
                serialized_hash_calls += 1;
                "matching-fingerprint".to_string()
            }
        })
        .expect("matching bytes should pass verification");

        assert_eq!(fingerprint, "matching-fingerprint");
        assert_eq!(saved_hash_calls, 1);
        assert_eq!(serialized_hash_calls, 1);
        assert_eq!(
            verify_saved_bytes(saved, saved, content_fingerprint).unwrap(),
            content_fingerprint(saved)
        );
    }
}

#[cfg(test)]
mod directory_listing_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("pude-dir-listing-{}", Uuid::new_v4()));
            fs::create_dir(&path).expect("temporary test directory should be created");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn list_directory_classifies_entries_and_does_not_follow_symlinks() {
        let temp = TempDir::new();
        fs::create_dir(temp.path().join("folder")).expect("directory should be created");
        fs::write(temp.path().join("note.txt"), "hello").expect("file should be written");
        #[cfg(unix)]
        std::os::unix::fs::symlink(temp.path().join("note.txt"), temp.path().join("note-link"))
            .expect("symlink should be created");

        let listing =
            list_directory_sync(wire_path(temp.path())).expect("directory should be listed");
        let entry = |name: &str| {
            listing
                .entries
                .iter()
                .find(|entry| entry.name == name)
                .unwrap_or_else(|| panic!("entry {name} should be listed"))
        };

        assert_eq!(entry("folder").kind, "directory");
        assert_eq!(entry("folder").size, None);
        assert_eq!(entry("note.txt").kind, "file");
        #[cfg(windows)]
        {
            assert_eq!(entry("note.txt").size, Some(5));
            assert!(entry("note.txt").modified_at.is_some());
        }
        #[cfg(not(windows))]
        {
            // Size/mtime are not fetched on Unix until a consumer
            // needs them; the serialized fields stay present as null.
            assert_eq!(entry("note.txt").size, None);
            assert_eq!(entry("note.txt").modified_at, None);
        }
        #[cfg(unix)]
        assert_eq!(entry("note-link").kind, "symlink");
        #[cfg(unix)]
        assert_eq!(
            listing
                .entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["folder", "note-link", "note.txt"]
        );
        #[cfg(not(unix))]
        assert_eq!(
            listing
                .entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["folder", "note.txt"]
        );
        assert!(listing.partial_error.is_none());
        assert!(!listing.incomplete);
        assert_eq!(listing.stop_reason, None);
        assert_eq!(listing.max_entries, MAX_DIRECTORY_LISTING_ENTRIES);
        assert_eq!(listing.scanned_entries, listing.entries.len());
        assert!(listing.entries_bytes <= MAX_DIRECTORY_LISTING_BYTES);
        assert!(serde_json::to_vec(&listing).unwrap().len() <= MAX_DIRECTORY_LISTING_BYTES);
    }

    #[test]
    fn directory_limit_returns_a_sorted_subset_and_explicitly_reports_incompleteness() {
        let temp = TempDir::new();
        for index in 0..=MAX_DIRECTORY_LISTING_ENTRIES {
            fs::write(temp.path().join(format!("entry-{index:05}.txt")), b"")
                .expect("fixture entry should be created");
        }

        let listing = list_directory_sync(wire_path(temp.path())).unwrap();

        assert_eq!(listing.entries.len(), MAX_DIRECTORY_LISTING_ENTRIES);
        assert!(listing.incomplete);
        assert_eq!(listing.stop_reason.as_deref(), Some("entryLimit"));
        assert_eq!(listing.max_entries, MAX_DIRECTORY_LISTING_ENTRIES);
        assert_eq!(listing.scanned_entries, MAX_DIRECTORY_LISTING_ENTRIES + 1);
        assert!(listing.entries_bytes <= MAX_DIRECTORY_LISTING_BYTES);
        assert!(serde_json::to_vec(&listing).unwrap().len() <= MAX_DIRECTORY_LISTING_BYTES);
        assert!(listing.partial_error.is_none());
        assert!(listing
            .entries
            .windows(2)
            .all(|entries| entries[0].name.to_lowercase() <= entries[1].name.to_lowercase()));
    }

    #[test]
    fn directory_scan_limit_bounds_entries_that_cannot_be_serialized() {
        let temp = TempDir::new();
        for index in 0..=MAX_DIRECTORY_LISTING_ENTRIES {
            fs::write(temp.path().join(format!("entry-{index:05}.txt")), b"")
                .expect("fixture entry should be created");
        }

        let listing = list_directory_sync_with_path_encoder(wire_path(temp.path()), None, |_| {
            Err("fixture path cannot be represented".to_string())
        })
        .unwrap();

        assert!(listing.entries.is_empty());
        assert!(listing.incomplete);
        assert_eq!(listing.stop_reason.as_deref(), Some("entryLimit"));
        assert_eq!(listing.scanned_entries, MAX_DIRECTORY_LISTING_ENTRIES + 1);
        let partial_error = listing.partial_error.unwrap();
        assert_eq!(partial_error.kind, "unsupported_path");
        assert_eq!(partial_error.count, MAX_DIRECTORY_LISTING_ENTRIES);
    }

    #[cfg(unix)]
    #[test]
    fn directory_byte_budget_stops_enumeration_and_reports_the_encountered_subset() {
        let temp = TempDir::new();
        for index in 0..8_000 {
            // Quotes are valid POSIX filename bytes and expand to two bytes in
            // JSON, allowing the fixture to exercise the payload cap before
            // the entry cap without relying on an unusually long root path.
            let name = format!("{index:04}{}", "\"".repeat(240));
            fs::write(temp.path().join(name), b"").expect("fixture entry should be created");
        }

        let listing = list_directory_sync(wire_path(temp.path())).unwrap();

        assert!(listing.entries.len() < MAX_DIRECTORY_LISTING_ENTRIES);
        assert!(listing.incomplete);
        assert_eq!(listing.stop_reason.as_deref(), Some("byteLimit"));
        assert!(listing.scanned_entries > listing.entries.len());
        assert!(listing.entries_bytes <= MAX_DIRECTORY_LISTING_BYTES);
        assert!(serde_json::to_vec(&listing).unwrap().len() <= MAX_DIRECTORY_LISTING_BYTES);
        assert!(listing
            .entries
            .windows(2)
            .all(|entries| entries[0].name.to_lowercase() <= entries[1].name.to_lowercase()));
    }

    #[test]
    fn cancelled_listing_returns_an_explicit_cancelled_status_without_claiming_completeness() {
        let temp = TempDir::new();
        fs::write(temp.path().join("entry.txt"), b"").unwrap();
        let cancellation = AtomicBool::new(true);

        let listing =
            list_directory_sync_with_cancellation(wire_path(temp.path()), Some(&cancellation))
                .unwrap();

        assert!(listing.entries.is_empty());
        assert!(listing.incomplete);
        assert_eq!(listing.stop_reason.as_deref(), Some("cancelled"));
        assert_eq!(listing.scanned_entries, 0);
    }

    #[test]
    fn cancellation_during_enumeration_returns_a_distinct_cancelled_result() {
        let temp = TempDir::new();
        for index in 0..32 {
            fs::write(temp.path().join(format!("entry-{index:02}.txt")), b"").unwrap();
        }
        let cancellation = AtomicBool::new(false);
        let encoded_paths = AtomicUsize::new(0);

        let listing = list_directory_sync_with_path_encoder(
            wire_path(temp.path()),
            Some(&cancellation),
            |path| {
                if encoded_paths.fetch_add(1, Ordering::Relaxed) + 1 == 5 {
                    cancellation.store(true, Ordering::Relaxed);
                }
                checked_wire_path(path)
            },
        )
        .unwrap();

        assert!(listing.incomplete);
        assert_eq!(listing.stop_reason.as_deref(), Some("cancelled"));
        assert_eq!(listing.scanned_entries, 5);
        assert_eq!(listing.entries.len(), 5);
    }

    #[test]
    fn request_cancellation_only_affects_the_matching_active_listing() {
        let registration = register_directory_listing(Some("listing-a"))
            .unwrap()
            .unwrap();

        assert!(cancel_directory_listing_sync("listing-b").unwrap());
        assert!(cancel_directory_listing_sync("listing-a").unwrap());
        assert!(registration.cancelled.load(Ordering::Relaxed));
        drop(registration);
        let pending = register_directory_listing(Some("listing-b"))
            .unwrap()
            .unwrap();
        assert!(pending.cancelled.load(Ordering::Relaxed));
    }
}

#[cfg(test)]
mod image_preview_tests {
    use super::*;

    fn png(width: u32, height: u32, animated: bool) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        let mut chunk = |kind: &[u8; 4], data: &[u8]| {
            bytes.extend_from_slice(&(data.len() as u32).to_be_bytes());
            bytes.extend_from_slice(kind);
            bytes.extend_from_slice(data);
            bytes.extend_from_slice(&[0; 4]);
        };
        let mut header = Vec::from(width.to_be_bytes());
        header.extend_from_slice(&height.to_be_bytes());
        header.extend_from_slice(&[8, 2, 0, 0, 0]);
        chunk(b"IHDR", &header);
        if animated {
            chunk(b"acTL", &[0; 8]);
        }
        chunk(b"IDAT", &[]);
        chunk(b"IEND", &[]);
        bytes
    }

    fn gif(frame_count: usize) -> Vec<u8> {
        let mut bytes = b"GIF89a\x02\0\x02\0\0\0\0".to_vec();
        for _ in 0..frame_count {
            bytes.extend_from_slice(b"\x2c\0\0\0\0\x02\0\x02\0\0\x02\x02\x44\x01\0");
        }
        bytes.push(0x3b);
        bytes
    }

    fn webp(width: u16, height: u16, animated: bool) -> Vec<u8> {
        let mut chunks = webp_chunk(b"VP8 ", &vp8_data(width, height));
        if animated {
            chunks.extend_from_slice(&webp_chunk(b"ANIM", &[]));
        }
        webp_file(&chunks)
    }

    fn vp8_data(width: u16, height: u16) -> Vec<u8> {
        let mut data = vec![0, 0, 0, 0x9d, 0x01, 0x2a];
        data.extend_from_slice(&width.to_le_bytes());
        data.extend_from_slice(&height.to_le_bytes());
        data
    }

    fn vp8l_data(width: u16, height: u16) -> Vec<u8> {
        let width = u32::from(width - 1);
        let height = u32::from(height - 1);
        vec![
            0x2f,
            width as u8,
            ((width >> 8) as u8 & 0x3f) | ((height as u8 & 0x03) << 6),
            (height >> 2) as u8,
            ((height >> 10) as u8) & 0x0f,
        ]
    }

    fn vp8x_data(width: u16, height: u16) -> Vec<u8> {
        let mut data = vec![0; 10];
        let width = u32::from(width - 1).to_le_bytes();
        let height = u32::from(height - 1).to_le_bytes();
        data[4..7].copy_from_slice(&width[..3]);
        data[7..10].copy_from_slice(&height[..3]);
        data
    }

    fn webp_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut chunk = Vec::with_capacity(8 + data.len() + (data.len() & 1));
        chunk.extend_from_slice(kind);
        chunk.extend_from_slice(&(data.len() as u32).to_le_bytes());
        chunk.extend_from_slice(data);
        if data.len() & 1 != 0 {
            chunk.push(0);
        }
        chunk
    }

    fn webp_file(chunks: &[u8]) -> Vec<u8> {
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&((chunks.len() + 4) as u32).to_le_bytes());
        bytes.extend_from_slice(b"WEBP");
        bytes.extend_from_slice(chunks);
        bytes
    }

    fn jpeg(width: u16, height: u16) -> Vec<u8> {
        let mut bytes = vec![0xff, 0xd8, 0xff, 0xc0, 0, 11, 8];
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&[1, 1, 0x11, 0]);
        bytes.extend_from_slice(&[0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0, 0xff, 0xd9]);
        bytes
    }

    fn bmp(width: i32, height: i32) -> Vec<u8> {
        let mut bytes = vec![0; 54];
        bytes[0..2].copy_from_slice(b"BM");
        bytes[2..6].copy_from_slice(&54_u32.to_le_bytes());
        bytes[10..14].copy_from_slice(&54_u32.to_le_bytes());
        bytes[14..18].copy_from_slice(&40_u32.to_le_bytes());
        bytes[18..22].copy_from_slice(&width.to_le_bytes());
        bytes[22..26].copy_from_slice(&height.to_le_bytes());
        bytes[26..28].copy_from_slice(&1_u16.to_le_bytes());
        bytes[28..30].copy_from_slice(&24_u16.to_le_bytes());
        bytes
    }

    #[test]
    fn supported_static_headers_are_checked_before_image_bytes_reach_webview() {
        assert_eq!(
            validate_image_dimensions(&png(2048, 2048, false), "image/png"),
            Ok(())
        );
        assert_eq!(
            validate_image_dimensions(&jpeg(2048, 2048), "image/jpeg"),
            Ok(())
        );
        assert_eq!(
            validate_image_dimensions(&webp(2048, 2048, false), "image/webp"),
            Ok(())
        );
        assert_eq!(validate_image_dimensions(&gif(1), "image/gif"), Ok(()));
        assert_eq!(
            validate_image_dimensions(&bmp(2048, -2048), "image/bmp"),
            Ok(())
        );
    }

    #[test]
    fn oversized_truncated_and_animated_images_are_rejected_by_header_policy() {
        let oversized = png(16_385, 1, false);
        assert!(validate_image_dimensions(&oversized, "image/png")
            .unwrap_err()
            .contains("preview limit"));
        assert!(
            validate_image_dimensions(&png(4_096, 4_097, false), "image/png")
                .unwrap_err()
                .contains("preview limit")
        );
        assert!(validate_image_dimensions(&png(64, 64, true), "image/png")
            .unwrap_err()
            .contains("Animated images"));
        assert!(validate_image_dimensions(&gif(2), "image/gif")
            .unwrap_err()
            .contains("Animated images"));
        assert!(validate_image_dimensions(&webp(64, 64, true), "image/webp")
            .unwrap_err()
            .contains("Animated images"));
        assert!(validate_image_dimensions(b"\x89PNG\r\n\x1a\n\0\0", "image/png").is_err());
        assert!(image_mime_type(b"\0\0\x01\0ico").is_none());
    }

    #[test]
    fn every_truncated_webp_suffix_returns_an_error_without_panicking() {
        let valid = webp(64, 64, false);
        for length in 0..valid.len() {
            let result = std::panic::catch_unwind(|| {
                validate_image_dimensions(&valid[..length], "image/webp")
            });
            assert!(result.is_ok(), "truncated WebP panicked at length {length}");
            assert!(
                result.unwrap().is_err(),
                "truncated WebP passed at length {length}"
            );
        }
    }

    #[test]
    fn duplicate_webp_dimensions_are_rejected_instead_of_overwritten() {
        let mut vp8_chunks = webp_chunk(b"VP8 ", &vp8_data(4_096, 4_097));
        vp8_chunks.extend_from_slice(&webp_chunk(b"VP8 ", &vp8_data(64, 64)));
        assert!(validate_image_dimensions(&webp_file(&vp8_chunks), "image/webp").is_err());

        let mut vp8l_chunks = webp_chunk(b"VP8L", &vp8l_data(4_096, 4_097));
        vp8l_chunks.extend_from_slice(&webp_chunk(b"VP8L", &vp8l_data(64, 64)));
        assert!(validate_image_dimensions(&webp_file(&vp8l_chunks), "image/webp").is_err());

        let mut vp8x_chunks = webp_chunk(b"VP8X", &vp8x_data(4_096, 4_097));
        vp8x_chunks.extend_from_slice(&webp_chunk(b"VP8X", &vp8x_data(64, 64)));
        vp8x_chunks.extend_from_slice(&webp_chunk(b"VP8L", &vp8l_data(64, 64)));
        assert!(validate_image_dimensions(&webp_file(&vp8x_chunks), "image/webp").is_err());
    }

    #[test]
    fn duplicate_jpeg_frame_headers_are_rejected_instead_of_overwritten() {
        let mut duplicate = jpeg(4_096, 4_097);
        let smaller = jpeg(64, 64);
        duplicate.splice(15..15, smaller[2..15].iter().copied());

        assert!(validate_image_dimensions(&duplicate, "image/jpeg").is_err());
    }
}
