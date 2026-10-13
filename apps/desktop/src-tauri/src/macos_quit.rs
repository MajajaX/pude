use std::ffi::{c_char, c_void};
use std::sync::OnceLock;
use tauri::AppHandle;

type Object = *mut c_void;
type Selector = *mut c_void;
type TerminationHandler = unsafe extern "C" fn(Object, Selector, Object) -> usize;

static APP: OnceLock<AppHandle> = OnceLock::new();

#[link(name = "objc")]
unsafe extern "C" {
    fn objc_getClass(name: *const c_char) -> Object;
    fn object_getClass(object: Object) -> Object;
    fn sel_registerName(name: *const c_char) -> Selector;
    fn class_addMethod(
        class: Object,
        selector: Selector,
        implementation: TerminationHandler,
        encoding: *const c_char,
    ) -> bool;
    fn objc_msgSend();
}

unsafe fn send_object(receiver: Object, selector: Selector) -> Object {
    // SAFETY: both selectors used here return an Objective-C object and take no arguments.
    let send: unsafe extern "C" fn(Object, Selector) -> Object =
        std::mem::transmute(objc_msgSend as *const ());
    send(receiver, selector)
}

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
        if libc::pthread_main_np() == 0 {
            return Err("macOS quit protection must be installed on the main thread.".into());
        }
        let application_class = objc_getClass(c"NSApplication".as_ptr());
        if application_class.is_null() {
            return Err("NSApplication is unavailable for macOS quit protection.".into());
        }
        let application = send_object(
            application_class,
            sel_registerName(c"sharedApplication".as_ptr()),
        );
        let delegate = send_object(application, sel_registerName(c"delegate".as_ptr()));
        if delegate.is_null() {
            return Err("The macOS application delegate is unavailable.".into());
        }
        APP.set(app)
            .map_err(|_| "macOS quit protection was already installed.")?;
        if !class_addMethod(
            object_getClass(delegate),
            sel_registerName(c"applicationShouldTerminate:".as_ptr()),
            application_should_terminate,
            c"Q@:@".as_ptr(),
        ) {
            return Err("Unable to install macOS application quit protection.".into());
        }
        // Refresh AppKit's cached optional-delegate selectors. Tao retains the delegate.
        let set_delegate: unsafe extern "C" fn(Object, Selector, Object) =
            std::mem::transmute(objc_msgSend as *const ());
        let selector = sel_registerName(c"setDelegate:".as_ptr());
        set_delegate(application, selector, std::ptr::null_mut());
        set_delegate(application, selector, delegate);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_allocateClassPair(parent: Object, name: *const c_char, extra: usize) -> Object;
        fn objc_registerClassPair(class: Object);
    }

    static REQUESTS: AtomicUsize = AtomicUsize::new(0);

    unsafe extern "C" fn cancel_termination(_: Object, _: Selector, _: Object) -> usize {
        REQUESTS.fetch_add(1, Ordering::SeqCst);
        0
    }

    #[test]
    fn appkit_termination_selector_uses_the_expected_abi_and_cancels_repeated_requests() {
        // Exercise Objective-C dispatch, rather than directly calling the Rust callback.
        unsafe {
            let class = objc_allocateClassPair(
                objc_getClass(c"NSObject".as_ptr()),
                c"PudeQuitDelegateAbiTest".as_ptr(),
                0,
            );
            assert!(!class.is_null());
            let selector = sel_registerName(c"applicationShouldTerminate:".as_ptr());
            assert!(class_addMethod(
                class,
                selector,
                cancel_termination,
                c"Q@:@".as_ptr()
            ));
            objc_registerClassPair(class);
            let delegate = send_object(class, sel_registerName(c"new".as_ptr()));
            assert!(!delegate.is_null());
            let send: TerminationHandler = std::mem::transmute(objc_msgSend as *const ());
            assert_eq!(send(delegate, selector, std::ptr::null_mut()), 0);
            assert_eq!(send(delegate, selector, std::ptr::null_mut()), 0);
            assert_eq!(REQUESTS.load(Ordering::SeqCst), 2);
            let release: unsafe extern "C" fn(Object, Selector) =
                std::mem::transmute(objc_msgSend as *const ());
            release(delegate, sel_registerName(c"release".as_ptr()));
        }
    }
}
