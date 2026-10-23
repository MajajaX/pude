//! Windows taskbar Jump List: a New Window task plus Recent Folders and
//! Recent Workspaces. Each entry starts pude with `--new-window` or
//! `--reuse-window <path>`; the single-instance handler forwards it to the
//! running app, which opens the path as a project tab in the last focused window.

use std::path::Path;
use std::sync::Mutex;

use windows::core::{Interface, Result, HSTRING, PCWSTR};
use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{
    DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, ShellLink,
};

use crate::launcher_menu::{RecentItems, NEW_WINDOW_ARG, REUSE_WINDOW_ARG};

/// Serializes updates so two windows reporting at once cannot interleave lists.
static UPDATE_LOCK: Mutex<()> = Mutex::new(());

/// Rebuild the Jump List on a background COM thread.
pub(crate) fn update(items: RecentItems) {
    let spawned = std::thread::Builder::new()
        .name("pude-jump-list".into())
        .spawn(move || {
            let _guard = UPDATE_LOCK.lock();
            // SAFETY: this thread owns its single-threaded COM apartment for the whole update.
            let result = unsafe {
                let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
                let result = rebuild(&items);
                if initialized {
                    CoUninitialize();
                }
                result
            };
            if let Err(error) = result {
                crate::app_log::log_error(&format!(
                    "Unable to update the taskbar Jump List: {error}"
                ));
            }
        });
    if let Err(error) = spawned {
        crate::app_log::log_error(&format!("Unable to update the taskbar Jump List: {error}"));
    }
}

unsafe fn rebuild(items: &RecentItems) -> Result<()> {
    let executable = std::env::current_exe().map_err(|error| {
        windows::core::Error::new(windows::Win32::Foundation::E_FAIL, error.to_string())
    })?;
    unsafe {
        let list: ICustomDestinationList =
            CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
        let mut slots = 0;
        let removed: IObjectArray = list.BeginList(&mut slots)?;
        // Windows rejects a category that contains an item the user removed from the list.
        let removed_arguments = link_arguments(&removed)?;
        for (title, paths) in [
            (&items.labels.recent_folders, &items.folders),
            (&items.labels.recent_workspaces, &items.workspaces),
        ] {
            let collection: IObjectCollection =
                CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
            let mut count = 0;
            for path in paths {
                let arguments = format!("{REUSE_WINDOW_ARG} {}", quote_argument(path));
                if removed_arguments.contains(&arguments) {
                    continue;
                }
                collection.AddObject(&shell_link(
                    &executable,
                    &arguments,
                    &display_name(path),
                    path,
                )?)?;
                count += 1;
            }
            if count > 0 {
                list.AppendCategory(
                    &HSTRING::from(title.as_str()),
                    &collection.cast::<IObjectArray>()?,
                )?;
            }
        }
        let tasks: IObjectCollection =
            CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
        tasks.AddObject(&shell_link(
            &executable,
            NEW_WINDOW_ARG,
            &items.labels.new_window,
            &items.labels.new_window_description,
        )?)?;
        list.AddUserTasks(&tasks.cast::<IObjectArray>()?)?;
        list.CommitList()
    }
}

unsafe fn shell_link(
    executable: &Path,
    arguments: &str,
    title: &str,
    description: &str,
) -> Result<IShellLinkW> {
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        let executable = HSTRING::from(executable.as_os_str());
        link.SetPath(&executable)?;
        link.SetArguments(&HSTRING::from(arguments))?;
        link.SetDescription(&HSTRING::from(description))?;
        link.SetIconLocation(&executable, 0)?;
        let properties: IPropertyStore = link.cast()?;
        properties.SetValue(&PKEY_Title, &PROPVARIANT::from(title))?;
        properties.Commit()?;
        Ok(link)
    }
}

unsafe fn link_arguments(links: &IObjectArray) -> Result<Vec<String>> {
    let mut arguments = Vec::new();
    unsafe {
        for index in 0..links.GetCount()? {
            let Ok(link) = links.GetAt::<IShellLinkW>(index) else {
                continue;
            };
            let mut buffer = [0u16; 2048];
            if link.GetArguments(&mut buffer).is_ok() {
                arguments.push(
                    PCWSTR::from_raw(buffer.as_ptr())
                        .to_string()
                        .unwrap_or_default(),
                );
            }
        }
    }
    Ok(arguments)
}

fn display_name(path: &str) -> String {
    let path = Path::new(path);
    let name = if crate::workspace_file::is_workspace_file_path(path) {
        path.file_stem()
    } else {
        path.file_name()
    };
    name.map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// Quote a path for `CommandLineToArgvW`: a trailing backslash would escape
/// the closing quote, so it is doubled (for example a drive root `C:\`).
fn quote_argument(path: &str) -> String {
    let trailing = path.len() - path.trim_end_matches('\\').len();
    format!("\"{path}{}\"", "\\".repeat(trailing))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_paths_for_the_windows_command_line() {
        assert_eq!(
            quote_argument(r"C:\Projects\My App"),
            r#""C:\Projects\My App""#
        );
        assert_eq!(quote_argument(r"C:\"), r#""C:\\""#);
        assert_eq!(display_name(r"C:\work\team.pdw"), "team");
        assert_eq!(display_name(r"C:\work\api"), "api");
    }
}
