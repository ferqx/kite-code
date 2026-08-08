use std::path::Path;

pub const COREUTILS_ALIASES: &[&str] = &[
    "[",
    "arch",
    "b2sum",
    "base32",
    "base64",
    "basename",
    "basenc",
    "cat",
    "cksum",
    "comm",
    "coreutils-manager",
    "cp",
    "csplit",
    "cut",
    "date",
    "df",
    "dirname",
    "du",
    "echo",
    "env",
    "expr",
    "factor",
    "false",
    "find",
    "fmt",
    "fold",
    "grep",
    "head",
    "hostname",
    "join",
    "link",
    "ln",
    "ls",
    "md5sum",
    "mkdir",
    "mktemp",
    "mv",
    "nl",
    "nproc",
    "numfmt",
    "od",
    "paste",
    "pathchk",
    "pr",
    "printenv",
    "printf",
    "ptx",
    "pwd",
    "readlink",
    "realpath",
    "rm",
    "rmdir",
    "seq",
    "sha1sum",
    "sha224sum",
    "sha256sum",
    "sha384sum",
    "sha512sum",
    "shuf",
    "sleep",
    "sort",
    "split",
    "stat",
    "sum",
    "tac",
    "tail",
    "tee",
    "test",
    "touch",
    "tr",
    "true",
    "truncate",
    "tsort",
    "unexpand",
    "uniq",
    "unlink",
    "uptime",
    "wc",
    "xargs",
    "yes",
];

/// Materialize the verified multi-call binary and all command aliases. The
/// operation is idempotent only for a complete directory, allowing the
/// initiating user to prepare it before the managed Online logon starts.
pub fn materialize_coreutils_aliases(
    runtime_root: &str,
    verified_coreutils: &Path,
) -> Result<(), String> {
    let tools_root = Path::new(runtime_root).join("kite-coreutils");
    match std::fs::create_dir(&tools_root) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let complete = tools_root.join("coreutils.exe").is_file()
                && COREUTILS_ALIASES
                    .iter()
                    .all(|alias| tools_root.join(format!("{alias}.exe")).is_file());
            if complete {
                return Ok(());
            }
            return Err(format!(
                "coreutils_runtime_prepare_failed: {} exists but is incomplete",
                tools_root.display()
            ));
        }
        Err(error) => {
            return Err(format!(
                "coreutils_runtime_prepare_failed: cannot create {}: {error}",
                tools_root.display()
            ));
        }
    }
    let private_binary = tools_root.join("coreutils.exe");
    std::fs::copy(verified_coreutils, &private_binary).map_err(|error| {
        format!(
            "coreutils_runtime_prepare_failed: cannot copy {}: {error}",
            private_binary.display()
        )
    })?;
    for alias in COREUTILS_ALIASES {
        let target = tools_root.join(format!("{alias}.exe"));
        std::fs::hard_link(&private_binary, &target).map_err(|error| {
            format!(
                "coreutils_runtime_prepare_failed: cannot create {}: {error}",
                target.display()
            )
        })?;
    }
    Ok(())
}
