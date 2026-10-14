use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
enum UpdateStage {
    #[default]
    Idle,
    Available(Update),
    Downloaded(Update, Vec<u8>),
}

#[derive(Default)]
pub struct UpdateState {
    stage: Mutex<UpdateStage>,
    install_on_exit: AtomicBool,
}

impl UpdateState {
    fn stage(&self) -> Result<MutexGuard<'_, UpdateStage>, String> {
        self.stage
            .lock()
            .map_err(|_| "Update state is unavailable.".to_string())
    }

    /// Called when a quit request is aborted, so a later normal quit does not install the update.
    pub fn cancel_install_on_exit(&self) {
        self.install_on_exit.store(false, Ordering::SeqCst);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

impl UpdateInfo {
    fn of(update: &Update) -> Self {
        Self {
            version: update.version.clone(),
            notes: update.body.clone(),
        }
    }
}

#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<Option<UpdateInfo>, String> {
    // Another window may already have downloaded the update; keep it.
    if let UpdateStage::Downloaded(update, _) = &*state.stage()? {
        return Ok(Some(UpdateInfo::of(update)));
    }
    super::plugin_security::ensure_tls_provider_installed();
    let update = app
        .updater()
        .map_err(|_| "Unable to prepare the update check.".to_string())?
        .check()
        .await
        .map_err(|_| {
            "Unable to check for updates. Check your connection and try again.".to_string()
        })?;
    let info = update.as_ref().map(UpdateInfo::of);
    *state.stage()? = match update {
        Some(update) => UpdateStage::Available(update),
        None => UpdateStage::Idle,
    };
    Ok(info)
}

#[tauri::command]
pub async fn download_update(state: State<'_, UpdateState>) -> Result<(), String> {
    let update = match &*state.stage()? {
        UpdateStage::Available(update) => update.clone(),
        UpdateStage::Downloaded(..) => return Ok(()),
        UpdateStage::Idle => return Err("No update is available to download.".to_string()),
    };
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|_| {
        "Unable to download the update. Check your connection and try again.".to_string()
    })?;
    *state.stage()? = UpdateStage::Downloaded(update, bytes);
    Ok(())
}

/// Quits through the normal two-phase quit gate; the update is installed once the app has exited.
#[tauri::command]
pub fn restart_to_update(app: AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    if !matches!(&*state.stage()?, UpdateStage::Downloaded(..)) {
        return Err("The update has not been downloaded yet.".to_string());
    }
    state.install_on_exit.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

pub fn install_on_exit(app: &AppHandle) {
    let state = app.state::<UpdateState>();
    if !state.install_on_exit.swap(false, Ordering::SeqCst) {
        return;
    }
    let Ok(mut stage) = state.stage() else {
        return;
    };
    let UpdateStage::Downloaded(update, bytes) = std::mem::take(&mut *stage) else {
        return;
    };
    match update.install(bytes) {
        Ok(()) => tauri::process::restart(&app.env()),
        Err(error) => {
            super::app_log::log_error(&format!("Unable to install the update. {error}"));
            rfd::MessageDialog::new()
                .set_title("pude — update error")
                .set_description("pude could not install the update. Download the latest installer from pude.dev instead.")
                .show();
        }
    }
}
