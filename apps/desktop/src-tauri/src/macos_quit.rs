use std::ffi::c_void;
use std::sync::OnceLock;
use tauri::AppHandle;

use crate::objc_runtime::{
    application_delegate, class_addMethod, object_getClass, refresh_application_delegate, selector,
    Object, Selector,
};

static APP: OnceLock<AppHandle> = OnceLock::new();

unsafe extern "C" fn application_should_terminate(
    _delegate: Object,
    _selector: Selector,
    _application: Object,
) -> usize {
    if let Some(app) = APP.get() {
        app.exit(0);
    }
    // NSTerminateCancel keeps AppKit alive while the existing two-phase quit gate runs.
    0
}

pub(super) fn install(app: AppHandle) -> Result<(), String> {
    // SAFETY: setup runs on the main thread; NSApplication owns its live delegate.
    // Tauri's locked Tao version does not implement applicationShouldTerminate:.
    unsafe {
        let (application, delegate) = application_delegate()?;
        APP.set(app)
            .map_err(|_| "macOS quit protection was already installed.")?;
        if !class_addMethod(
            object_getClass(delegate),
            selector(c"applicationShouldTerminate:"),
            application_should_terminate as *const c_void,
            c"Q@:@".as_ptr(),
        ) {
            return Err("Unable to install macOS application quit protection.".into());
        }
        refresh_application_delegate(application, delegate);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::objc_runtime::{
        class, objc_allocateClassPair, objc_msgSend, objc_registerClassPair, send_object,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    type TerminationHandler = unsafe extern "C" fn(Object, Selector, Object) -> usize;

    static REQUESTS: AtomicUsize = AtomicUsize::new(0);

    unsafe extern "C" fn cancel_termination(_: Object, _: Selector, _: Object) -> usize {
        REQUESTS.fetch_add(1, Ordering::SeqCst);
        0
    }

    #[test]
    fn appkit_termination_selector_uses_the_expected_abi_and_cancels_repeated_requests() {
        // Exercise Objective-C dispatch, rather than directly calling the Rust callback.
        unsafe {
            let test_class =
                objc_allocateClassPair(class(c"NSObject"), c"PudeQuitDelegateAbiTest".as_ptr(), 0);
            assert!(!test_class.is_null());
            let selector = selector(c"applicationShouldTerminate:");
            assert!(class_addMethod(
                test_class,
                selector,
                cancel_termination as *const c_void,
                c"Q@:@".as_ptr()
            ));
            objc_registerClassPair(test_class);
            let delegate = send_object(test_class, c"new");
            assert!(!delegate.is_null());
            let send: TerminationHandler = std::mem::transmute(objc_msgSend as *const ());
            assert_eq!(send(delegate, selector, std::ptr::null_mut()), 0);
            assert_eq!(send(delegate, selector, std::ptr::null_mut()), 0);
            assert_eq!(REQUESTS.load(Ordering::SeqCst), 2);
            let release: unsafe extern "C" fn(Object, Selector) =
                std::mem::transmute(objc_msgSend as *const ());
            release(delegate, crate::objc_runtime::selector(c"release"));
        }
    }
}
