use crate::blocking::BlockingClass;
use crate::plugin_security::{
    PluginTreeBudget, MAX_INSTALLED_PLUGINS, MAX_PLUGIN_INSTALLED_BYTES, MAX_PLUGIN_MANIFEST_BYTES,
    MAX_PLUGIN_TOTAL_BYTES,
};
use crate::run_blocking;
use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

static PLUGIN_STORAGE_LOCK: Mutex<()> = Mutex::new(());
static ACTIVE_PLUGIN_STAGING: Mutex<Vec<String>> = Mutex::new(Vec::new());
static STAGING_CLEANUP_CURSOR: Mutex<Option<String>> = Mutex::new(None);
const MAX_INSTALLED_PLUGIN_COUNT: usize = MAX_INSTALLED_PLUGINS;
const MAX_PLUGIN_STORAGE_BYTES: u64 = MAX_PLUGIN_INSTALLED_BYTES;
const MAX_STAGING_CLEANUP_BATCH: usize = 256;
const STAGING_CLEANUP_ID: &str = "__pude_plugin_staging__";
const STAGING_PREFIX: &str = ".pude-plugin-staging-";

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommandContribution {
    pub command: String,
    pub title: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginContributions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commands: Option<Vec<PluginCommandContribution>>,
    #[serde(flatten)]
    pub other: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginLspServer {
    pub server_id: String,
    pub language: String,
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(rename = "apiVersion")]
    pub api_version: String,
    pub entry: String,
    pub permissions: Vec<String>,
    #[serde(rename = "activationEvents")]
    pub activation_events: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contributes: Option<PluginContributions>,
    #[serde(default, rename = "lspServers", skip_serializing_if = "Vec::is_empty")]
    pub lsp_servers: Vec<PluginLspServer>,
    #[serde(
        default,
        rename = "networkDomains",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub network_domains: Vec<String>,
    #[serde(flatten)]
    pub other: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallPlan {
    transaction_id: String,
    pub manifest: PluginManifest,
    pub installed_manifest: Option<PluginManifest>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPluginResult {
    pub path: String,
    pub manifest: PluginManifest,
    pub cleanup_pending: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUninstallResult {
    pub removed: bool,
    pub cleanup_pending: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStartupRecovery {
    pub plugins: Vec<InstalledPluginResult>,
    pub pending_cleanup_ids: Vec<String>,
}

#[tauri::command]
pub async fn recover_plugin_updates(
    app: AppHandle,
    window: tauri::WebviewWindow,
    quit_gate: State<'_, crate::QuitGateState>,
    ids: Vec<String>,
) -> Result<PluginStartupRecovery, String> {
    let admission = quit_gate.admit_resource_operation(window.label())?;
    run_blocking(
        "Unable to recover plugin installations",
        BlockingClass::File,
        move || {
            let _admission = admission;
            let _storage_lock = PLUGIN_STORAGE_LOCK
                .lock()
                .map_err(|_| "Plugin storage is unavailable.".to_string())?;
            let root = plugin_storage_root(&app)?;
            recover_plugins_from_root(&root, ids)
        },
    )
    .await
}

// SB-06: recovery isolates failures per plugin. A plugin that fails recovery
// is excluded from the recovered set (so it can never execute) and queued for
// cleanup with the reason logged; every other plugin still recovers.
fn recover_plugins_from_root(
    root: &Path,
    ids: Vec<String>,
) -> Result<PluginStartupRecovery, String> {
    if !root.exists() {
        return Ok(PluginStartupRecovery {
            plugins: Vec::new(),
            pending_cleanup_ids: Vec::new(),
        });
    }
    let mut pending_cleanup_ids = Vec::new();
    if cleanup_abandoned_plugin_staging(&root)? {
        pending_cleanup_ids.push(STAGING_CLEANUP_ID.to_string());
    }
    let ids = startup_recovery_ids(&root, ids)?;
    let mut unique_ids = std::collections::HashSet::new();
    let mut plugins = Vec::new();
    for id in ids {
        validate_plugin_id(&id)?;
        if !unique_ids.insert(id.clone()) {
            continue;
        }
        if has_removal_tombstone(&root, &id)? {
            pending_cleanup_ids.push(id);
            continue;
        }
        match recover_one_plugin(&root, &id) {
            Ok(Some(plugin)) => plugins.push(plugin),
            Ok(None) => {}
            Err(error) => {
                crate::app_log::log_error(&format!(
                    "Plugin {id} failed startup recovery and was disabled: {error}"
                ));
                pending_cleanup_ids.push(id);
            }
        }
    }
    Ok(PluginStartupRecovery {
        plugins,
        pending_cleanup_ids,
    })
}

fn recover_one_plugin(root: &Path, id: &str) -> Result<Option<InstalledPluginResult>, String> {
    recover_interrupted_updates(root, id)?;
    let Some(manifest) = read_installed_manifest(root, id)? else {
        return Ok(None);
    };
    let installed_root = plugin_path(root, id);
    validate_plugin_tree(&installed_root)?;
    verify_entry(
        &installed_root,
        &safe_plugin_relative_path(&manifest.entry)?,
    )?;
    Ok(Some(InstalledPluginResult {
        path: installed_root.to_string_lossy().to_string(),
        manifest,
        cleanup_pending: false,
    }))
}

#[tauri::command]
pub async fn inspect_plugin_dialog(
    app: AppHandle,
    window: tauri::WebviewWindow,
    quit_gate: State<'_, crate::QuitGateState>,
) -> Result<Option<PluginInstallPlan>, String> {
    let admission = quit_gate.admit_resource_operation(window.label())?;
    run_blocking("Unable to inspect plugin", BlockingClass::File, move || {
        let _admission = admission;
        inspect_plugin_dialog_sync(app)
    })
    .await
}

fn inspect_plugin_dialog_sync(app: AppHandle) -> Result<Option<PluginInstallPlan>, String> {
    let Some(path) = FileDialog::new().pick_folder() else {
        return Ok(None);
    };
    let _storage_lock = PLUGIN_STORAGE_LOCK
        .lock()
        .map_err(|_| "Plugin storage is unavailable.".to_string())?;
    let source_root = fs::canonicalize(&path)
        .map_err(|error| format!("Unable to access plugin folder. {error}"))?;
    let source_manifest = read_manifest(&source_root)?;
    validate_plugin_manifest(&source_manifest)?;
    let entry = safe_plugin_relative_path(&source_manifest.entry)?;

    let root = plugin_storage_root(&app)?;
    fs::create_dir_all(&root)
        .map_err(|error| format!("Unable to create plugin storage. {error}"))?;
    validate_plugin_storage_root(&root)?;
    if has_removal_tombstone(&root, &source_manifest.id)? {
        return Err(
            "Plugin cleanup is still pending for this id. Retry cleanup before installing it again."
                .to_string(),
        );
    }
    prune_older_rollback_versions(&root, &source_manifest.id)?;
    recover_interrupted_updates(&root, &source_manifest.id)?;
    let installed_manifest = read_installed_manifest(&root, &source_manifest.id)?;
    let transaction_id = Uuid::new_v4().to_string();
    let staging = staging_path(&root, &transaction_id);
    let copy_result = (|| {
        let mut budget = PluginTreeBudget::new();
        copy_plugin_tree(&source_root, &staging, Path::new(""), &mut budget)?;
        verify_entry(&staging, &entry)?;
        let staged_manifest = read_manifest(&staging)?;
        validate_plugin_manifest(&staged_manifest)?;
        if staged_manifest != source_manifest {
            return Err(
                "The plugin manifest changed while it was being staged. Select the folder again."
                    .to_string(),
            );
        }
        Ok::<(), String>(())
    })();
    if let Err(error) = copy_result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    if let Err(error) = validate_plugin_storage(&root, &source_manifest.id) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    if let Err(error) = mark_plugin_staging_active(&transaction_id) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    Ok(Some(PluginInstallPlan {
        transaction_id,
        manifest: source_manifest,
        installed_manifest,
    }))
}

#[tauri::command]
pub async fn commit_plugin_install(
    app: AppHandle,
    window: tauri::WebviewWindow,
    quit_gate: State<'_, crate::QuitGateState>,
    state: State<'_, crate::lsp_manager::LspState>,
    transaction_id: String,
) -> Result<InstalledPluginResult, String> {
    let admission = quit_gate.admit_resource_operation(window.label())?;
    let lsp_manager = state.manager.clone();
    run_blocking("Unable to install plugin", BlockingClass::File, move || {
        let _admission = admission;
        let transaction_id = parse_transaction_id(&transaction_id)?;
        let _storage_lock = PLUGIN_STORAGE_LOCK
            .lock()
            .map_err(|_| "Plugin storage is unavailable.".to_string())?;
        let root = plugin_storage_root(&app)?;
        let staging = staging_path(&root, &transaction_id.to_string());
        let manifest = read_manifest(&staging)?;
        validate_plugin_manifest(&manifest)?;
        validate_plugin_tree(&staging)?;
        verify_entry(&staging, &safe_plugin_relative_path(&manifest.entry)?)?;
        crate::plugin_security::revoke_plugin_network_requests(&manifest.id, None)?;
        lsp_manager.stop_plugin(&manifest.id)?;
        let result = commit_staged_plugin(&root, transaction_id);
        if result.is_ok() {
            mark_plugin_staging_inactive(&transaction_id.to_string());
        }
        result
    })
    .await
}

fn commit_staged_plugin(
    root: &Path,
    transaction_id: Uuid,
) -> Result<InstalledPluginResult, String> {
    let staging = staging_path(&root, &transaction_id.to_string());
    let staged = fs::canonicalize(&staging)
        .map_err(|error| format!("Unable to access staged plugin. {error}"))?;
    let canonical_root = fs::canonicalize(&root)
        .map_err(|error| format!("Unable to access plugin storage. {error}"))?;
    if staged.parent() != Some(canonical_root.as_path()) || !staged.is_dir() {
        return Err("Staged plugin is outside plugin storage.".to_string());
    }

    let manifest = read_manifest(&staged)?;
    validate_plugin_manifest(&manifest)?;
    validate_plugin_tree(&staged)?;
    let entry = safe_plugin_relative_path(&manifest.entry)?;
    verify_entry(&staged, &entry)?;
    validate_plugin_storage(&root, &manifest.id)?;

    let destination = plugin_path(&root, &manifest.id);
    if !destination.exists() && has_removal_tombstone(root, &manifest.id)? {
        return Err(
            "Plugin cleanup is still pending for this id. Retry cleanup before installing it again."
                .to_string(),
        );
    }
    let backup = new_rollback_path(&root, &manifest.id);
    let had_previous_install = match fs::symlink_metadata(&destination) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("Installed plugin path is not a regular directory.".to_string());
            }
            let previous = read_manifest(&destination)?;
            validate_plugin_manifest(&previous)?;
            if previous.id != manifest.id {
                return Err("Installed plugin id does not match its storage directory.".to_string());
            }
            validate_plugin_tree(&destination)?;
            verify_entry(&destination, &safe_plugin_relative_path(&previous.entry)?)?;
            fs::rename(&destination, &backup).map_err(|error| {
                format!("Unable to preserve the installed plugin for rollback. {error}")
            })?;
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("Unable to inspect installed plugin. {error}")),
    };

    if let Err(error) = fs::rename(&staged, &destination) {
        let message = format!("Unable to finalize plugin installation. {error}");
        if had_previous_install {
            if let Err(rollback_error) = fs::rename(&backup, &destination) {
                return Err(format!(
                    "{message} The previous plugin could not be restored: {rollback_error}"
                ));
            }
        }
        return Err(message);
    }
    let cleanup_pending = prune_older_rollback_versions(&root, &manifest.id).is_err();

    Ok(InstalledPluginResult {
        path: destination.to_string_lossy().to_string(),
        manifest,
        cleanup_pending,
    })
}

#[tauri::command]
pub async fn cancel_plugin_install(
    app: AppHandle,
    window: tauri::WebviewWindow,
    quit_gate: State<'_, crate::QuitGateState>,
    transaction_id: String,
) -> Result<(), String> {
    let admission = quit_gate.admit_resource_operation(window.label())?;
    run_blocking(
        "Unable to cancel plugin installation",
        BlockingClass::File,
        move || {
            let _admission = admission;
            let transaction_id = parse_transaction_id(&transaction_id)?;
            let _storage_lock = PLUGIN_STORAGE_LOCK
                .lock()
                .map_err(|_| "Plugin storage is unavailable.".to_string())?;
            let root = plugin_storage_root(&app)?;
            let transaction_id = transaction_id.to_string();
            let result = remove_tree_if_present(&staging_path(&root, &transaction_id));
            mark_plugin_staging_inactive(&transaction_id);
            result
        },
    )
    .await
}

#[tauri::command]
pub async fn rollback_plugin_update(
    app: AppHandle,
    window: tauri::WebviewWindow,
    quit_gate: State<'_, crate::QuitGateState>,
    state: State<'_, crate::lsp_manager::LspState>,
    id: String,
) -> Result<InstalledPluginResult, String> {
    let admission = quit_gate.admit_resource_operation(window.label())?;
    let lsp_manager = state.manager.clone();
    run_blocking(
        "Unable to roll back plugin update",
        BlockingClass::File,
        move || {
            let _admission = admission;
            validate_plugin_id(&id)?;
            let _storage_lock = PLUGIN_STORAGE_LOCK
                .lock()
                .map_err(|_| "Plugin storage is unavailable.".to_string())?;
            let root = plugin_storage_root(&app)?;
            let backup = latest_rollback_path(&root, &id)?
                .ok_or_else(|| format!("No previous version of plugin {id} is available."))?;
            let manifest = read_manifest(&backup)?;
            validate_plugin_manifest(&manifest)?;
            if manifest.id != id {
                return Err("Previous plugin id does not match its storage directory.".to_string());
            }
            validate_plugin_tree(&backup)?;
            verify_entry(&backup, &safe_plugin_relative_path(&manifest.entry)?)?;
            crate::plugin_security::revoke_plugin_network_requests(&id, None)?;
            lsp_manager.stop_plugin(&id)?;
            rollback_plugin_data(&root, &id)
        },
    )
    .await
}

fn rollback_plugin_data(root: &Path, id: &str) -> Result<InstalledPluginResult, String> {
    validate_plugin_id(id)?;
    let destination = plugin_path(root, id);
    let backup = latest_rollback_path(root, id)?
        .ok_or_else(|| format!("No previous version of plugin {id} is available."))?;
    let backup_metadata = fs::symlink_metadata(&backup)
        .map_err(|error| format!("Unable to inspect previous plugin version. {error}"))?;
    if backup_metadata.file_type().is_symlink() || !backup_metadata.is_dir() {
        return Err("Previous plugin version is not a regular directory.".to_string());
    }
    let previous_manifest = read_manifest(&backup)?;
    validate_plugin_manifest(&previous_manifest)?;
    if previous_manifest.id != id {
        return Err("Previous plugin id does not match its storage directory.".to_string());
    }
    validate_plugin_tree(&backup)?;
    verify_entry(
        &backup,
        &safe_plugin_relative_path(&previous_manifest.entry)?,
    )?;
    let current = match fs::symlink_metadata(&destination) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("Installed plugin path is not a regular directory.".to_string());
        }
        Ok(_) => Some(new_rollback_path(root, id)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Unable to inspect installed plugin. {error}")),
    };
    if let Some(current) = current.as_ref() {
        fs::rename(&destination, current)
            .map_err(|error| format!("Unable to preserve the current plugin version. {error}"))?;
    }
    if let Err(error) = fs::rename(&backup, &destination) {
        if let Some(current) = current.as_ref() {
            return match fs::rename(current, &destination) {
                Ok(()) => Err(format!(
                    "Unable to restore the previous plugin version. {error}"
                )),
                Err(restore_error) => Err(format!(
                    "Unable to restore the previous plugin version. {error} The current version could not be restored: {restore_error}"
                )),
            };
        }
        return Err(format!(
            "Unable to restore the previous plugin version. {error}"
        ));
    }
    Ok(InstalledPluginResult {
        path: destination.to_string_lossy().to_string(),
        manifest: previous_manifest,
        cleanup_pending: false,
    })
}

#[tauri::command]
pub async fn uninstall_plugin(
    app: AppHandle,
    window: tauri::WebviewWindow,
    quit_gate: State<'_, crate::QuitGateState>,
    state: State<'_, crate::lsp_manager::LspState>,
    id: String,
) -> Result<PluginUninstallResult, String> {
    let admission = quit_gate.admit_resource_operation(window.label())?;
    let lsp_manager = state.manager.clone();
    run_blocking(
        "Unable to uninstall plugin",
        BlockingClass::File,
        move || {
            let _admission = admission;
            validate_plugin_id(&id)?;
            let _storage_lock = PLUGIN_STORAGE_LOCK
                .lock()
                .map_err(|_| "Plugin storage is unavailable.".to_string())?;
            let root = plugin_storage_root(&app)?;
            fs::create_dir_all(&root)
                .map_err(|error| format!("Unable to access plugin storage. {error}"))?;
            validate_plugin_storage_root(&root)?;
            crate::plugin_security::revoke_plugin_network_requests(&id, None)?;
            lsp_manager.stop_plugin(&id)?;
            uninstall_plugin_data(&root, &id)
        },
    )
    .await
}

fn uninstall_plugin_data(root: &Path, id: &str) -> Result<PluginUninstallResult, String> {
    uninstall_plugin_data_with(root, id, remove_tree_if_present)
}

fn uninstall_plugin_data_with(
    root: &Path,
    id: &str,
    mut remove: impl FnMut(&Path) -> Result<(), String>,
) -> Result<PluginUninstallResult, String> {
    validate_plugin_id(id)?;
    let destination = plugin_path(root, id);
    match fs::symlink_metadata(&destination) {
        Ok(_) => {
            let removal = removal_path(root, id, &Uuid::new_v4().to_string());
            fs::rename(&destination, &removal).map_err(|error| {
                format!("Unable to remove plugin from the installed list. {error}")
            })?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Unable to inspect installed plugin. {error}")),
    }

    let paths = plugin_cleanup_paths(root, id)?;
    let cleanup_pending = remove_uninstalled_plugin_data(&paths, &mut remove);

    Ok(PluginUninstallResult {
        removed: true,
        cleanup_pending,
    })
}

fn remove_uninstalled_plugin_data(
    paths: &[PathBuf],
    remove: &mut impl FnMut(&Path) -> Result<(), String>,
) -> bool {
    let removal_prefix = ".pude-plugin-removal-";
    let mut cleanup_pending = false;
    for path in paths.iter().filter(|path| {
        !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(removal_prefix))
    }) {
        if remove(path).is_err() {
            cleanup_pending = true;
        }
    }
    if cleanup_pending {
        return true;
    }
    for path in paths.iter().filter(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(removal_prefix))
    }) {
        if remove(path).is_err() {
            cleanup_pending = true;
        }
    }
    cleanup_pending
}

#[tauri::command]
pub async fn retry_plugin_cleanup(
    app: AppHandle,
    window: tauri::WebviewWindow,
    quit_gate: State<'_, crate::QuitGateState>,
    id: String,
) -> Result<bool, String> {
    let admission = quit_gate.admit_resource_operation(window.label())?;
    run_blocking(
        "Unable to retry plugin cleanup",
        BlockingClass::File,
        move || {
            let _admission = admission;
            let _storage_lock = PLUGIN_STORAGE_LOCK
                .lock()
                .map_err(|_| "Plugin storage is unavailable.".to_string())?;
            let root = plugin_storage_root(&app)?;
            if id == STAGING_CLEANUP_ID {
                return cleanup_abandoned_plugin_staging(&root);
            }
            validate_plugin_id(&id)?;
            retry_plugin_cleanup_data(&root, &id)
        },
    )
    .await
}

fn retry_plugin_cleanup_data(root: &Path, id: &str) -> Result<bool, String> {
    if id == STAGING_CLEANUP_ID {
        return cleanup_abandoned_plugin_staging(root);
    }
    validate_plugin_id(id)?;
    let destination = plugin_path(root, id);
    let installed = match fs::symlink_metadata(&destination) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("Unable to inspect installed plugin. {error}")),
    };
    let pending_uninstall = plugin_cleanup_paths(root, id)?.iter().any(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(&format!(".pude-plugin-removal-{id}-")))
    });

    if installed {
        prune_older_rollback_versions(root, id)?;
    } else if pending_uninstall {
        let paths = plugin_cleanup_paths(root, id)?;
        if remove_uninstalled_plugin_data(&paths, &mut remove_tree_if_present) {
            return Ok(true);
        }
    }
    let paths = plugin_cleanup_paths(root, id)?;
    let latest = if installed {
        latest_rollback_path(root, id)?
    } else {
        None
    };
    Ok(paths.iter().any(|path| {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        name.starts_with(&format!(".pude-plugin-removal-{id}-"))
            || (installed
                && name.starts_with(&format!(".pude-plugin-rollback-{id}-"))
                && Some(path) != latest.as_ref())
            || (!installed && pending_uninstall)
    }))
}

#[tauri::command]
pub async fn read_plugin_entry(
    app: AppHandle,
    window: tauri::WebviewWindow,
    quit_gate: State<'_, crate::QuitGateState>,
    root_path: String,
    entry: String,
) -> Result<String, String> {
    let admission = quit_gate.admit_resource_operation(window.label())?;
    run_blocking(
        "Unable to read plugin entry",
        BlockingClass::File,
        move || {
            let _admission = admission;
            read_plugin_entry_sync(app, root_path, entry)
        },
    )
    .await
}

fn read_plugin_entry_sync(
    app: AppHandle,
    root_path: String,
    entry: String,
) -> Result<String, String> {
    let storage = fs::canonicalize(plugin_storage_root(&app)?)
        .map_err(|error| format!("Unable to access plugin storage. {error}"))?;
    let root = fs::canonicalize(root_path)
        .map_err(|error| format!("Unable to access installed plugin. {error}"))?;
    if root.parent() != Some(storage.as_path()) {
        return Err("Plugin entry is outside the application plugin directory.".to_string());
    }
    let manifest = read_manifest(&root)?;
    validate_plugin_manifest(&manifest)?;
    if root.file_name().and_then(|name| name.to_str()) != Some(manifest.id.as_str()) {
        return Err("Installed plugin id does not match its storage directory.".to_string());
    }
    let relative = safe_plugin_relative_path(&entry)?;
    let file = fs::canonicalize(root.join(relative))
        .map_err(|error| format!("Unable to access plugin entry. {error}"))?;
    if !file.starts_with(&root) || !file.is_file() {
        return Err("Plugin entry must be a file inside the installed plugin.".to_string());
    }
    fs::read_to_string(file).map_err(|error| format!("Unable to read plugin entry. {error}"))
}

fn plugin_storage_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to locate application data. {error}"))?
        .join("plugins");
    match fs::symlink_metadata(&root) {
        Ok(_) => validate_plugin_storage_root(&root)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Unable to inspect plugin storage. {error}")),
    }
    Ok(root)
}

fn validate_plugin_storage_root(root: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("Unable to inspect plugin storage. {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Plugin storage must be a regular application directory.".to_string());
    }
    let canonical_root = fs::canonicalize(root)
        .map_err(|error| format!("Unable to access plugin storage. {error}"))?;
    let canonical_parent = root
        .parent()
        .ok_or_else(|| "Plugin storage has no application data parent.".to_string())?;
    let canonical_parent = fs::canonicalize(canonical_parent)
        .map_err(|error| format!("Unable to locate application data. {error}"))?;
    if canonical_root.parent() != Some(canonical_parent.as_path()) {
        return Err("Plugin storage is outside application data.".to_string());
    }
    Ok(())
}

fn plugin_path(root: &Path, id: &str) -> PathBuf {
    root.join(id)
}

fn staging_path(root: &Path, transaction_id: &str) -> PathBuf {
    root.join(format!("{STAGING_PREFIX}{transaction_id}"))
}

fn mark_plugin_staging_active(transaction_id: &str) -> Result<(), String> {
    let parsed = parse_transaction_id(transaction_id)?;
    if parsed.to_string() != transaction_id {
        return Err("Invalid plugin installation transaction.".to_string());
    }
    let mut active = ACTIVE_PLUGIN_STAGING
        .lock()
        .map_err(|_| "Plugin installation state is unavailable.".to_string())?;
    if !active.iter().any(|current| current == transaction_id) {
        active.push(transaction_id.to_string());
    }
    Ok(())
}

fn mark_plugin_staging_inactive(transaction_id: &str) {
    if let Ok(mut active) = ACTIVE_PLUGIN_STAGING.lock() {
        active.retain(|current| current != transaction_id);
    }
}

fn active_plugin_staging() -> Result<HashSet<String>, String> {
    ACTIVE_PLUGIN_STAGING
        .lock()
        .map(|active| active.iter().cloned().collect())
        .map_err(|_| "Plugin installation state is unavailable.".to_string())
}

fn transaction_id_from_staging_name(name: &str) -> Option<String> {
    let suffix = name.strip_prefix(STAGING_PREFIX)?;
    let transaction_id = parse_transaction_id(suffix).ok()?;
    (transaction_id.to_string() == suffix).then(|| suffix.to_string())
}

fn cleanup_abandoned_plugin_staging(root: &Path) -> Result<bool, String> {
    let active = active_plugin_staging()?;
    let mut candidates = Vec::new();
    for item in
        fs::read_dir(root).map_err(|error| format!("Unable to read plugin storage. {error}"))?
    {
        let item = item.map_err(|error| format!("Unable to read plugin storage entry. {error}"))?;
        let name = item.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(transaction_id) = transaction_id_from_staging_name(name) else {
            continue;
        };
        if !active.contains(&transaction_id) {
            candidates.push(transaction_id);
        }
    }
    candidates.sort();

    let mut cursor = STAGING_CLEANUP_CURSOR
        .lock()
        .map_err(|_| "Plugin cleanup state is unavailable.".to_string())?;
    if candidates.is_empty() {
        *cursor = None;
        return Ok(false);
    }
    let start = cursor
        .as_ref()
        .map(|last| candidates.partition_point(|candidate| candidate <= last))
        .unwrap_or(0);
    let start = if start == candidates.len() { 0 } else { start };
    let end = (start + MAX_STAGING_CLEANUP_BATCH).min(candidates.len());
    let batch = candidates[start..end].to_vec();
    let more_candidates = candidates.len() > batch.len();
    *cursor = batch.last().cloned();
    drop(cursor);

    let mut cleanup_pending = more_candidates;
    let mut cleaned_bytes = 0_u64;
    for transaction_id in batch {
        let path = staging_path(root, &transaction_id);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("Unable to inspect staged plugin. {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            cleanup_pending = true;
            continue;
        }
        let remaining_bytes = MAX_PLUGIN_TOTAL_BYTES.saturating_sub(cleaned_bytes);
        let tree_bytes = match validate_plugin_tree_with_limit(&path, remaining_bytes) {
            Ok(bytes) => bytes,
            Err(_) => {
                cleanup_pending = true;
                continue;
            }
        };
        cleaned_bytes = cleaned_bytes.saturating_add(tree_bytes);
        if remove_tree_if_present(&path).is_err() {
            cleanup_pending = true;
        }
    }
    Ok(cleanup_pending)
}

fn rollback_path(root: &Path, id: &str, suffix: &str) -> PathBuf {
    root.join(format!(".pude-plugin-rollback-{id}-{suffix}"))
}

fn new_rollback_path(root: &Path, id: &str) -> PathBuf {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    rollback_path(root, id, &format!("{timestamp}-{}", Uuid::new_v4()))
}

fn removal_path(root: &Path, id: &str, suffix: &str) -> PathBuf {
    root.join(format!(".pude-plugin-removal-{id}-{suffix}"))
}

fn parse_transaction_id(value: &str) -> Result<Uuid, String> {
    Uuid::parse_str(value).map_err(|_| "Invalid plugin installation transaction.".to_string())
}

fn read_manifest(root: &Path) -> Result<PluginManifest, String> {
    let manifest_path = root.join("plugin.json");
    let metadata = fs::symlink_metadata(&manifest_path)
        .map_err(|error| format!("Unable to inspect plugin.json. {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("plugin.json must be a regular file.".to_string());
    }
    if metadata.len() > MAX_PLUGIN_MANIFEST_BYTES as u64 {
        return Err(format!(
            "plugin.json exceeds the {} KiB manifest limit.",
            MAX_PLUGIN_MANIFEST_BYTES / 1024
        ));
    }
    let bytes =
        fs::read(&manifest_path).map_err(|error| format!("Unable to read plugin.json. {error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("Invalid plugin manifest. {error}"))
}

fn read_installed_manifest(root: &Path, id: &str) -> Result<Option<PluginManifest>, String> {
    let destination = plugin_path(root, id);
    match fs::symlink_metadata(&destination) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("Installed plugin path is not a regular directory.".to_string());
            }
            let manifest = read_manifest(&destination)?;
            validate_plugin_manifest(&manifest)?;
            if manifest.id != id {
                return Err("Installed plugin id does not match its storage directory.".to_string());
            }
            Ok(Some(manifest))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Unable to inspect installed plugin. {error}")),
    }
}

fn copy_plugin_tree(
    source: &Path,
    destination: &Path,
    relative: &Path,
    budget: &mut PluginTreeBudget,
) -> Result<(), String> {
    let source_metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("Unable to inspect plugin file. {error}"))?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_dir() {
        return Err("The selected plugin path must be a regular directory.".to_string());
    }
    if !relative.as_os_str().is_empty() {
        budget.check_directory(relative)?;
    }
    fs::create_dir_all(destination)
        .map_err(|error| format!("Unable to create plugin staging directory. {error}"))?;
    for item in
        fs::read_dir(source).map_err(|error| format!("Unable to read plugin directory. {error}"))?
    {
        let item = item.map_err(|error| format!("Unable to read plugin file. {error}"))?;
        let source_path = item.path();
        let item_relative = relative.join(item.file_name());
        let destination_path = destination.join(item.file_name());
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(|error| format!("Unable to inspect plugin file. {error}"))?;
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            return Err("Plugin packages cannot contain symbolic links.".to_string());
        }
        if metadata.is_dir() {
            copy_plugin_tree(&source_path, &destination_path, &item_relative, budget)?;
        } else if metadata.is_file() {
            budget.check_file(&item_relative, metadata.len())?;
            fs::copy(&source_path, &destination_path)
                .map_err(|error| format!("Unable to copy plugin file. {error}"))?;
        } else {
            return Err(
                "Plugin packages can contain only regular files and directories.".to_string(),
            );
        }
    }
    Ok(())
}

fn validate_plugin_tree(root: &Path) -> Result<(), String> {
    validate_plugin_tree_with_limit(root, u64::MAX).map(|_| ())
}

fn validate_plugin_tree_with_limit(root: &Path, max_bytes: u64) -> Result<u64, String> {
    fn visit(
        path: &Path,
        relative: &Path,
        budget: &mut PluginTreeBudget,
        total_bytes: &mut u64,
        max_bytes: u64,
    ) -> Result<(), String> {
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| format!("Unable to inspect staged plugin. {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("Plugin packages cannot contain symbolic links.".to_string());
        }
        if metadata.is_dir() {
            if !relative.as_os_str().is_empty() {
                budget.check_directory(relative)?;
            }
            for item in fs::read_dir(path)
                .map_err(|error| format!("Unable to read staged plugin. {error}"))?
            {
                let item =
                    item.map_err(|error| format!("Unable to read staged plugin entry. {error}"))?;
                visit(
                    &item.path(),
                    &relative.join(item.file_name()),
                    budget,
                    total_bytes,
                    max_bytes,
                )?;
            }
        } else if metadata.is_file() {
            budget.check_file(relative, metadata.len())?;
            *total_bytes = total_bytes
                .checked_add(metadata.len())
                .ok_or_else(|| "Staged plugin size overflowed.".to_string())?;
            if *total_bytes > max_bytes {
                return Err("Staged plugin cleanup exceeded its byte budget.".to_string());
            }
        } else {
            return Err(
                "Plugin packages can contain only regular files and directories.".to_string(),
            );
        }
        Ok(())
    }

    let mut total_bytes = 0_u64;
    visit(
        root,
        Path::new(""),
        &mut PluginTreeBudget::new(),
        &mut total_bytes,
        max_bytes,
    )?;
    Ok(total_bytes)
}

fn verify_entry(root: &Path, entry: &Path) -> Result<(), String> {
    let entry_path = root.join(entry);
    let metadata = fs::symlink_metadata(&entry_path)
        .map_err(|error| format!("Unable to verify plugin entry. {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(
            "Plugin entry must be a regular file inside the selected plugin folder.".to_string(),
        );
    }
    let canonical_root = fs::canonicalize(root)
        .map_err(|error| format!("Unable to access plugin folder. {error}"))?;
    let canonical_entry = fs::canonicalize(entry_path)
        .map_err(|error| format!("Unable to access plugin entry. {error}"))?;
    if !canonical_entry.starts_with(canonical_root) {
        return Err("Plugin entry must be inside the selected plugin folder.".to_string());
    }
    Ok(())
}

fn safe_plugin_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(
            "Plugin paths must be relative and cannot contain parent-directory segments."
                .to_string(),
        );
    }
    Ok(path.to_path_buf())
}

pub fn validate_plugin_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id.as_bytes()[0].is_ascii_alphanumeric()
        || !id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
    {
        return Err("Plugin id contains unsupported path characters.".to_string());
    }
    Ok(())
}

pub fn validate_plugin_manifest(manifest: &PluginManifest) -> Result<(), String> {
    if manifest.name.trim().is_empty()
        || manifest.version.trim().is_empty()
        || manifest.entry.trim().is_empty()
    {
        return Err("Plugin manifest is missing a required field.".to_string());
    }
    validate_plugin_id(&manifest.id)?;
    safe_plugin_relative_path(&manifest.entry)?;
    if !matches!(manifest.api_version.as_str(), "1" | "2") {
        return Err("Unsupported plugin API version.".to_string());
    }
    let allowed_v1 = [
        "editor.read",
        "commands.register",
        "ui.notification",
        "ui.statusBar",
    ];
    let allowed_v2 = [
        "editor.read",
        "editor.write",
        "workspace.read",
        "workspace.write",
        "commands.register",
        "ui.notification",
        "ui.statusBar",
        "ui.quickPick",
        "git.read",
        "terminal.write",
        "network",
        "process.spawn:lsp",
    ];
    let allowed = if manifest.api_version == "1" {
        &allowed_v1[..]
    } else {
        &allowed_v2[..]
    };
    if let Some(permission) = manifest
        .permissions
        .iter()
        .find(|permission| !allowed.contains(&permission.as_str()))
    {
        return Err(format!("Unsupported plugin permission: {permission}"));
    }
    if manifest.api_version == "1"
        && (!manifest.network_domains.is_empty() || !manifest.lsp_servers.is_empty())
    {
        return Err("API 1 plugins cannot request API 2 network or LSP declarations.".to_string());
    }
    crate::plugin_security::validate_network_domains(&manifest.network_domains)?;
    let lsp_declarations = manifest
        .lsp_servers
        .iter()
        .map(|server| crate::lsp_manager::LspServerDeclaration {
            server_id: server.server_id.clone(),
            language: server.language.clone(),
            executable: server.executable.clone(),
            args: server.args.clone(),
        })
        .collect::<Vec<_>>();
    crate::lsp_manager::validate_server_declarations(&lsp_declarations)?;

    if manifest.activation_events.is_empty()
        || manifest
            .activation_events
            .iter()
            .any(|event| !valid_activation_event(event))
    {
        return Err("Plugin manifest contains an unsupported activation event.".to_string());
    }
    if let Some(commands) = manifest
        .contributes
        .as_ref()
        .and_then(|contributes| contributes.commands.as_ref())
    {
        let mut command_ids = std::collections::HashSet::new();
        for command in commands {
            if !valid_manifest_id(&command.command)
                || command.title.trim().is_empty()
                || command.title.chars().count() > 128
                || !command_ids.insert(command.command.as_str())
            {
                return Err("Plugin commands must have unique ids and non-empty titles of at most 128 characters.".to_string());
            }
            if !manifest
                .activation_events
                .iter()
                .any(|event| event == &format!("onCommand:{}", command.command))
            {
                return Err(format!(
                    "Command {} must have a matching onCommand activation event.",
                    command.command
                ));
            }
        }
    }
    Ok(())
}

fn valid_activation_event(event: &str) -> bool {
    if let Some(id) = event.strip_prefix("onCommand:") {
        return valid_manifest_id(id);
    }
    if let Some(language) = event.strip_prefix("onLanguage:") {
        return valid_manifest_id(language);
    }
    matches!(event, "onFileOpen" | "onFileSave" | "onWorkspaceOpen")
}

fn valid_manifest_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value.bytes().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, b'.' | b'_' | b'-')
        })
}

fn plugin_cleanup_paths(root: &Path, id: &str) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    for item in
        fs::read_dir(root).map_err(|error| format!("Unable to read plugin storage. {error}"))?
    {
        let path = item
            .map_err(|error| format!("Unable to read plugin storage entry. {error}"))?
            .path();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if name.starts_with(&format!(".pude-plugin-rollback-{id}-"))
            || name.starts_with(&format!(".pude-plugin-removal-{id}-"))
        {
            paths.push(path);
        }
    }
    Ok(paths)
}

fn startup_recovery_ids(root: &Path, mut ids: Vec<String>) -> Result<Vec<String>, String> {
    for item in
        fs::read_dir(root).map_err(|error| format!("Unable to read plugin storage. {error}"))?
    {
        let item = item.map_err(|error| format!("Unable to read plugin storage entry. {error}"))?;
        let name = item.file_name();
        let name = name.to_string_lossy();
        let metadata = fs::symlink_metadata(item.path())
            .map_err(|error| format!("Unable to inspect plugin storage entry. {error}"))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        let id = if !name.starts_with('.') {
            validate_plugin_id(&name).ok().and_then(|()| {
                read_installed_manifest(root, &name)
                    .ok()
                    .flatten()
                    .map(|_| name.to_string())
            })
        } else {
            plugin_id_from_rollback_name(&name).or_else(|| plugin_id_from_removal_name(&name))
        };
        if let Some(id) = id {
            ids.push(id);
        }
    }
    Ok(ids)
}

fn plugin_id_from_rollback_name(name: &str) -> Option<String> {
    let suffix = name.strip_prefix(".pude-plugin-rollback-")?;
    let uuid_offset = suffix.len().checked_sub(36)?;
    let (versioned_id, uuid) = suffix.split_at(uuid_offset);
    let versioned_id = versioned_id.strip_suffix('-')?;
    let _ = Uuid::parse_str(uuid).ok()?;
    let (id, timestamp) = versioned_id.rsplit_once('-')?;
    if timestamp.is_empty() || !timestamp.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    validate_plugin_id(id).ok()?;
    Some(id.to_string())
}

fn plugin_id_from_removal_name(name: &str) -> Option<String> {
    let suffix = name.strip_prefix(".pude-plugin-removal-")?;
    let uuid_offset = suffix.len().checked_sub(36)?;
    let (id, uuid) = suffix.split_at(uuid_offset);
    let id = id.strip_suffix('-')?;
    let _ = Uuid::parse_str(uuid).ok()?;
    validate_plugin_id(id).ok()?;
    Some(id.to_string())
}

fn has_removal_tombstone(root: &Path, id: &str) -> Result<bool, String> {
    Ok(plugin_cleanup_paths(root, id)?.iter().any(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(&format!(".pude-plugin-removal-{id}-")))
    }))
}

fn latest_rollback_path(root: &Path, id: &str) -> Result<Option<PathBuf>, String> {
    let prefix = format!(".pude-plugin-rollback-{id}-");
    let mut candidates = Vec::new();
    for item in
        fs::read_dir(root).map_err(|error| format!("Unable to read plugin storage. {error}"))?
    {
        let path = item
            .map_err(|error| format!("Unable to read plugin storage entry. {error}"))?
            .path();
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(&prefix))
        {
            candidates.push(path);
        }
    }
    candidates.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    Ok(candidates.into_iter().next())
}

fn prune_older_rollback_versions(root: &Path, id: &str) -> Result<(), String> {
    let newest = latest_rollback_path(root, id)?;
    for path in plugin_cleanup_paths(root, id)? {
        if path == newest.as_deref().unwrap_or(Path::new("")) {
            continue;
        }
        remove_tree_if_present(&path)?;
    }
    Ok(())
}

fn validate_plugin_storage(root: &Path, candidate_id: &str) -> Result<(), String> {
    let mut bytes = 0_u64;
    let mut installed_ids = std::collections::HashSet::new();
    fn visit(path: &Path, bytes: &mut u64) -> Result<(), String> {
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| format!("Unable to inspect plugin storage. {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("Plugin storage cannot contain symbolic links.".to_string());
        }
        if metadata.is_dir() {
            for item in fs::read_dir(path)
                .map_err(|error| format!("Unable to read plugin storage. {error}"))?
            {
                let item =
                    item.map_err(|error| format!("Unable to read plugin storage entry. {error}"))?;
                visit(&item.path(), bytes)?;
            }
        } else if metadata.is_file() {
            *bytes = bytes
                .checked_add(metadata.len())
                .ok_or_else(|| "Plugin storage size overflowed.".to_string())?;
            if *bytes > MAX_PLUGIN_STORAGE_BYTES {
                return Err(
                    "Installed plugins and rollback data exceed the 100 MiB storage limit."
                        .to_string(),
                );
            }
        } else {
            return Err(
                "Plugin storage can contain only regular files and directories.".to_string(),
            );
        }
        Ok(())
    }

    for item in
        fs::read_dir(root).map_err(|error| format!("Unable to read plugin storage. {error}"))?
    {
        let item = item.map_err(|error| format!("Unable to read plugin storage entry. {error}"))?;
        let path = item.path();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("Unable to inspect plugin storage entry. {error}"))?;
        if !name.starts_with('.') && metadata.is_dir() && validate_plugin_id(name).is_ok() {
            installed_ids.insert(name.to_string());
        }
        visit(&path, &mut bytes)?;
    }
    if !installed_ids.contains(candidate_id) && installed_ids.len() >= MAX_INSTALLED_PLUGIN_COUNT {
        return Err("The maximum of 100 installed plugins has been reached.".to_string());
    }
    Ok(())
}

fn recover_interrupted_updates(root: &Path, id: &str) -> Result<(), String> {
    if has_removal_tombstone(root, id)? {
        return Ok(());
    }
    let destination = plugin_path(root, id);
    if fs::symlink_metadata(&destination).is_ok() {
        return Ok(());
    }
    if let Some(backup) = latest_rollback_path(root, id)? {
        let metadata = fs::symlink_metadata(&backup)
            .map_err(|error| format!("Unable to inspect previous plugin version. {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("Previous plugin version is not a regular directory.".to_string());
        }
        let manifest = read_manifest(&backup)?;
        validate_plugin_manifest(&manifest)?;
        if manifest.id != id {
            return Err("Previous plugin id does not match its storage directory.".to_string());
        }
        validate_plugin_tree(&backup)?;
        verify_entry(&backup, &safe_plugin_relative_path(&manifest.entry)?)?;
        fs::rename(&backup, &destination)
            .map_err(|error| format!("Unable to recover the previous plugin version. {error}"))?;
    }
    Ok(())
}

fn remove_tree_if_present(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            fs::remove_dir_all(path)
                .map_err(|error| format!("Unable to remove plugin data. {error}"))
        }
        Ok(_) => {
            fs::remove_file(path).map_err(|error| format!("Unable to remove plugin data. {error}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Unable to inspect plugin data. {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        cleanup_abandoned_plugin_staging, commit_staged_plugin, copy_plugin_tree,
        mark_plugin_staging_active, mark_plugin_staging_inactive, new_rollback_path,
        plugin_cleanup_paths, plugin_path, read_installed_manifest, read_manifest,
        recover_interrupted_updates, removal_path, retry_plugin_cleanup_data, rollback_path,
        rollback_plugin_data, staging_path, startup_recovery_ids, uninstall_plugin_data_with,
        validate_plugin_manifest, validate_plugin_storage, validate_plugin_storage_root,
        validate_plugin_tree, PluginContributions, PluginManifest, ACTIVE_PLUGIN_STAGING,
        MAX_PLUGIN_STORAGE_BYTES, MAX_STAGING_CLEANUP_BATCH, STAGING_CLEANUP_CURSOR,
        STAGING_CLEANUP_ID,
    };
    use crate::plugin_security::PluginTreeBudget;
    use std::collections::BTreeMap;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    use std::path::{Path, PathBuf};
    use std::sync::MutexGuard;
    use uuid::Uuid;

    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn manifest(version: &str) -> PluginManifest {
        PluginManifest {
            id: "pude.example".to_string(),
            name: "Example plugin".to_string(),
            version: version.to_string(),
            api_version: "2".to_string(),
            entry: "dist/extension.js".to_string(),
            permissions: vec!["editor.read".to_string()],
            activation_events: vec!["onCommand:pude.example.run".to_string()],
            contributes: Some(PluginContributions {
                commands: Some(vec![super::PluginCommandContribution {
                    command: "pude.example.run".to_string(),
                    title: "Format document".to_string(),
                }]),
                other: BTreeMap::new(),
            }),
            lsp_servers: Vec::new(),
            network_domains: Vec::new(),
            other: BTreeMap::new(),
        }
    }

    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!("pude-plugin-installer-test-{}", Uuid::new_v4()))
    }

    fn write_plugin(root: &Path, version: &str, source: &str) {
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::write(
            root.join("plugin.json"),
            serde_json::to_vec(&manifest(version)).unwrap(),
        )
        .unwrap();
        fs::write(root.join("dist/extension.js"), source).unwrap();
    }

    fn stage(root: &Path, source: &Path, transaction_id: &str) {
        let staging = staging_path(root, transaction_id);
        copy_plugin_tree(
            source,
            &staging,
            Path::new(""),
            &mut PluginTreeBudget::new(),
        )
        .unwrap();
        validate_plugin_tree(&staging).unwrap();
    }

    fn install(root: &Path, source: &Path, transaction_id: &str) -> super::InstalledPluginResult {
        if !staging_path(root, transaction_id).exists() {
            stage(root, source, transaction_id);
        }
        commit_staged_plugin(root, Uuid::parse_str(transaction_id).unwrap()).unwrap()
    }

    fn test_guard() -> MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap()
    }

    fn reset_staging_state() {
        ACTIVE_PLUGIN_STAGING.lock().unwrap().clear();
        *STAGING_CLEANUP_CURSOR.lock().unwrap() = None;
    }

    fn staging_count(root: &Path) -> usize {
        fs::read_dir(root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|item| {
                item.file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with(".pude-plugin-staging-"))
            })
            .count()
    }

    #[test]
    fn plugin_storage_root_rejects_symlink_and_non_directory_paths() {
        let _guard = test_guard();
        let parent = test_root();
        fs::create_dir_all(&parent).unwrap();
        let root = parent.join("plugins");

        #[cfg(unix)]
        {
            let outside = parent.join("outside");
            fs::create_dir(&outside).unwrap();
            symlink(&outside, &root).unwrap();
            assert!(validate_plugin_storage_root(&root).is_err());
            fs::remove_file(&root).unwrap();
        }

        fs::write(&root, "not a directory").unwrap();
        assert!(validate_plugin_storage_root(&root).is_err());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn document_case_sample_manifest_passes_native_validation() {
        let manifest: PluginManifest = serde_json::from_str(include_str!(
            "../../../../examples/plugins/document-case-toggle/plugin.json"
        ))
        .unwrap();
        validate_plugin_manifest(&manifest).unwrap();
    }

    #[test]
    fn stages_and_atomically_replaces_same_id_while_preserving_previous_version() {
        let _guard = test_guard();
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let source_v1 = root.join("source-v1");
        write_plugin(&source_v1, "1.0.0", "v1");
        let transaction_v1 = Uuid::new_v4().to_string();
        let initial = install(&root, &source_v1, &transaction_v1);
        assert_eq!(initial.manifest.version, "1.0.0");

        let source_v2 = root.join("source-v2");
        write_plugin(&source_v2, "2.0.0", "v2");
        let transaction_v2 = Uuid::new_v4().to_string();
        let updated = install(&root, &source_v2, &transaction_v2);
        assert_eq!(updated.manifest.version, "2.0.0");

        let installed = read_installed_manifest(&root, "pude.example")
            .unwrap()
            .unwrap();
        assert_eq!(installed.version, "2.0.0");
        assert_eq!(
            fs::read_to_string(plugin_path(&root, "pude.example").join("dist/extension.js"))
                .unwrap(),
            "v2"
        );
        let backups = plugin_cleanup_paths(&root, "pude.example").unwrap();
        assert_eq!(backups.len(), 1);
        assert_eq!(read_manifest(&backups[0]).unwrap().version, "1.0.0");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn invalid_candidate_leaves_the_installed_version_untouched() {
        let _guard = test_guard();
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let source_v1 = root.join("source-v1");
        write_plugin(&source_v1, "1.0.0", "v1");
        let transaction_v1 = Uuid::new_v4().to_string();
        install(&root, &source_v1, &transaction_v1);

        let invalid = root.join("invalid");
        write_plugin(&invalid, "2.0.0", "candidate");
        let mut invalid_manifest = manifest("2.0.0");
        invalid_manifest.id = "../escape".to_string();
        fs::write(
            invalid.join("plugin.json"),
            serde_json::to_vec(&invalid_manifest).unwrap(),
        )
        .unwrap();
        let transaction_id = Uuid::new_v4().to_string();
        stage(&root, &invalid, &transaction_id);
        assert!(commit_staged_plugin(&root, Uuid::parse_str(&transaction_id).unwrap()).is_err());
        assert!(validate_plugin_manifest(&read_manifest(&invalid).unwrap()).is_err());
        assert_eq!(
            read_installed_manifest(&root, "pude.example")
                .unwrap()
                .unwrap()
                .version,
            "1.0.0"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rollback_restores_previous_version_and_keeps_the_replaced_version() {
        let _guard = test_guard();
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let source_v1 = root.join("source-v1");
        write_plugin(&source_v1, "1.0.0", "v1");
        let transaction_v1 = Uuid::new_v4().to_string();
        install(&root, &source_v1, &transaction_v1);
        let source_v2 = root.join("source-v2");
        write_plugin(&source_v2, "2.0.0", "v2");
        let transaction_v2 = Uuid::new_v4().to_string();
        install(&root, &source_v2, &transaction_v2);

        let rolled_back = rollback_plugin_data(&root, "pude.example").unwrap();
        assert_eq!(rolled_back.manifest.version, "1.0.0");
        assert_eq!(
            read_installed_manifest(&root, "pude.example")
                .unwrap()
                .unwrap()
                .version,
            "1.0.0"
        );
        let kept = plugin_cleanup_paths(&root, "pude.example").unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(read_manifest(&kept[0]).unwrap().version, "2.0.0");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_restores_previous_version_after_interrupted_replacement() {
        let _guard = test_guard();
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source");
        write_plugin(&source, "1.0.0", "v1");
        let transaction_id = Uuid::new_v4().to_string();
        install(&root, &source, &transaction_id);
        let candidate = root.join("candidate-v2");
        write_plugin(&candidate, "2.0.0", "v2");
        let candidate_transaction = Uuid::new_v4().to_string();
        stage(&root, &candidate, &candidate_transaction);

        fs::rename(
            plugin_path(&root, "pude.example"),
            new_rollback_path(&root, "pude.example"),
        )
        .unwrap();
        assert!(read_installed_manifest(&root, "pude.example")
            .unwrap()
            .is_none());
        recover_interrupted_updates(&root, "pude.example").unwrap();
        assert_eq!(
            read_installed_manifest(&root, "pude.example")
                .unwrap()
                .unwrap()
                .version,
            "1.0.0"
        );
        assert_eq!(
            read_manifest(&staging_path(&root, &candidate_transaction))
                .unwrap()
                .version,
            "2.0.0"
        );
        assert!(plugin_cleanup_paths(&root, "pude.example")
            .unwrap()
            .is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn interrupted_uninstall_marker_prevents_update_recovery() {
        let _guard = test_guard();
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source");
        write_plugin(&source, "1.0.0", "v1");
        let transaction_id = Uuid::new_v4().to_string();
        install(&root, &source, &transaction_id);
        fs::rename(
            plugin_path(&root, "pude.example"),
            new_rollback_path(&root, "pude.example"),
        )
        .unwrap();
        fs::create_dir(removal_path(&root, "pude.example", "pending")).unwrap();

        recover_interrupted_updates(&root, "pude.example").unwrap();
        assert!(read_installed_manifest(&root, "pude.example")
            .unwrap()
            .is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn startup_recovery_discovers_orphaned_backup_and_removal_ids() {
        let _guard = test_guard();
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        fs::create_dir(new_rollback_path(&root, "pude.example")).unwrap();
        fs::create_dir(removal_path(
            &root,
            "pude.removed",
            &Uuid::new_v4().to_string(),
        ))
        .unwrap();

        let ids = startup_recovery_ids(&root, Vec::new()).unwrap();
        assert!(ids.contains(&"pude.example".to_string()));
        assert!(ids.contains(&"pude.removed".to_string()));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn startup_cleanup_removes_abandoned_staging_and_preserves_live_plan() {
        let _guard = test_guard();
        reset_staging_state();
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source");
        write_plugin(&source, "1.0.0", "staged plugin");
        let install_transaction = Uuid::new_v4().to_string();
        install(&root, &source, &install_transaction);
        let candidate = root.join("candidate");
        write_plugin(&candidate, "2.0.0", "candidate version");

        let active_transaction = Uuid::new_v4().to_string();
        let abandoned_transaction = Uuid::new_v4().to_string();
        stage(&root, &candidate, &active_transaction);
        stage(&root, &candidate, &abandoned_transaction);
        let malformed = root.join(".pude-plugin-staging-not-a-uuid");
        fs::create_dir(&malformed).unwrap();
        mark_plugin_staging_active(&active_transaction).unwrap();

        assert!(!cleanup_abandoned_plugin_staging(&root).unwrap());
        assert!(staging_path(&root, &active_transaction).is_dir());
        assert!(!staging_path(&root, &abandoned_transaction).exists());
        assert!(malformed.is_dir());
        assert_eq!(
            read_installed_manifest(&root, "pude.example")
                .unwrap()
                .unwrap()
                .version,
            "1.0.0"
        );

        mark_plugin_staging_inactive(&active_transaction);
        assert!(!retry_plugin_cleanup_data(&root, STAGING_CLEANUP_ID).unwrap());
        assert!(!staging_path(&root, &active_transaction).exists());
        assert_eq!(staging_count(&root), 1); // Only the malformed name remains.
        reset_staging_state();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn staging_cleanup_processes_a_bounded_batch_and_retries_the_rest() {
        let _guard = test_guard();
        reset_staging_state();
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let transactions = (0..=MAX_STAGING_CLEANUP_BATCH)
            .map(|_| Uuid::new_v4().to_string())
            .collect::<Vec<_>>();
        for transaction in &transactions {
            write_plugin(&staging_path(&root, transaction), "1.0.0", "staged plugin");
        }

        assert!(cleanup_abandoned_plugin_staging(&root).unwrap());
        assert_eq!(staging_count(&root), 1);
        assert!(!cleanup_abandoned_plugin_staging(&root).unwrap());
        assert_eq!(staging_count(&root), 0);
        reset_staging_state();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn storage_limit_counts_installed_plugin_ids() {
        let _guard = test_guard();
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        for index in 0..100 {
            fs::create_dir(root.join(format!("pude.test{index}"))).unwrap();
        }

        assert!(validate_plugin_storage(&root, "pude.new").is_err());
        assert!(validate_plugin_storage(&root, "pude.test0").is_ok());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn storage_limit_counts_staging_and_rollback_file_bytes() {
        let _guard = test_guard();
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let oversized = root.join(".pude-plugin-staging-reserved");
        fs::File::create(&oversized)
            .unwrap()
            .set_len(MAX_PLUGIN_STORAGE_BYTES + 1)
            .unwrap();

        assert!(validate_plugin_storage(&root, "pude.new").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cleanup_retry_preserves_installed_plugin_and_latest_rollback() {
        let _guard = test_guard();
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let source_v1 = root.join("source-v1");
        write_plugin(&source_v1, "1.0.0", "v1");
        let transaction_v1 = Uuid::new_v4().to_string();
        install(&root, &source_v1, &transaction_v1);
        let source_v2 = root.join("source-v2");
        write_plugin(&source_v2, "2.0.0", "v2");
        let transaction_v2 = Uuid::new_v4().to_string();
        install(&root, &source_v2, &transaction_v2);

        let stale_backup = rollback_path(&root, "pude.example", "0-stale");
        write_plugin(&stale_backup, "0.9.0", "stale");
        assert!(retry_plugin_cleanup_data(&root, "pude.example").is_ok_and(|pending| !pending));
        assert_eq!(
            read_installed_manifest(&root, "pude.example")
                .unwrap()
                .unwrap()
                .version,
            "2.0.0"
        );
        let retained = plugin_cleanup_paths(&root, "pude.example").unwrap();
        assert_eq!(retained.len(), 1);
        assert_eq!(read_manifest(&retained[0]).unwrap().version, "1.0.0");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn uninstall_hides_plugin_and_cleanup_retry_removes_retained_data() {
        let _guard = test_guard();
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source");
        write_plugin(&source, "1.0.0", "plugin data");
        let transaction_id = Uuid::new_v4().to_string();
        install(&root, &source, &transaction_id);

        let removed = uninstall_plugin_data_with(&root, "pude.example", |_| {
            Err("simulated filesystem cleanup failure".to_string())
        })
        .unwrap();
        assert!(removed.removed);
        assert!(removed.cleanup_pending);
        assert!(read_installed_manifest(&root, "pude.example")
            .unwrap()
            .is_none());
        let transaction_id = Uuid::new_v4().to_string();
        stage(&root, &source, &transaction_id);
        assert!(commit_staged_plugin(&root, Uuid::parse_str(&transaction_id).unwrap()).is_err());
        assert!(retry_plugin_cleanup_data(&root, "pude.example").is_ok_and(|pending| !pending));
        assert!(plugin_cleanup_paths(&root, "pude.example")
            .unwrap()
            .is_empty());
        let installed =
            commit_staged_plugin(&root, Uuid::parse_str(&transaction_id).unwrap()).unwrap();
        assert_eq!(installed.manifest.version, "1.0.0");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn startup_recovery_isolates_a_broken_plugin_and_recovers_the_rest() {
        let _guard = test_guard();
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source-good");
        write_plugin(&source, "1.0.0", "good plugin");
        let transaction_id = Uuid::new_v4().to_string();
        install(&root, &source, &transaction_id);

        // A plugin whose manifest exists but whose entry file is missing fails
        // verify_entry during recovery.
        let broken_id = "pude.broken";
        let broken_root = plugin_path(&root, broken_id);
        fs::create_dir_all(broken_root.join("dist")).unwrap();
        let mut broken_manifest = manifest("1.0.0");
        broken_manifest.id = broken_id.to_string();
        fs::write(
            broken_root.join("plugin.json"),
            serde_json::to_vec(&broken_manifest).unwrap(),
        )
        .unwrap();

        let recovery = super::recover_plugins_from_root(
            &root,
            vec!["pude.example".to_string(), broken_id.to_string()],
        )
        .expect("one broken plugin should not fail the whole recovery");

        let recovered_ids: Vec<_> = recovery
            .plugins
            .iter()
            .map(|plugin| plugin.manifest.id.as_str())
            .collect();
        assert_eq!(recovered_ids, vec!["pude.example"]);
        assert!(recovery
            .plugins
            .iter()
            .all(|plugin| !plugin.cleanup_pending));
        assert!(
            recovery
                .pending_cleanup_ids
                .iter()
                .any(|id| id == broken_id),
            "the broken plugin should be queued for cleanup and stay disabled"
        );
        assert!(!recovery
            .pending_cleanup_ids
            .iter()
            .any(|id| id == "pude.example"));
        let _ = fs::remove_dir_all(root);
    }
}
