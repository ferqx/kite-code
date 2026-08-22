pub mod acl;
pub mod appcontainer_profile;
pub mod direct_workspace;
pub mod job;
pub mod protected_paths;
pub mod protocol;
pub mod restricted_token;

use std::io::Read;

/// Build the Windows command line for `bash --noprofile --norc -c <command>`
/// using the CommandLineToArgvW quoting rules so the entire user command is
/// delivered to bash as a single argument.
pub fn build_bash_command_line(bash_path: &str, command: &str) -> String {
    let parts = [
        quote_argument(bash_path),
        "--noprofile".to_string(),
        "--norc".to_string(),
        "-c".to_string(),
        quote_argument(command),
    ];
    parts.join(" ")
}

/// Build the Windows command line for BusyBox-w32's native `sh -c` entrypoint.
/// BusyBox is a static Win32 binary, so unlike MSYS bash it does not need a
/// POSIX DLL or user-profile initialization inside the restricted child.
pub fn build_busybox_sh_command_line(busybox_path: &str, command: &str) -> String {
    [
        quote_argument(busybox_path),
        "sh".to_string(),
        "-c".to_string(),
        quote_argument(command),
    ]
    .join(" ")
}

/// Build the command line for isksh's non-interactive POSIX entrypoint.
/// isksh is a native Windows shell and deliberately receives no startup file
/// argument, so the adapter-owned HOME/runtime directory cannot cause a host
/// profile to be loaded.
pub fn build_isksh_command_line(isksh_path: &str, command: &str) -> String {
    [
        quote_argument(isksh_path),
        "-c".to_string(),
        quote_argument(command),
    ]
    .join(" ")
}
/// Quote one argument per the standard C runtime / CommandLineToArgvW rules:
/// wrap in quotes when it contains whitespace or quotes; escape embedded
/// quotes as `\"` and double backslashes that precede a quote.
pub fn quote_argument(argument: &str) -> String {
    if argument.is_empty() {
        return "\"\"".to_string();
    }
    let needs_quotes = argument
        .chars()
        .any(|character| character == ' ' || character == '\t' || character == '"');
    if !needs_quotes {
        return argument.to_string();
    }
    let mut output = String::with_capacity(argument.len() + 2);
    output.push('"');
    let mut backslashes = 0usize;
    for character in argument.chars() {
        if character == '\\' {
            backslashes += 1;
        } else if character == '"' {
            for _ in 0..backslashes * 2 {
                output.push('\\');
            }
            backslashes = 0;
            output.push('\\');
            output.push('"');
        } else {
            for _ in 0..backslashes {
                output.push('\\');
            }
            backslashes = 0;
            output.push(character);
        }
    }
    for _ in 0..backslashes * 2 {
        output.push('\\');
    }
    output.push('"');
    output
}

/// Compute the SHA-256 (hex) of a file.
pub fn sha256_file(path: &str) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.hex())
}

/// Compute the SHA-256 (hex) of raw bytes.
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.hex()
}

/// Compute HMAC-SHA256 without bringing a second crypto implementation into
/// the small native runner. The key is held only in the current process and
/// callers must not persist or include it in protocol payloads.
pub fn hmac_sha256_hex(key: &[u8], data: &[u8]) -> String {
    const BLOCK_SIZE: usize = 64;
    let mut key_block = [0u8; BLOCK_SIZE];
    if key.len() > BLOCK_SIZE {
        let mut digest = Sha256::new();
        digest.update(key);
        key_block[..32].copy_from_slice(&digest.finalize());
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0u8; BLOCK_SIZE];
    let mut outer_pad = [0u8; BLOCK_SIZE];
    for index in 0..BLOCK_SIZE {
        inner_pad[index] = key_block[index] ^ 0x36;
        outer_pad[index] = key_block[index] ^ 0x5c;
    }
    let mut inner = Sha256::new();
    inner.update(&inner_pad);
    inner.update(data);
    let mut inner_digest = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(&outer_pad);
    outer.update(&inner_digest);
    let result = outer.hex();
    key_block.fill(0);
    inner_pad.fill(0);
    outer_pad.fill(0);
    inner_digest.fill(0);
    result
}

/// Minimal SHA-256 implementation (no external crypto dependency).
struct Sha256 {
    state: [u32; 8],
    buffer: [u8; 64],
    buffer_len: usize,
    total_len: u64,
}

impl Sha256 {
    fn new() -> Self {
        Sha256 {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            buffer: [0u8; 64],
            buffer_len: 0,
            total_len: 0,
        }
    }

    fn update(&mut self, mut data: &[u8]) {
        self.total_len += data.len() as u64;
        if self.buffer_len > 0 {
            let needed = 64 - self.buffer_len;
            let take = needed.min(data.len());
            self.buffer[self.buffer_len..self.buffer_len + take].copy_from_slice(&data[..take]);
            self.buffer_len += take;
            data = &data[take..];
            if self.buffer_len == 64 {
                let block = self.buffer;
                self.compress(&block);
                self.buffer_len = 0;
            }
        }
        while data.len() >= 64 {
            let mut block = [0u8; 64];
            block.copy_from_slice(&data[..64]);
            self.compress(&block);
            data = &data[64..];
        }
        if !data.is_empty() {
            self.buffer[..data.len()].copy_from_slice(data);
            self.buffer_len = data.len();
        }
    }

    fn finalize(mut self) -> [u8; 32] {
        let bit_length = self.total_len * 8;
        self.update(&[0x80]);
        while self.buffer_len != 56 {
            self.update(&[0x00]);
        }
        let mut length_bytes = [0u8; 8];
        length_bytes.copy_from_slice(&bit_length.to_be_bytes());
        self.update(&length_bytes);
        let mut digest = [0u8; 32];
        for (index, word) in self.state.iter().enumerate() {
            digest[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        digest
    }

    fn hex(self) -> String {
        let digest = self.finalize();
        let mut output = String::with_capacity(64);
        for byte in digest {
            output.push_str(&format!("{byte:02x}"));
        }
        output
    }

    fn compress(&mut self, block: &[u8; 64]) {
        const K: [u32; 64] = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
            0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
            0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
            0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
            0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
            0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
            0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
            0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
            0xc67178f2,
        ];
        let mut words = [0u32; 64];
        for (index, chunk) in block.chunks_exact(4).enumerate() {
            words[index] = u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        }
        for index in 16..64 {
            let s0 = words[index - 15].rotate_right(7)
                ^ words[index - 15].rotate_right(18)
                ^ (words[index - 15] >> 3);
            let s1 = words[index - 2].rotate_right(17)
                ^ words[index - 2].rotate_right(19)
                ^ (words[index - 2] >> 10);
            words[index] = words[index - 16]
                .wrapping_add(s0)
                .wrapping_add(words[index - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.state;
        for (index, &k) in K.iter().enumerate() {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(k)
                .wrapping_add(words[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        self.state[0] = self.state[0].wrapping_add(a);
        self.state[1] = self.state[1].wrapping_add(b);
        self.state[2] = self.state[2].wrapping_add(c);
        self.state[3] = self.state[3].wrapping_add(d);
        self.state[4] = self.state[4].wrapping_add(e);
        self.state[5] = self.state[5].wrapping_add(f);
        self.state[6] = self.state[6].wrapping_add(g);
        self.state[7] = self.state[7].wrapping_add(h);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_argument_simple() {
        assert_eq!(quote_argument("bash.exe"), "bash.exe");
        assert_eq!(quote_argument(""), "\"\"");
    }

    #[test]
    fn quote_argument_with_spaces() {
        assert_eq!(quote_argument("hello world"), "\"hello world\"");
    }

    #[test]
    fn quote_argument_escapes_embedded_quotes() {
        assert_eq!(quote_argument("a\"b"), "\"a\\\"b\"");
    }

    #[test]
    fn quote_argument_doubles_backslashes_before_quote() {
        assert_eq!(quote_argument("a\\\\\"b"), "\"a\\\\\\\\\\\"b\"");
    }

    #[test]
    fn busybox_command_line_selects_sh() {
        let command = build_busybox_sh_command_line("C:\\runtime\\busybox.exe", "echo hello");
        assert!(command.contains("busybox.exe sh -c"));
        assert!(command.ends_with("\"echo hello\""));
    }
    #[test]
    fn isksh_command_line_is_non_interactive() {
        let command = build_isksh_command_line("C:\\runtime\\isksh.exe", "echo hello");
        assert!(command.contains("isksh.exe -c \"echo hello\""));
        assert!(!command.contains("--noprofile"));
        assert!(!command.contains("--norc"));
    }
    #[test]
    fn build_command_line_contains_single_dash_c() {
        let line = build_bash_command_line("C:\\vendor\\bash.exe", "echo hi");
        assert!(line.contains("--noprofile"));
        assert!(line.contains("--norc"));
        assert!(line.contains(" -c \"echo hi\""));
    }

    #[test]
    fn sha256_known_vector() {
        assert_eq!(
            sha256_bytes(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_bytes(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn hmac_sha256_known_vector() {
        assert_eq!(
            hmac_sha256_hex(&[0x0b; 20], b"Hi There"),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
    }

    fn sha256_bytes(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        hasher.hex()
    }
}
