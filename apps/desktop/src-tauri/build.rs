fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        build_terminal_bootstrap();
    }
    const COMMANDS: &[&str] = &[
        "startup_folder",
        "open_folder_dialog",
        "open_file_dialog",
        "save_file_dialog",
        "open_new_window",
        "list_directory",
        "read_file",
        "read_workspace_image",
        "path_exists",
        "stat_files",
        "save_file",
        "save_file_as",
        "inspect_save_as_destination",
        "create_file",
        "create_directory",
        "rename_path",
        "delete_path",
        "git_status",
        "git_branches",
        "git_commits",
        "cancel_workspace",
        "git_operation",
        "create_git_worktree",
        "git_diff",
        "git_commit_diff",
        "git_commit_files",
        "watch_workspace",
        "stop_watcher",
        "terminal_start",
        "terminal_write",
        "terminal_kill",
        "terminal_resize",
        "terminal_ack_output",
        "reveal_in_file_manager",
        "check_for_update",
        "download_update",
        "restart_to_update",
        "inspect_plugin_dialog",
        "commit_plugin_install",
        "cancel_plugin_install",
        "rollback_plugin_update",
        "uninstall_plugin",
        "retry_plugin_cleanup",
        "recover_plugin_updates",
        "read_plugin_entry",
        "plugin_network_authorize",
        "plugin_network_request",
        "plugin_network_revoke",
        "plugin_network_cancel",
        "plugin_workspace_canonicalize",
        "plugin_git_diff",
        "plugin_workspace_list",
        "plugin_workspace_read_file",
        "plugin_workspace_write_file",
        "lsp_resolve_server",
        "lsp_approve_server",
        "lsp_revoke_server",
        "lsp_start_server",
        "lsp_send_message",
        "lsp_cancel_request",
        "lsp_stop_server",
        "lsp_stop_workspace",
        "lsp_stop_plugin",
        "mark_window_shown",
        "log_frontend_error",
        "get_startup_timing",
        "report_startup_event",
        "app_quit_events_ready",
        "app_quit_prepare_reply",
        "app_quit_commit_ready",
    ];

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to build Tauri application manifest");
}

fn build_terminal_bootstrap() {
    use std::{env, fs, path::PathBuf, process::Command};
    println!("cargo:rerun-if-changed=src/terminal_bootstrap_main.rs");
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"));
    let target = env::var("TARGET").expect("Cargo target");
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo output directory"));
    let binary = output.join("pude-terminal-bootstrap.exe");
    let status = Command::new(env::var_os("RUSTC").expect("Rust compiler"))
        .arg(root.join("src/terminal_bootstrap_main.rs"))
        .args([
            "--edition=2021",
            "--crate-name",
            "pude_terminal_bootstrap",
            "--target",
            &target,
        ])
        .args([
            "-C",
            &format!(
                "opt-level={}",
                env::var("OPT_LEVEL").expect("Cargo optimization level")
            ),
        ])
        .args(["-C", "strip=symbols", "-C", "panic=unwind"])
        .arg("-o")
        .arg(&binary)
        .status()
        .expect("compile Windows terminal bootstrap");
    assert!(
        status.success(),
        "Windows terminal bootstrap compilation failed"
    );
    let binaries = root.join("binaries");
    fs::create_dir_all(&binaries).expect("create generated sidecar directory");
    fs::copy(
        &binary,
        binaries.join(format!("pude-terminal-bootstrap-{target}.exe")),
    )
    .expect("prepare bundled terminal bootstrap");
    let profile_directory = output
        .ancestors()
        .nth(3)
        .expect("Cargo profile output directory");
    fs::copy(
        &binary,
        profile_directory.join("pude-terminal-bootstrap.exe"),
    )
    .expect("prepare development terminal bootstrap");
    println!(
        "cargo:rustc-env=PUDE_TERMINAL_BOOTSTRAP_EXE={}",
        binary.display()
    );
}
