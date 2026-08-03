// Postinstall: ensure lefthook can resolve its binary in WSL/Windows hybrid environments.
// Bun on Windows may install lefthook-linux-x64 instead of lefthook-windows-x64,
// but process.platform is "win32", so get-exe.js looks for the wrong package.
//
// This script downloads the Windows lefthook binary as a fallback and patches
// get-exe.js to find it when the platform-specific package is missing.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LEFTHOOK_VERSION = '2.1.9';
const MODULE_PATH = fileURLToPath(import.meta.url);
const LEFTHOOK_DIR = dirname(MODULE_PATH).replace(/\\/g, '/');
const NODE_MODULES = resolve(LEFTHOOK_DIR, '..', 'node_modules');
const GET_EXE_PATH = resolve(NODE_MODULES, 'lefthook', 'get-exe.js');
const WIN_EXE_PATH = resolve(NODE_MODULES, 'lefthook_win.exe');
const require = createRequire(import.meta.url);

async function main() {
  // Only needed on Windows
  if (process.platform !== 'win32') {
    // Still run lefthook install
    try {
      execFileSync('bun', ['x', 'lefthook', 'install', '-f'], {
        stdio: 'inherit',
        cwd: resolve(NODE_MODULES, '..'),
      });
    } catch {}
    return;
  }

  // Download Windows lefthook binary if missing
  if (!existsSync(WIN_EXE_PATH)) {
    const url = `https://github.com/evilmartians/lefthook/releases/download/v${LEFTHOOK_VERSION}/lefthook_${LEFTHOOK_VERSION}_Windows_x86_64.exe`;
    try {
      const res = await fetch(url);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        writeFileSync(WIN_EXE_PATH, buf, { mode: 0o755 });
      }
    } catch {
      // Non-critical — lefthook install will just fail
    }
  }

  // Patch get-exe.js with WSL fallback
  if (existsSync(GET_EXE_PATH)) {
    let content = readFileSync(GET_EXE_PATH, 'utf-8');
    // Check if already patched
    if (!content.includes('lefthook_win.exe')) {
      content = content.replace(
        'const path = require("path");',
        'const path = require("path");\nconst fs = require("fs");',
      );
      content = content.replace(
        /return require\.resolve\(`lefthook-\$\{os\}-\$\{arch\}\/bin\/lefthook\$\{extension\}`\);/,
        `try {
    return require.resolve(\`lefthook-\${os}-\${arch}/bin/lefthook\${extension}\`);
  } catch (_) {
    const fallback = path.resolve(__dirname, '..', 'lefthook_win.exe');
    if (fs.existsSync(fallback)) return fallback;
    throw new Error(\`lefthook binary not found for \${os}-\${arch}\`);
  }`,
      );
      writeFileSync(GET_EXE_PATH, content, 'utf-8');
    }
  }

  // Run lefthook install via patched get-exe
  try {
    const exe = require(GET_EXE_PATH).getExePath();
    execFileSync(exe, ['install', '-f'], {
      stdio: 'inherit',
      cwd: resolve(NODE_MODULES, '..'),
    });
  } catch {
    // Non-critical — user can run manually
  }
}

// Importing the module is a side-effect-free compatibility check. Package
// managers execute the file directly, which is the only path that installs hooks.
if (process.argv[1] && resolve(process.argv[1]) === MODULE_PATH) {
  main().catch(() => {});
}
