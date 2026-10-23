//! Minimal Objective-C runtime bindings shared by the macOS AppKit hooks.

use std::ffi::{c_char, c_void, CStr};

pub(crate) type Object = *mut c_void;
pub(crate) type Selector = *mut c_void;

#[link(name = "objc")]
unsafe extern "C" {
    pub(crate) fn objc_getClass(name: *const c_char) -> Object;
    pub(crate) fn object_getClass(object: Object) -> Object;
    pub(crate) fn sel_registerName(name: *const c_char) -> Selector;
    pub(crate) fn class_addMethod(
        class: Object,
        selector: Selector,
        implementation: *const c_void,
        encoding: *const c_char,
    ) -> bool;
    pub(crate) fn objc_allocateClassPair(
        superclass: Object,
        name: *const c_char,
        extra_bytes: usize,
    ) -> Object;
    pub(crate) fn objc_registerClassPair(class: Object);
    pub(crate) fn objc_msgSend();
}

pub(crate) unsafe fn class(name: &CStr) -> Object {
    unsafe { objc_getClass(name.as_ptr()) }
}

pub(crate) unsafe fn selector(name: &CStr) -> Selector {
    unsafe { sel_registerName(name.as_ptr()) }
}

/// Send a message that takes no arguments and returns an object.
pub(crate) unsafe fn send_object(receiver: Object, name: &CStr) -> Object {
    // SAFETY: the caller names a selector with this exact signature.
    unsafe {
        let send: unsafe extern "C" fn(Object, Selector) -> Object =
            std::mem::transmute(objc_msgSend as *const ());
        send(receiver, selector(name))
    }
}

/// Send a message that takes one object argument and returns nothing.
pub(crate) unsafe fn send_with_object(receiver: Object, name: &CStr, argument: Object) {
    // SAFETY: the caller names a selector with this exact signature.
    unsafe {
        let send: unsafe extern "C" fn(Object, Selector, Object) =
            std::mem::transmute(objc_msgSend as *const ());
        send(receiver, selector(name), argument)
    }
}

/// The running application's delegate, owned by AppKit and retained by Tao.
pub(crate) unsafe fn application_delegate() -> Result<(Object, Object), String> {
    unsafe {
        if libc::pthread_main_np() == 0 {
            return Err("AppKit hooks must be installed on the main thread.".into());
        }
        let application_class = class(c"NSApplication");
        if application_class.is_null() {
            return Err("NSApplication is unavailable.".into());
        }
        let application = send_object(application_class, c"sharedApplication");
        let delegate = send_object(application, c"delegate");
        if delegate.is_null() {
            return Err("The macOS application delegate is unavailable.".into());
        }
        Ok((application, delegate))
    }
}

/// Re-assign the delegate so AppKit refreshes its cached optional-method checks.
pub(crate) unsafe fn refresh_application_delegate(application: Object, delegate: Object) {
    unsafe {
        send_with_object(application, c"setDelegate:", std::ptr::null_mut());
        send_with_object(application, c"setDelegate:", delegate);
    }
}
