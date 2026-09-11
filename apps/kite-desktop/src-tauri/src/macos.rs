//! Cocoa's standard Quit/Dock/Apple-event termination calls the application
//! delegate directly. Route it through Tauri's cancellable exit lifecycle.
use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchTime};
use objc2::{
    class, msg_send,
    rc::Retained,
    runtime::{AnyObject, ClassBuilder, Sel},
    sel,
};
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSColor, NSImage, NSImageAlignment, NSImageScaling, NSImageView,
    NSView, NSWindowOrderingMode,
};
use objc2_foundation::{MainThreadMarker, NSError};
use objc2_web_kit::WKWebView;
use std::{sync::OnceLock, time::Duration};

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

struct MainThreadSnapshot(Retained<NSImageView>);

// SAFETY: the retained AppKit object crosses libdispatch's Send boundary but
// is accessed and dropped only by the main queue callback.
unsafe impl Send for MainThreadSnapshot {}

impl MainThreadSnapshot {
    fn remove(self) {
        self.0.removeFromSuperview();
    }
}

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

pub fn animated_toggle_maximize(window: tauri::WebviewWindow) -> Result<(), String> {
    let target = window.clone();
    window
        .with_webview(move |platform| unsafe {
            let webview: &WKWebView = &*platform.inner().cast();
            let target = target.clone();
            let webview_ptr = platform.inner() as usize;
            let completion = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
                if let Some(image) = image.as_ref() {
                    let webview: &NSView = &*(webview_ptr as *mut NSView);
                    if let Some(parent) = webview.superview() {
                        let mtm = MainThreadMarker::new_unchecked();
                        let snapshot = NSImageView::imageViewWithImage(image, mtm);
                        snapshot.setFrame(webview.frame());
                        snapshot.setImageScaling(NSImageScaling::ScaleNone);
                        snapshot.setImageAlignment(NSImageAlignment::AlignTopLeft);
                        snapshot.setWantsLayer(true);
                        if let Some(layer) = snapshot.layer() {
                            let background =
                                NSColor::colorWithSRGBRed_green_blue_alpha(0.98, 0.98, 0.98, 1.0);
                            let background = background.CGColor();
                            layer.setBackgroundColor(Some(&background));
                        }
                        snapshot.setAutoresizingMask(
                            NSAutoresizingMaskOptions::ViewWidthSizable
                                | NSAutoresizingMaskOptions::ViewHeightSizable,
                        );
                        parent.addSubview_positioned_relativeTo(
                            &snapshot,
                            NSWindowOrderingMode::Above,
                            Some(webview),
                        );
                        let snapshot = MainThreadSnapshot(snapshot);
                        let when = DispatchTime::try_from(Duration::from_millis(450)).unwrap();
                        let _ = DispatchQueue::main().after(when, move || snapshot.remove());
                    }
                }
                if target.is_maximized().unwrap_or(false) {
                    let _ = target.unmaximize();
                } else {
                    let _ = target.maximize();
                }
            });
            webview.takeSnapshotWithConfiguration_completionHandler(None, &completion);
        })
        .map_err(|error| error.to_string())
}
