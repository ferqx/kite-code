//! Cocoa's standard Quit/Dock/Apple-event termination calls the application
//! delegate directly. Route it through Tauri's cancellable exit lifecycle.
use objc2::{
    class, msg_send,
    runtime::{AnyObject, ClassBuilder, Sel},
    sel,
};
use std::sync::OnceLock;

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

extern "C" fn should_terminate(_: *mut AnyObject, _: Sel, _: *mut AnyObject) -> usize {
    if let Some(app) = APP.get() {
        app.exit(0);
    }
    // NSTerminateCancel. The existing async confirmation/cleanup path is the
    // only code allowed to end the event loop after an ordinary Quit request.
    0
}

pub fn install(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    APP.set(app.clone())
        .map_err(|_| "macOS exit handler already installed")?;
    // SAFETY: setup runs on the AppKit main thread. The subclass introduces
    // no ivars and inherits every existing Tao delegate method and layout.
    // Its only override has Cocoa's exact applicationShouldTerminate: ABI.
    unsafe {
        let application: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let delegate: *mut AnyObject = msg_send![application, delegate];
        let delegate = delegate
            .as_ref()
            .ok_or("macOS application delegate unavailable")?;
        let mut subclass = ClassBuilder::new(c"KiteApplicationDelegate", delegate.class())
            .ok_or("macOS application delegate class unavailable")?;
        subclass.add_method(
            sel!(applicationShouldTerminate:),
            should_terminate as extern "C" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize,
        );
        let subclass = subclass.register();
        AnyObject::set_class(delegate, subclass);
    }
    Ok(())
}
