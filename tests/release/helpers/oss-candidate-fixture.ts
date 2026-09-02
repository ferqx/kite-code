import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  currentOssReleaseTarget,
  type OssReleaseTarget,
  ossCandidateManifestSchema,
  writeOssCandidateArchive,
} from '../../../scripts/release/oss-candidate';

let cachedWindowsLauncher: Promise<Uint8Array> | undefined;
let cachedWindowsCli: Promise<Uint8Array> | undefined;

export async function createOssCandidateFixture(
  version: string,
  target: OssReleaseTarget = currentOssReleaseTarget(),
  argumentLogPath?: string,
) {
  const root = mkdtempSync(join(tmpdir(), 'kite-oss-candidate-test-'));
  const archivePath = join(root, 'candidate.tar.gz');
  const cli = await fixtureCliBytes(root, target, argumentLogPath);
  const suffix = target.executableSuffix;
  const launcher = await fixtureLauncherBytes(root, target);
  const web = bytes('<!doctype html><html><body><div id="root"></div></body></html>\n');
  const agentApi = bytes('{"openapi":"3.1.0"}\n');
  const files = new Map<string, Uint8Array>([
    [`bin/kite${suffix}`, cli],
    [`bin/kite-tui${suffix}`, bytes('#!/bin/sh\necho Kite TUI\n')],
    [`bin/kite-service${suffix}`, bytes('#!/bin/sh\necho Kite Service\n')],
    ['payload/web/index.html', web],
    ['payload/web/api-docs/openapi.json', agentApi],
    [`release/launchers/kite${suffix}`, launcher],
    [`release/launchers/kite-tui${suffix}`, launcher],
    [`release/launchers/kite-service${suffix}`, launcher],
    ['docs/MAINTAINER_CHECKLIST.md', bytes('# Checklist\n')],
    ['docs/KNOWN_LIMITATIONS.md', bytes('# Limitations\n')],
    ['docs/RELEASE_NOTES.md', bytes('# Notes\n')],
  ]);
  const manifest = ossCandidateManifestSchema.parse({
    schema: 'KiteCodeOssCandidateManifest',
    version: 1,
    productVersion: version,
    commitSha: 'a'.repeat(40),
    sourceDate: '2026-08-04T00:00:00.000Z',
    sourceDirty: false,
    bunVersion: '1.4.0',
    target: {
      id: target.id,
      os: target.os,
      arch: target.arch,
      compileMode: 'native',
    },
    integrity: 'sha256-only-unsigned',
    defaultCapabilities: {
      autoCompaction: 'off',
      effectfulCapabilities: 'off',
      remoteTelemetry: 'off',
    },
    releaseSlots: {
      cli: { entrypoint: `bin/kite${suffix}`, identity: digest(cli) },
      tui: {
        entrypoint: `bin/kite-tui${suffix}`,
        identity: digest(files.get(`bin/kite-tui${suffix}`)!),
      },
      service: {
        entrypoint: `bin/kite-service${suffix}`,
        identity: digest(files.get(`bin/kite-service${suffix}`)!),
      },
      coordinator: { entrypoint: null, identity: null },
      worker: { entrypoint: null, identity: null },
      gateway: { entrypoint: null, identity: null },
      web: { entrypoint: 'payload/web/index.html', identity: digest(web) },
    },
    files: [...files]
      .map(([path, value]) => ({ path, size: value.byteLength, sha256: digest(value) }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  });
  await writeOssCandidateArchive({ archivePath, manifest, files });
  return { root, archivePath, manifest, files };
}

async function fixtureLauncherBytes(root: string, target: OssReleaseTarget): Promise<Uint8Array> {
  if (target.os !== 'win32' || process.platform !== 'win32') {
    return bytes(
      '#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\ncandidate=$(cat "$root/active")\nexec "$root/releases/$candidate/bin/$(basename -- "$0")" "$@"\n',
    );
  }
  cachedWindowsLauncher ??= compileWindowsFixtureLauncher(root);
  try {
    return new Uint8Array(await cachedWindowsLauncher);
  } catch (error) {
    cachedWindowsLauncher = undefined;
    throw error;
  }
}

async function fixtureCliBytes(
  root: string,
  target: OssReleaseTarget,
  argumentLogPath?: string,
): Promise<Uint8Array> {
  if (target.os !== 'win32' || process.platform !== 'win32') {
    const recordArguments = argumentLogPath
      ? `printf '%s\\n' "$@" >> '${argumentLogPath.replaceAll("'", "'\\''")}'\n`
      : '';
    return bytes(`#!/bin/sh\n${recordArguments}echo Kite\n`);
  }

  if (!argumentLogPath) {
    const cached = cachedWindowsCli ?? compileWindowsFixtureCli(root);
    cachedWindowsCli = cached;
    try {
      return new Uint8Array(await cached);
    } catch (error) {
      if (cachedWindowsCli === cached) cachedWindowsCli = undefined;
      throw error;
    }
  }
  return compileWindowsFixtureCli(root, argumentLogPath);
}

async function compileWindowsFixtureLauncher(root: string): Promise<Uint8Array> {
  const executable = join(root, 'fixture-launcher.exe');
  return compileTinyWindowsFixture(
    root,
    'fixture-launcher',
    `use std::env;
use std::fs;
use std::process::{Command, Stdio};

fn main() {
    let executable = env::current_exe().expect("fixture launcher executable");
    let root = executable
        .parent()
        .and_then(|bin| bin.parent())
        .expect("fixture launcher root");
    let candidate = fs::read_to_string(root.join("active"))
        .expect("fixture active pointer");
    let name = executable.file_name().expect("fixture launcher name");
    let status = Command::new(
        root.join("releases")
            .join(candidate.trim())
            .join("bin")
            .join(name),
    )
    .args(env::args_os().skip(1))
    .stdin(Stdio::inherit())
    .stdout(Stdio::inherit())
    .stderr(Stdio::inherit())
    .status()
    .expect("fixture candidate process");
    std::process::exit(status.code().unwrap_or(1));
}
`,
    `const fs = require('node:fs');
const path = require('node:path');
const root = path.dirname(path.dirname(process.execPath));
const candidate = fs.readFileSync(path.join(root, 'active'), 'utf8').trim();
const name = path.basename(process.execPath);
const child = Bun.spawn([path.join(root, 'releases', candidate, 'bin', name), ...process.argv.slice(2)], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
process.exitCode = await child.exited;
`,
    executable,
  );
}

async function compileWindowsFixtureCli(
  root: string,
  argumentLogPath?: string,
): Promise<Uint8Array> {
  const executable = join(root, 'fixture-kite.exe');
  const rustLog = argumentLogPath
    ? `    let mut log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(${JSON.stringify(argumentLogPath)})
        .expect("fixture argument log");
    for argument in &arguments {
        writeln!(log, "{}", argument).expect("fixture argument write");
    }
`
    : '';
  const bunLog = argumentLogPath
    ? `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(argumentLogPath)}, process.argv.slice(1).join('\\n') + '\\n');
`
    : '';
  return compileTinyWindowsFixture(
    root,
    'fixture-cli',
    `use std::env;
${argumentLogPath ? 'use std::fs::OpenOptions;\nuse std::io::Write;\n' : ''}
fn main() {
    let arguments: Vec<String> = env::args().skip(1).collect();
${rustLog}    println!("Kite");
}
`,
    `${bunLog}console.log('Kite');\n`,
    executable,
  );
}

async function compileTinyWindowsFixture(
  root: string,
  name: string,
  rustSource: string,
  bunSource: string,
  executable: string,
): Promise<Uint8Array> {
  const rustEntrypoint = join(root, `${name}.rs`);
  writeFileSync(rustEntrypoint, rustSource);
  const rustcPath = Bun.which('rustc');
  if (rustcPath) {
    const rustc = Bun.spawn(
      [
        rustcPath,
        '--edition=2021',
        '-C',
        'opt-level=s',
        '-C',
        'strip=symbols',
        '-C',
        'panic=abort',
        '-o',
        executable,
        rustEntrypoint,
      ],
      { cwd: root, stdout: 'ignore', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([rustc.exited, new Response(rustc.stderr).text()]);
    if (exitCode === 0) return new Uint8Array(readFileSync(executable));
    throw new Error(
      `Windows release fixture ${name} rustc compilation failed: ${stderr.slice(0, 2_000)}`,
    );
  }

  // A standalone Windows checkout may not have the release workflow's locked Rust toolchain.
  // Keep a functional fallback; hosted candidate evidence uses the small native fixture.
  rmSync(executable, { force: true });
  const bunEntrypoint = join(root, `${name}.ts`);
  writeFileSync(bunEntrypoint, bunSource);
  const built = await Bun.build({
    entrypoints: [bunEntrypoint],
    compile: { outfile: executable, autoloadDotenv: false, autoloadBunfig: false },
    minify: true,
  });
  if (!built.success) throw new Error(`Windows release fixture ${name} compilation failed.`);
  return new Uint8Array(readFileSync(executable));
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function digest(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
