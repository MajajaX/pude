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
