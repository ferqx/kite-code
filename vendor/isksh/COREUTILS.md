# Microsoft Coreutils for Windows

`coreutils.exe` is the Microsoft Coreutils for Windows v2026.6.16 x64
multi-call binary, obtained from the official release archive:
`coreutils-2026.6.16-x64.zip`.

The native Windows sandbox runner verifies its SHA-256 against
`release/platform-capabilities/windows-runner-v1.json`, copies it into each
invocation-private runtime, then creates hard-link command aliases there.
It does not execute a Coreutils binary found on the host `PATH`.

Upstream: https://github.com/microsoft/coreutils/releases/tag/v2026.6.16

License: MIT; see `LICENSE.coreutils`.
