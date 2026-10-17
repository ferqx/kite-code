fn main() {
    napi_build::setup();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // Only this DLL's static imports are restricted; no process-wide loader mutation.
        println!("cargo:rustc-link-arg-cdylib=/DEPENDENTLOADFLAG:0x800");
    }
}
