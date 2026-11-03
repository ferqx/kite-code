use std::{env, fs, path::PathBuf};

fn word(bytes: &[u8], offset: usize) -> usize {
    u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap()) as usize
}
fn dword(bytes: &[u8], offset: usize) -> usize {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize
}

fn main() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    assert_eq!(env::var("CARGO_CFG_TARGET_ARCH").unwrap(), "x86_64");
    let path = PathBuf::from(env::var("SystemRoot").unwrap()).join("System32/ntdll.dll");
    let bytes = fs::read(path).unwrap();
    let pe = dword(&bytes, 0x3c);
    assert_eq!(&bytes[pe..pe + 4], b"PE\0\0");
    let optional = pe + 24;
    assert_eq!(word(&bytes, optional), 0x20b);
    let sections = optional + word(&bytes, pe + 20);
    let rva = |address: usize| -> usize {
        for section in (0..word(&bytes, pe + 6)).map(|n| sections + n * 40) {
            let start = dword(&bytes, section + 12);
            let size = dword(&bytes, section + 8).max(dword(&bytes, section + 16));
            if address >= start && address < start + size {
                return dword(&bytes, section + 20) + address - start;
            }
        }
        panic!("invalid system DLL RVA");
    };
    let export = rva(dword(&bytes, optional + 112));
    let names = rva(dword(&bytes, export + 32));
    let mut definition = String::from("LIBRARY ktipc\nEXPORTS\nRtlAddAccessAllowedAce\n");
    for index in 0..dword(&bytes, export + 24) {
        let start = rva(dword(&bytes, names + index * 4));
        let end = start + bytes[start..].iter().position(|b| *b == 0).unwrap();
        let name = std::str::from_utf8(&bytes[start..end]).unwrap();
        assert!(name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'));
        if name != "RtlAddAccessAllowedAce" {
            definition.push_str(&format!("{name}=ntdll.{name}\n"));
        }
    }
    let destination = PathBuf::from(env::var("OUT_DIR").unwrap()).join("forward.def");
    fs::write(&destination, definition).unwrap();
    println!("cargo:rustc-cdylib-link-arg={}", destination.display());
    println!("cargo:rerun-if-changed=build.rs");
}
