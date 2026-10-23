//! macOS Dock menu: New Window, then the recent folders and workspaces.
//! AppKit asks the application delegate for the menu each time the user
//! right-clicks the Dock icon, so it always reflects the latest recent lists.

use std::ffi::{c_void, CString};
use std::sync::{Mutex, OnceLock};

use tauri::AppHandle;

use crate::launcher_menu;
use crate::objc_runtime::{
    application_delegate, class, class_addMethod, objc_allocateClassPair, objc_msgSend,
    objc_registerClassPair, object_getClass, refresh_application_delegate, selector, send_object,
    send_with_object, Object, Selector,
};

static APP: OnceLock<AppHandle> = OnceLock::new();
/// Retained menu-item target; stored as an address because raw pointers are not `Sync`.
static TARGET: OnceLock<usize> = OnceLock::new();
/// Paths behind the menu that is shown now, indexed by menu-item tag.
static MENU_PATHS: Mutex<Vec<String>> = Mutex::new(Vec::new());
const NEW_WINDOW_TAG: isize = -1;

pub(super) fn install(app: AppHandle) -> Result<(), String> {
    // SAFETY: setup runs on the main thread; the target class and object live
    // for the rest of the process.
    unsafe {
        let (application, delegate) = application_delegate()?;
        APP.set(app)
            .map_err(|_| "The Dock menu was already installed.")?;
        let target_class =
            objc_allocateClassPair(class(c"NSObject"), c"PudeDockMenuTarget".as_ptr(), 0);
        if target_class.is_null() {
            return Err("Unable to create the Dock menu target.".into());
        }
        if !class_addMethod(
            target_class,
            selector(c"pudeOpenDockItem:"),
            open_dock_item as *const c_void,
            c"v@:@".as_ptr(),
        ) {
            return Err("Unable to install the Dock menu action.".into());
        }
        objc_registerClassPair(target_class);
        let target = send_object(target_class, c"new");
        TARGET
            .set(target as usize)
            .map_err(|_| "The Dock menu was already installed.")?;
        if !class_addMethod(
            object_getClass(delegate),
            selector(c"applicationDockMenu:"),
            application_dock_menu as *const c_void,
            c"@@:@".as_ptr(),
        ) {
            return Err("Unable to install the Dock menu.".into());
        }
        refresh_application_delegate(application, delegate);
    }
    Ok(())
}

unsafe extern "C" fn application_dock_menu(
    _delegate: Object,
    _selector: Selector,
    _application: Object,
) -> Object {
    let recent = launcher_menu::recent_items();
    let mut paths = Vec::new();
    // SAFETY: AppKit calls this on the main thread inside its autorelease pool.
    let menu = unsafe {
        let menu = send_object(send_object(class(c"NSMenu"), c"alloc"), c"init");
        let menu = send_object(menu, c"autorelease");
        add_item(menu, &recent.labels.new_window, NEW_WINDOW_TAG, None);
        add_section(
            menu,
            &recent.labels.recent_folders,
            &recent.folders,
            &mut paths,
        );
        add_section(
            menu,
            &recent.labels.recent_workspaces,
            &recent.workspaces,
            &mut paths,
        );
        menu
    };
    if let Ok(mut current) = MENU_PATHS.lock() {
        *current = paths;
    }
    menu
}

unsafe fn add_section(menu: Object, title: &str, entries: &[String], paths: &mut Vec<String>) {
    if entries.is_empty() {
        return;
    }
    unsafe {
        send_with_object(
            menu,
            c"addItem:",
            send_object(class(c"NSMenuItem"), c"separatorItem"),
        );
        let header: unsafe extern "C" fn(Object, Selector, Object) -> Object =
            std::mem::transmute(objc_msgSend as *const ());
        let header = header(
            class(c"NSMenuItem"),
            selector(c"sectionHeaderWithTitle:"),
            ns_string(title),
        );
        send_with_object(menu, c"addItem:", header);
        for (entry, title) in entries.iter().zip(menu_titles(entries)) {
            add_item(menu, &title, paths.len() as isize, Some(entry));
            paths.push(entry.clone());
        }
    }
}

unsafe fn add_item(menu: Object, title: &str, tag: isize, tooltip: Option<&str>) {
    unsafe {
        let init: unsafe extern "C" fn(Object, Selector, Object, Selector, Object) -> Object =
            std::mem::transmute(objc_msgSend as *const ());
        let item = init(
            send_object(class(c"NSMenuItem"), c"alloc"),
            selector(c"initWithTitle:action:keyEquivalent:"),
            ns_string(title),
            selector(c"pudeOpenDockItem:"),
            ns_string(""),
        );
        let item = send_object(item, c"autorelease");
        send_with_object(
            item,
            c"setTarget:",
            TARGET.get().copied().unwrap_or(0) as Object,
        );
        let set_tag: unsafe extern "C" fn(Object, Selector, isize) =
            std::mem::transmute(objc_msgSend as *const ());
        set_tag(item, selector(c"setTag:"), tag);
        if let Some(tooltip) = tooltip {
            send_with_object(item, c"setToolTip:", ns_string(tooltip));
        }
        send_with_object(menu, c"addItem:", item);
    }
}

unsafe extern "C" fn open_dock_item(_target: Object, _selector: Selector, sender: Object) {
    // SAFETY: AppKit passes the chosen NSMenuItem as the sender.
    let tag = unsafe {
        let tag: unsafe extern "C" fn(Object, Selector) -> isize =
            std::mem::transmute(objc_msgSend as *const ());
        tag(sender, selector(c"tag"))
    };
    let Some(app) = APP.get().cloned() else {
        return;
    };
    let path = if tag == NEW_WINDOW_TAG {
        None
    } else {
        let Some(path) = MENU_PATHS.lock().ok().and_then(|paths| {
            usize::try_from(tag)
                .ok()
                .and_then(|index| paths.get(index).cloned())
        }) else {
            return;
        };
        Some(path)
    };
    // Creating a window waits for the event loop, so leave the AppKit callback first.
    tauri::async_runtime::spawn_blocking(move || match path {
        Some(path) => launcher_menu::open_in_existing_window(&app, &path),
        None => {
            if let Err(error) = crate::create_editor_window(&app, None) {
                crate::app_log::log_error(&error);
            }
        }
    });
}

unsafe fn ns_string(text: &str) -> Object {
    let text = CString::new(text.replace('\0', "")).unwrap_or_default();
    unsafe {
        let create: unsafe extern "C" fn(Object, Selector, *const std::ffi::c_char) -> Object =
            std::mem::transmute(objc_msgSend as *const ());
        create(
            class(c"NSString"),
            selector(c"stringWithUTF8String:"),
            text.as_ptr(),
        )
    }
}

/// Folder or workspace names, with the parent folder added when two entries share a name.
fn menu_titles(paths: &[String]) -> Vec<String> {
    let name = |path: &str| {
        let path = std::path::Path::new(path);
        let name = if crate::workspace_file::is_workspace_file_path(path) {
            path.file_stem()
        } else {
            path.file_name()
        };
        name.map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned())
    };
    let names: Vec<String> = paths.iter().map(|path| name(path)).collect();
    paths
        .iter()
        .zip(&names)
        .map(|(path, title)| {
            if names.iter().filter(|other| *other == title).count() < 2 {
                return title.clone();
            }
            let parent = std::path::Path::new(path)
                .parent()
                .and_then(|parent| parent.file_name())
                .map(|parent| parent.to_string_lossy().into_owned())
                .unwrap_or_default();
            format!("{title} — {parent}")
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_use_names_and_disambiguate_duplicates() {
        let paths = [
            "/work/api".to_string(),
            "/clients/acme/web".to_string(),
            "/clients/demo/web".to_string(),
            "/work/team.pdw".to_string(),
        ];
        assert_eq!(
            menu_titles(&paths),
            vec!["api", "web — acme", "web — demo", "team"]
        );
    }
}
