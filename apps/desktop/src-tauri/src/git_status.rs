// Parsers for `git status --porcelain=v2 -z` and `git show --name-status -z` output.

use crate::{wire_path_bytes, GitCommitFile, GitFileStatus, GitRepositoryState, ParsedGitStatus};

pub(crate) fn parse_git_status(bytes: &[u8]) -> ParsedGitStatus {
    let mut entries = bytes.split(|byte| *byte == 0);
    let mut parsed = ParsedGitStatus::default();
    let mut branch_head = None;
    let mut branch_oid = None;

    while let Some(entry) = entries.next() {
        if entry.is_empty() {
            continue;
        }
        if let Some(value) = entry.strip_prefix(b"# branch.head ") {
            branch_head = Some(String::from_utf8_lossy(value).into_owned());
            continue;
        }
        if let Some(value) = entry.strip_prefix(b"# branch.oid ") {
            branch_oid = Some(String::from_utf8_lossy(value).into_owned());
            continue;
        }
        if let Some(value) = entry.strip_prefix(b"# branch.upstream ") {
            parsed.upstream = Some(String::from_utf8_lossy(value).into_owned());
            continue;
        }
        if let Some(value) = entry.strip_prefix(b"# branch.ab ") {
            if let Ok(value) = std::str::from_utf8(value) {
                let mut counts = value.split_whitespace();
                parsed.ahead = counts
                    .next()
                    .and_then(|count| count.strip_prefix('+'))
                    .and_then(|count| count.parse().ok());
                parsed.behind = counts
                    .next()
                    .and_then(|count| count.strip_prefix('-'))
                    .and_then(|count| count.parse().ok());
            }
            continue;
        }
        if entry.starts_with(b"# ") {
            continue;
        }
        if let Some(fields) = split_git_record(entry, 9, b"1 ") {
            let status = fields[1];
            parsed.files.push(GitFileStatus {
                path: wire_path_bytes(fields[8]),
                index_status: status_char_byte(status.first().copied()),
                worktree_status: status_char_byte(status.get(1).copied()),
                original_path: None,
                conflict: false,
            });
            continue;
        }
        if let Some(fields) = split_git_record(entry, 10, b"2 ") {
            let status = fields[1];
            let original_path = entries
                .next()
                .filter(|path| !path.is_empty())
                .map(wire_path_bytes);
            parsed.files.push(GitFileStatus {
                path: wire_path_bytes(fields[9]),
                index_status: status_char_byte(status.first().copied()),
                worktree_status: status_char_byte(status.get(1).copied()),
                original_path,
                conflict: false,
            });
            continue;
        }
        if let Some(fields) = split_git_record(entry, 11, b"u ") {
            let status = fields[1];
            parsed.files.push(GitFileStatus {
                path: wire_path_bytes(fields[10]),
                index_status: status_char_byte(status.first().copied()),
                worktree_status: status_char_byte(status.get(1).copied()),
                original_path: None,
                conflict: true,
            });
            continue;
        }
        if let Some(path) = entry.strip_prefix(b"? ") {
            parsed.files.push(GitFileStatus {
                path: wire_path_bytes(path),
                index_status: None,
                worktree_status: Some("?".to_string()),
                original_path: None,
                conflict: false,
            });
        }
    }

    parsed.branch = branch_head
        .as_ref()
        .filter(|value| !value.is_empty() && value.as_str() != "(detached)")
        .cloned();
    parsed.head_oid = branch_oid
        .as_ref()
        .filter(|value| !value.is_empty() && value.as_str() != "(initial)")
        .cloned();
    parsed.repository_state = if branch_oid.as_deref() == Some("(initial)") {
        GitRepositoryState::Unborn
    } else if branch_head.as_deref() == Some("(detached)") {
        GitRepositoryState::Detached
    } else if parsed.branch.is_some() {
        GitRepositoryState::Normal
    } else {
        GitRepositoryState::Unknown
    };
    parsed
}

fn split_git_record<'a>(
    entry: &'a [u8],
    field_count: usize,
    prefix: &[u8],
) -> Option<Vec<&'a [u8]>> {
    if !entry.starts_with(prefix) {
        return None;
    }
    let fields: Vec<&[u8]> = entry.splitn(field_count, |byte| *byte == b' ').collect();
    (fields.len() == field_count).then_some(fields)
}

fn status_char_byte(value: Option<u8>) -> Option<String> {
    value
        .filter(|character| *character != b'.' && *character != b' ')
        .map(|character| char::from(character).to_string())
}

pub(crate) fn parse_git_commit_files(bytes: &[u8]) -> Vec<GitCommitFile> {
    let mut fields = bytes
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    let mut files = Vec::new();
    while let Some(status_bytes) = fields.next() {
        let status = String::from_utf8_lossy(status_bytes).trim().to_string();
        let Some(first_path_bytes) = fields.next() else {
            break;
        };
        if status.is_empty() || first_path_bytes.is_empty() {
            continue;
        }
        let first_path = wire_path_bytes(first_path_bytes);
        let is_rename_or_copy = status.starts_with('R') || status.starts_with('C');
        let renamed_path = is_rename_or_copy
            .then(|| fields.next().map(wire_path_bytes))
            .flatten();
        let path = renamed_path.clone().unwrap_or_else(|| first_path.clone());
        files.push(GitCommitFile {
            path,
            status,
            original_path: is_rename_or_copy.then_some(first_path),
        });
    }
    files
}
