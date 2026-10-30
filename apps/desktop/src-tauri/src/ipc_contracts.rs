//! Cross-language wire-contract tests for representative Tauri commands.
//!
//! These tests live below the binary crate root so they can serialize private
//! response DTOs and invoke the production command wrappers with Tauri's
//! MockRuntime. The same versioned JSON fixture is consumed by the desktop
//! TypeScript tests.

use super::*;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

const FIXTURE: &str = include_str!("../tests/fixtures/ipc-contracts-v1.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("IPC fixture should be valid JSON")
}

fn assert_fixture(actual: &Value, expected: &Value) -> Result<(), String> {
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "wire fixture mismatch\nactual: {actual}\nexpected: {expected}"
        ))
    }
}

#[test]
fn rust_serde_responses_match_versioned_wire_fixtures() {
    let fixture = fixture();
    assert_eq!(fixture["schemaVersion"], 1);

    let source_bytes = fixture["readFileSourceText"]
        .as_str()
        .expect("read fixture should include its source text")
        .as_bytes();
    let read_file = ReadFileResult {
        path: "/fixture/notes/例文.rs".to_string(),
        content: "café 🧪\nline\n".to_string(),
        encoding: "utf-8-bom".to_string(),
        line_ending: "lf".to_string(),
        line_endings: "cl".to_string(),
        bom: true,
        modified_at: 1_700_000_000_123,
        size: source_bytes.len(),
        fingerprint: content_fingerprint(source_bytes),
        identity: None,
    };
    let mut expected_read_file = fixture["readFileResponse"].clone();
    expected_read_file["fingerprint"] = json!(content_fingerprint(source_bytes));
    assert_fixture(
        &serde_json::to_value(read_file).unwrap(),
        &expected_read_file,
    )
    .unwrap();

    let git_status = GitStatusResult {
        repository_root: "/workspace/例子".to_string(),
        branch: None,
        repository_state: "detached".to_string(),
        head_oid: None,
        files: Vec::new(),
        commits: Vec::new(),
        error: None,
    };
    assert_fixture(
        &serde_json::to_value(git_status).unwrap(),
        &fixture["gitStatusResponse"],
    )
    .unwrap();

    let git_error = git_runtime::GitErrorInfo {
        kind: git_runtime::GitErrorKind::Failed,
        message: "Open a folder before running Git operations.".to_string(),
        exit_code: None,
        stream: None,
        limit: None,
    };
    assert_fixture(
        &serde_json::to_value(git_error).unwrap(),
        &fixture["gitOperationError"],
    )
    .unwrap();

    let plugin_manifest: plugin_installer::PluginManifest =
        serde_json::from_value(fixture["pluginManifest"].clone())
            .expect("plugin manifest fixture should deserialize with the production model");
    assert_fixture(
        &serde_json::to_value(plugin_manifest).unwrap(),
        &fixture["pluginManifest"],
    )
    .unwrap();

    let lsp_event = lsp_manager::LspEvent::State {
        plugin_id: "org.example.例".to_string(),
        plugin_version: "1.2.3".to_string(),
        workspace_root: "/workspace/例子".to_string(),
        language: "rust".to_string(),
        server_id: "rust-analyzer".to_string(),
        state: "started".to_string(),
        restart_count: 3,
        message: None,
    };
    assert_fixture(
        &serde_json::to_value(lsp_event).unwrap(),
        &fixture["lspEvent"],
    )
    .unwrap();
}

#[test]
fn a_one_sided_field_rename_is_rejected_by_the_contract_comparator() {
    let fixture = fixture();
    let mut drifted = fixture["readFileResponse"].clone();
    let object = drifted
        .as_object_mut()
        .expect("read response fixture should be an object");
    let line_ending = object
        .remove("lineEnding")
        .expect("fixture should contain lineEnding");
    object.insert("line_ending".to_string(), line_ending);

    assert!(assert_fixture(&drifted, &fixture["readFileResponse"]).is_err());
}

struct ScratchDirectory(PathBuf);

impl ScratchDirectory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("pude-ipc-contract-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).expect("create IPC fixture directory");
        Self(path)
    }
}

impl Drop for ScratchDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn test_webview() -> tauri::WebviewWindow<tauri::test::MockRuntime> {
    let app = tauri::test::mock_builder()
        .manage(AppState::default())
        .manage(QuitGateState::default())
        .invoke_handler(tauri::generate_handler![
            filesystem::read_file,
            filesystem::save_file,
            filesystem::stat_files,
            plugin_workspace::plugin_workspace_file_info,
            plugin_workspace::plugin_workspace_read_file_range,
            plugin_workspace::plugin_workspace_release_file_read,
            plugin_workspace::cancel_plugin_workspace_file_read,
            runtime_generic_command_probe,
            git_operation,
            get_git_ignored_paths,
            project_search::search_project,
            project_search::cancel_project_search,
            project_search::replace_in_project,
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build MockRuntime app with production command handlers");
    tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("build MockRuntime webview")
}

/// Compile-time probe for generic runtime command arguments. Tauri's command
/// macro should infer MockRuntime here while production code remains generic.
#[tauri::command]
fn runtime_generic_command_probe<R: tauri::Runtime>(window: tauri::WebviewWindow<R>) -> String {
    window.label().to_string()
}

fn invoke(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    args: Value,
) -> Result<Value, Value> {
    let url = if cfg!(any(windows, target_os = "android")) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    }
    .parse()
    .expect("valid Tauri IPC URL");
    let request = tauri::webview::InvokeRequest {
        cmd: command.to_string(),
        callback: tauri::ipc::CallbackFn(0),
        error: tauri::ipc::CallbackFn(1),
        url,
        body: args.into(),
        headers: Default::default(),
        invoke_key: tauri::test::INVOKE_KEY.to_string(),
    };
    match tauri::test::get_ipc_response(webview, request) {
        Ok(body) => Ok(body
            .deserialize::<Value>()
            .expect("production command response should be JSON")),
        Err(error) => Err(error),
    }
}

fn exact_object_keys(value: &Value) -> Vec<String> {
    let mut keys = value
        .as_object()
        .expect("command response should be an object")
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    keys
}

#[test]
fn project_search_ipc_accepts_frontend_options_and_returns_file_locations() {
    let scratch = ScratchDirectory::new();
    fs::create_dir(scratch.0.join("nested")).unwrap();
    fs::write(scratch.0.join("nested/notes.md"), "heading\n搜尋 needle\n").unwrap();
    let webview = test_webview();
    let result = invoke(&webview, "search_project", json!({
        "workspace": wire_path(&scratch.0),
        "requestId": "search-ipc-test",
        "options": { "query": "NEEDLE", "mode": "content", "caseSensitive": false, "includeIgnored": true }
    })).unwrap();
    assert_eq!(result["matches"].as_array().unwrap().len(), 1);
    assert_eq!(result["matches"][0]["relativePath"], "nested/notes.md");
    assert_eq!(result["matches"][0]["line"], 2);
    assert_eq!(result["matches"][0]["preview"], "搜尋 needle");
    assert_eq!(result["truncated"], false);
    assert_eq!(result["skippedFiles"], 0);
    invoke(
        &webview,
        "cancel_project_search",
        json!({ "requestId": "search-ipc-test" }),
    )
    .unwrap();
}

#[test]
fn project_replace_ipc_accepts_frontend_options_and_reports_changed_files() {
    let scratch = ScratchDirectory::new();
    let target = scratch.0.join("notes.md");
    fs::write(&target, "搜尋 needle NEEDLE\n").unwrap();
    let webview = test_webview();
    let result = invoke(
        &webview,
        "replace_in_project",
        json!({
            "workspace": wire_path(&scratch.0),
            "options": {
                "query": "needle",
                "replacement": "pin",
                "caseSensitive": false,
                "includeIgnored": true,
                "paths": null,
                "skipPaths": []
            }
        }),
    )
    .unwrap();
    assert_eq!(
        exact_object_keys(&result),
        vec![
            "changedFiles",
            "failedFiles",
            "replacements",
            "skippedUnsaved",
            "truncated"
        ]
    );
    assert_eq!(result["replacements"], 2);
    assert_eq!(result["changedFiles"].as_array().unwrap().len(), 1);
    assert_eq!(fs::read_to_string(&target).unwrap(), "搜尋 pin pin\n");
}

#[test]
fn production_tauri_commands_consume_frontend_request_fixtures() {
    let fixture = fixture();
    let scratch = ScratchDirectory::new();
    let webview = test_webview();

    let source_text = fixture["readFileSourceText"].as_str().unwrap();
    let read_path = scratch.0.join("read-測試.txt");
    fs::write(&read_path, source_text.as_bytes()).expect("write read fixture bytes");
    let read_path_wire = wire_path(&read_path);
    let mut read_args = fixture["readFileArgs"].clone();
    read_args["path"] = json!(read_path_wire);
    let read = invoke(&webview, "read_file", read_args).expect("read_file command should resolve");
    assert_eq!(read["path"], read_path_wire);
    assert_eq!(read["content"], "café 🧪\nline\n");
    assert_eq!(read["encoding"], "utf-8-bom");
    assert_eq!(read["lineEnding"], "lf");
    assert_eq!(read["lineEndings"], "cl");
    assert_eq!(read["bom"], true);
    assert_eq!(read["size"], source_text.len());
    assert_eq!(
        read["fingerprint"],
        content_fingerprint(source_text.as_bytes())
    );
    assert!(read["identity"].is_string());
    assert!(read["modifiedAt"].as_u64().unwrap() <= 9_007_199_254_740_991);
    let mut expected_read = fixture["readFileResponse"].clone();
    expected_read["path"] = json!(read_path_wire);
    expected_read["modifiedAt"] = read["modifiedAt"].clone();
    expected_read["fingerprint"] = read["fingerprint"].clone();
    expected_read["identity"] = read["identity"].clone();
    assert_fixture(&read, &expected_read).unwrap();
    assert_eq!(
        exact_object_keys(&read),
        vec![
            "bom",
            "content",
            "encoding",
            "fingerprint",
            "identity",
            "lineEnding",
            "lineEndings",
            "modifiedAt",
            "path",
            "size",
        ]
    );

    let save_path = scratch.0.join("save-測試.txt");
    fs::write(&save_path, source_text.as_bytes()).expect("write save baseline");
    let mut save_args = fixture["saveFileArgs"].clone();
    save_args["path"] = json!(wire_path(&save_path));
    save_args["expectedFingerprint"] = json!(content_fingerprint(source_text.as_bytes()));
    let saved = invoke(&webview, "save_file", save_args)
        .expect("production save_file command should deserialize and resolve");
    let expected_saved_bytes = "\u{feff}改訂版 🧪\r\nsecond".as_bytes();
    assert_eq!(fs::read(&save_path).unwrap(), expected_saved_bytes);
    assert_eq!(saved["size"], expected_saved_bytes.len());
    assert_eq!(
        saved["fingerprint"],
        content_fingerprint(expected_saved_bytes)
    );
    assert!(saved["identity"].is_string());
    assert!(saved["modifiedAt"].as_u64().unwrap() <= 9_007_199_254_740_991);
    let mut expected_saved = fixture["saveFileResponse"].clone();
    expected_saved["modifiedAt"] = saved["modifiedAt"].clone();
    expected_saved["size"] = json!(expected_saved_bytes.len());
    expected_saved["fingerprint"] = saved["fingerprint"].clone();
    expected_saved["identity"] = saved["identity"].clone();
    assert_fixture(&saved, &expected_saved).unwrap();
    assert_eq!(
        exact_object_keys(&saved),
        vec!["fingerprint", "identity", "modifiedAt", "size"]
    );

    let missing_path = scratch.0.join("missing-測試.txt");
    let missing_path_wire = wire_path(&missing_path);
    let mut stat_args = fixture["statFilesArgs"].clone();
    stat_args["request"]["paths"][0] = json!(missing_path_wire);
    let stat =
        invoke(&webview, "stat_files", stat_args).expect("stat_files command should resolve");
    let mut expected_missing = fixture["statFilesMissingEntry"].clone();
    expected_missing["path"] = json!(missing_path_wire);
    assert_fixture(&stat["entries"][0], &expected_missing).unwrap();
    assert_eq!(stat["entries"].as_array().unwrap().len(), 1);

    let git_error = invoke(
        &webview,
        "git_operation",
        fixture["gitOperationArgs"].clone(),
    )
    .expect_err("production git_operation should return its empty-workspace error");
    assert_fixture(&git_error, &fixture["gitOperationError"]).unwrap();
    assert_eq!(
        invoke(&webview, "runtime_generic_command_probe", json!({})).unwrap(),
        "main"
    );

    let plugin_workspace = scratch.0.join("plugin-workspace-例");
    fs::create_dir_all(&plugin_workspace).expect("create plugin workspace fixture");
    let plugin_path = plugin_workspace.join("range-測試.txt");
    let plugin_text = fixture["pluginWorkspaceLogicalText"].as_str().unwrap();
    fs::write(&plugin_path, plugin_text.as_bytes()).expect("write plugin range fixture bytes");
    let plugin_workspace_wire = wire_path(&plugin_workspace);
    let mut file_info_args = fixture["pluginWorkspaceFileInfoArgs"].clone();
    file_info_args["workspace"] = json!(plugin_workspace_wire);
    let file_info = invoke(&webview, "plugin_workspace_file_info", file_info_args)
        .expect("production plugin file info command should resolve");
    let revision = file_info["revision"]
        .as_str()
        .expect("plugin revision should be a string");
    let mut expected_info = fixture["pluginWorkspaceFileInfoResponse"].clone();
    expected_info["revision"] = json!(revision);
    assert_fixture(&file_info, &expected_info).unwrap();

    let mut first_range_args = fixture["pluginWorkspaceReadFileRangeArgs"].clone();
    first_range_args["workspace"] = json!(plugin_workspace_wire);
    first_range_args["revision"] = json!(revision);
    let first_range = invoke(
        &webview,
        "plugin_workspace_read_file_range",
        first_range_args,
    )
    .expect("production plugin range command should resolve at the first UTF-8 boundary");
    let mut expected_first_range = fixture["pluginWorkspaceReadFileRangeResponse"].clone();
    expected_first_range["revision"] = json!(revision);
    assert_fixture(&first_range, &expected_first_range).unwrap();

    let mut release_args = fixture["pluginWorkspaceReleaseFileReadArgs"].clone();
    release_args["workspace"] = json!(plugin_workspace_wire);
    release_args["revision"] = json!(revision);
    let release = invoke(&webview, "plugin_workspace_release_file_read", release_args)
        .expect("production plugin snapshot release command should resolve");
    assert!(release.is_null());

    let mut second_range_args = fixture["pluginWorkspaceReadFileRangeSecondArgs"].clone();
    second_range_args["workspace"] = json!(plugin_workspace_wire);
    second_range_args["revision"] = json!(revision);
    let second_range = invoke(
        &webview,
        "plugin_workspace_read_file_range",
        second_range_args,
    )
    .expect("production plugin range command should resolve at the next UTF-8 boundary");
    let mut expected_second_range = fixture["pluginWorkspaceReadFileRangeSecondResponse"].clone();
    expected_second_range["revision"] = json!(revision);
    assert_fixture(&second_range, &expected_second_range).unwrap();

    let cancel = invoke(
        &webview,
        "cancel_plugin_workspace_file_read",
        fixture["pluginWorkspaceCancelFileReadArgs"].clone(),
    )
    .expect("production plugin cancellation command should resolve");
    assert_eq!(cancel, fixture["pluginWorkspaceCancelFileReadResponse"]);
    let mut cancelled_range_args = fixture["pluginWorkspaceReadFileRangeArgs"].clone();
    cancelled_range_args["workspace"] = json!(plugin_workspace_wire);
    cancelled_range_args["revision"] = json!(revision);
    cancelled_range_args["requestId"] =
        fixture["pluginWorkspaceCancelFileReadArgs"]["requestId"].clone();
    let cancelled_range = invoke(
        &webview,
        "plugin_workspace_read_file_range",
        cancelled_range_args,
    )
    .expect_err("pre-start cancellation should reject the real range command");
    assert_eq!(
        cancelled_range,
        fixture["pluginWorkspaceCancelledReadError"]
    );
}

#[test]
fn ignored_paths_command_accepts_paths_and_handles_non_repositories() {
    let scratch = ScratchDirectory::new();
    let root = scratch.0.canonicalize().unwrap();
    let webview = test_webview();
    let path = wire_path(&root.join("test.log"));
    let args = json!({ "workspace": wire_path(&root), "paths": [path] });
    assert_eq!(
        invoke(&webview, "get_git_ignored_paths", args.clone()).unwrap(),
        json!([])
    );
    assert!(std::process::Command::new("git")
        .args(["init", "--quiet"])
        .arg(&root)
        .status()
        .unwrap()
        .success());
    fs::write(root.join(".gitignore"), "*.log\n").unwrap();
    fs::write(root.join("test.log"), "fixture").unwrap();
    assert_eq!(
        invoke(&webview, "get_git_ignored_paths", args).unwrap(),
        json!([path])
    );
    let error = invoke(
        &webview,
        "get_git_ignored_paths",
        json!({ "workspace": wire_path(&root), "paths": vec![path; 257] }),
    )
    .unwrap_err();
    assert_eq!(error["kind"], "capacity");
}

fn git_in(directory: &std::path::Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .current_dir(directory)
        .args(args)
        .output()
        .expect("git should start");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn committed_repository(scratch: &ScratchDirectory) -> PathBuf {
    let root = scratch.0.canonicalize().unwrap();
    git_in(&root, &["init", "--quiet", "--initial-branch=main"]);
    git_in(&root, &["config", "user.name", "Pude Test"]);
    git_in(
        &root,
        &["config", "user.email", "pude-test@example.invalid"],
    );
    fs::write(root.join("tracked.txt"), "tracked\n").unwrap();
    git_in(&root, &["add", "tracked.txt"]);
    git_in(&root, &["commit", "--quiet", "-m", "initial commit"]);
    root
}

fn git_action(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    root: &std::path::Path,
    action: &str,
    value: &str,
    start_point: Option<&str>,
) -> Result<Value, Value> {
    invoke(
        webview,
        "git_operation",
        json!({
            "workspace": wire_path(root),
            "action": action,
            "value": value,
            "originalPath": null,
            "message": null,
            "startPoint": start_point,
        }),
    )
}

#[test]
fn git_branch_operations_never_treat_user_values_as_options() {
    let scratch = ScratchDirectory::new();
    let root = committed_repository(&scratch);
    let webview = test_webview();
    let head = git_in(&root, &["rev-parse", "HEAD"]);
    git_in(&root, &["branch", "feature"]);
    fs::write(root.join("tracked.txt"), "dirty\n").unwrap();

    for option in ["--detach", "--discard-changes", "--force", "-f"] {
        assert!(git_action(&webview, &root, "switch", option, None).is_err());
        assert!(git_action(&webview, &root, "create-branch", option, None).is_err());
        assert!(git_action(&webview, &root, "delete-branch", option, None).is_err());
        assert!(
            git_action(&webview, &root, "create-branch", "topic", Some(option)).is_err(),
            "{option} must not be accepted as a start point"
        );
    }
    assert_eq!(git_in(&root, &["branch", "--show-current"]), "main");
    assert_eq!(
        fs::read_to_string(root.join("tracked.txt")).unwrap(),
        "dirty\n"
    );
    assert_eq!(git_in(&root, &["branch", "--list", "topic"]), "");

    git_action(&webview, &root, "create-branch", "topic", Some(&head))
        .expect("a commit ID is a valid start point");
    assert_eq!(git_in(&root, &["branch", "--show-current"]), "topic");
    git_action(&webview, &root, "switch", "feature", None).expect("branch names still switch");
    assert_eq!(git_in(&root, &["branch", "--show-current"]), "feature");
    git_action(&webview, &root, "delete-branch", "topic", None).expect("branch names still delete");
    assert_eq!(git_in(&root, &["branch", "--list", "topic"]), "");
}

#[test]
fn git_commit_reads_reject_anything_but_a_full_object_id() {
    let scratch = ScratchDirectory::new();
    let root = committed_repository(&scratch);
    let head = git_in(&root, &["rev-parse", "HEAD"]);
    let runtime = GitCoordinator::new();
    let request = runtime.begin_request(&root, None);

    for commit in ["--output=injected.txt", "--stat", "HEAD", &head[..7], ""] {
        let error = git_commit_files_sync(root.clone(), commit.to_string(), &runtime, &request)
            .expect_err("only full object IDs may reach git show");
        assert_eq!(error.kind, GitErrorKind::Failed, "{commit}");
    }
    assert!(!root.join("injected.txt").exists());

    let files = git_commit_files_sync(root.clone(), head, &runtime, &request)
        .expect("a full object ID lists the commit files");
    assert_eq!(files.len(), 1);
}
