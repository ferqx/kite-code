import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { retainWindowsCandidateFiles } from '../../packages/agent/src/platform/windows-candidate-files';
import {
  defaultWindowsPathSecurity,
  privateDirectory,
} from '../../packages/agent/src/platform/windows-path-security';

const pendingLauncherBuilds = new Set<object>();

function pe(bytes: Buffer, subsystem: number | readonly number[] = 3) {
  const denied = (): never => {
    throw Error('windows_terminal_launcher_pe_invalid');
  };
  const range = (offset: number, length: number) => {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      offset < 0 ||
      offset + length > bytes.length
    )
      denied();
    return offset;
  };
  range(0, 64);
  const header = bytes.readUInt32LE(60);
  range(header, 24);
  if (
    bytes.toString('ascii', 0, 2) !== 'MZ' ||
    header < 64 ||
    bytes.toString('ascii', header, header + 4) !== 'PE\0\0' ||
    bytes.readUInt16LE(header + 4) !== 0x8664
  )
    denied();
  const count = bytes.readUInt16LE(header + 6);
  const optional = header + 24;
  const optionalSize = bytes.readUInt16LE(header + 20);
  range(optional, optionalSize);
  if (
    count < 1 ||
    count > 96 ||
    optionalSize < 240 ||
    bytes.readUInt16LE(optional) !== 0x20b ||
    !(typeof subsystem === 'number' ? [subsystem] : subsystem).includes(
      bytes.readUInt16LE(optional + 68),
    ) ||
    bytes.readUInt32LE(optional + 108) < 16
  )
    denied();
  const sections = optional + optionalSize;
  range(sections, count * 40);
  const offset = (rva: number, length: number) => {
    for (let i = 0; i < count; i++) {
      const section = sections + i * 40;
      const address = bytes.readUInt32LE(section + 12);
      const size = bytes.readUInt32LE(section + 16);
      if (rva >= address && rva - address + length <= size)
        return range(bytes.readUInt32LE(section + 20) + rva - address, length);
    }
    return denied();
  };
  const directory = (index: number) => ({
    rva: bytes.readUInt32LE(optional + 112 + index * 8),
    size: bytes.readUInt32LE(optional + 116 + index * 8),
  });
  return { directory, offset, denied, range, optional, sections, count };
}

/** Materialize simple RVA-based delay imports in their own retired descriptor storage.
 * IAT addresses, code, section layout, file length and standalone Bun's overlay stay intact.
 */
function importBasename(name: string, kind: 'console' | 'electron') {
  return (
    !name.includes('..') &&
    (/^[a-z0-9_][a-z0-9_.-]*\.dll$/i.test(name) ||
      (kind === 'electron' && ['winspool.drv', 'bthprops.cpl'].includes(name.toLowerCase())))
  );
}
function eagerDelayImports(bytes: Buffer, kind: 'console' | 'electron') {
  const image = pe(bytes, kind === 'electron' ? [2, 3] : 3);
  const delay = image.directory(13);
  if (!delay.rva && !delay.size) return;
  if (!delay.rva || delay.size < 64 || delay.size > 4096 || delay.size % 32) image.denied();
  const regions: { rva: number; virtual: number; raw: number; size: number }[] = [];
  for (let i = 0; i < image.count; i++) {
    const row = image.sections + i * 40;
    const rva = bytes.readUInt32LE(row + 12),
      raw = bytes.readUInt32LE(row + 20),
      size = bytes.readUInt32LE(row + 16),
      virtual = Math.max(size, bytes.readUInt32LE(row + 8));
    if (rva + virtual > 0x100000000) image.denied();
    if (size) {
      image.range(raw, size);
      if (raw < image.sections + image.count * 40) image.denied();
    }
    if (
      regions.some(
        (other) =>
          (virtual &&
            other.virtual &&
            rva < other.rva + other.virtual &&
            other.rva < rva + virtual) ||
          (size && other.size && raw < other.raw + other.size && other.raw < raw + size),
      )
    )
      image.denied();
    regions.push({ rva, virtual, raw, size });
  }
  const storage = image.offset(delay.rva, delay.size);
  // Reusing descriptors must never rewrite code or mutable runtime storage.
  let storageSection = false;
  for (let i = 0; i < image.count; i++) {
    const row = image.sections + i * 40;
    const address = bytes.readUInt32LE(row + 12);
    const length = bytes.readUInt32LE(row + 8);
    if (delay.rva >= address && delay.rva - address + delay.size <= length) {
      const flags = bytes.readUInt32LE(row + 36);
      if ((flags & 0x40000040) !== 0x40000040 || (flags & 0xa0000000) !== 0) image.denied();
      storageSection = true;
    }
  }
  if (!storageSection) image.denied();
  const reads: [number, number][] = [];
  const read = (rva: number, length: number) => {
    const offset = image.offset(rva, length);
    reads.push([offset, offset + length]);
    return offset;
  };
  const name = (rva: number, dll: boolean) => {
    const max = dll ? 256 : 4096;
    let text = '';
    for (let i = 0; i < max; i++) {
      const ch = bytes[read(rva + i, 1)]!;
      if (!ch) {
        if (!text || (dll && !importBasename(text, kind))) image.denied();
        return text.toLowerCase();
      }
      if (ch < 0x21 || ch > 0x7e) image.denied();
      text += String.fromCharCode(ch);
    }
    return image.denied();
  };
  const section = (rva: number, length: number, flag: number) => {
    for (let i = 0; i < image.count; i++) {
      const row = image.sections + i * 40;
      const start = bytes.readUInt32LE(row + 12),
        size = bytes.readUInt32LE(row + 8);
      if (rva >= start && rva - start + length <= size && bytes.readUInt32LE(row + 36) & flag)
        return;
    }
    image.denied();
  };
  const base = bytes.readBigUInt64LE(image.optional + 24);
  const iats: [number, number][] = [];
  const thunks = (lookup: number, iat: number, delayed: boolean) => {
    if (!lookup || !iat || lookup % 8 || iat % 8) image.denied();
    for (let i = 0; i < 4096; i++) {
      const value = bytes.readBigUInt64LE(read(lookup + i * 8, 8));
      const address = bytes.readBigUInt64LE(read(iat + i * 8, 8));
      if (!value) {
        if (!i || address) image.denied();
        const end = iat + (i + 1) * 8;
        if (iats.some(([a, b]) => iat < b && a < end)) image.denied();
        iats.push([iat, end]);
        if (delayed) section(iat, (i + 1) * 8, 0x80000000);
        return;
      }
      if (value & (1n << 63n)) {
        if (value & ~((1n << 63n) | 65535n)) image.denied();
      } else {
        if (value > 0xffffffffn) image.denied();
        read(Number(value), 2);
        name(Number(value) + 2, false);
      }
      if (delayed) {
        if (address < base || address - base > 0xffffffffn) image.denied();
        section(Number(address - base), 1, 0x20000000);
      }
    }
    image.denied();
  };
  const imports = image.directory(1);
  if (!imports.rva || imports.size < 40 || imports.size > 65536) image.denied();
  read(imports.rva, imports.size);
  const records: Buffer[] = [],
    seen = new Set<string>();
  let ended = false;
  for (let i = 0; i < 1024 && i * 20 + 20 <= imports.size; i++) {
    const row = image.offset(imports.rva + i * 20, 20);
    if (bytes.subarray(row, row + 20).every((v) => !v)) {
      ended = true;
      break;
    }
    const dll = name(bytes.readUInt32LE(row + 12), true);
    if (seen.has(dll) || bytes.readUInt32LE(row + 4) || bytes.readUInt32LE(row + 8)) image.denied();
    seen.add(dll);
    const iat = bytes.readUInt32LE(row + 16);
    thunks(bytes.readUInt32LE(row) || iat, iat, false);
    records.push(Buffer.from(bytes.subarray(row, row + 20)));
  }
  if (!ended || !records.length) image.denied();
  ended = false;
  let added = 0;
  for (let i = 0; i < delay.size / 32; i++) {
    const row = storage + i * 32;
    if (bytes.subarray(row, row + 32).every((v) => !v)) {
      if (bytes.subarray(row, storage + delay.size).some((v) => v)) image.denied();
      ended = true;
      break;
    }
    if (
      bytes.readUInt32LE(row) !== 1 ||
      bytes.readUInt32LE(row + 20) ||
      bytes.readUInt32LE(row + 24) ||
      bytes.readUInt32LE(row + 28)
    )
      image.denied();
    const dll = name(bytes.readUInt32LE(row + 4), true);
    if (seen.has(dll)) image.denied();
    seen.add(dll);
    const module = bytes.readUInt32LE(row + 8),
      iat = bytes.readUInt32LE(row + 12),
      lookup = bytes.readUInt32LE(row + 16);
    if (!module || module % 8 || bytes.readBigUInt64LE(read(module, 8))) image.denied();
    section(module, 8, 0x80000000);
    thunks(lookup, iat, true);
    const record = Buffer.alloc(20);
    record.writeUInt32LE(lookup);
    record.writeUInt32LE(bytes.readUInt32LE(row + 4), 12);
    record.writeUInt32LE(iat, 16);
    records.push(record);
    added++;
  }
  const size = (records.length + 1) * 20;
  if (
    !ended ||
    !added ||
    records.length >= 1024 ||
    size > delay.size ||
    reads.some(([a, b]) => a < storage + delay.size && storage < b)
  )
    image.denied();
  // Retired v2 descriptors contain only RVAs. No relocation may rewrite their new role.
  const reloc = image.directory(5);
  if (!!reloc.rva !== !!reloc.size) image.denied();
  for (let at = 0; at < reloc.size; ) {
    const block = image.offset(reloc.rva + at, 8),
      page = bytes.readUInt32LE(block),
      length = bytes.readUInt32LE(block + 4);
    if (length < 8 || length % 2 || at + length > reloc.size) image.denied();
    image.offset(reloc.rva + at, length);
    for (let entry = 8; entry < length; entry += 2) {
      const value = bytes.readUInt16LE(block + entry),
        type = value >>> 12;
      if (!type) continue;
      if (type !== 10 && type !== 3) image.denied();
      const rva = page + (value & 4095),
        width = type === 10 ? 8 : 4;
      if (rva < delay.rva + delay.size && delay.rva < rva + width) image.denied();
    }
    at += length;
  }
  for (let i = 0; i < 16; i++) {
    if ([1, 4, 13].includes(i)) continue;
    const entry = image.directory(i);
    if (entry.size && entry.rva < delay.rva + delay.size && delay.rva < entry.rva + entry.size)
      image.denied();
  }
  bytes.fill(0, storage, storage + delay.size);
  records.forEach((record, index) => {
    record.copy(bytes, storage + index * 20);
  });
  bytes.writeUInt32LE(delay.rva, image.optional + 120);
  bytes.writeUInt32LE(size, image.optional + 124);
  bytes.writeUInt32LE(0, image.optional + 216);
  bytes.writeUInt32LE(0, image.optional + 220);
}

function systemImportSearch(
  bytes: Buffer,
  requireSealed: boolean,
  subsystem: number | readonly number[] = 3,
  flags = 0x800,
): number {
  const image = pe(bytes, subsystem);
  const imports = image.directory(1);
  if (!imports.rva || imports.size < 40 || imports.size > 65536) image.denied();
  image.offset(imports.rva, imports.size);
  let count = 0;
  let ended = false;
  const seen = new Set<string>();
  for (let index = 0; index < 1024 && index * 20 + 20 <= imports.size; index++) {
    const entry = image.offset(imports.rva + index * 20, 20);
    if (bytes.subarray(entry, entry + 20).every((value) => value === 0)) {
      ended = true;
      break;
    }
    const nameRva = bytes.readUInt32LE(entry + 12);
    if (!nameRva || !bytes.readUInt32LE(entry + 16)) image.denied();
    let name = '';
    let complete = false;
    for (let i = 0; i < 256; i++) {
      const value = bytes[image.offset(nameRva + i, 1)]!;
      if (!value) {
        complete = true;
        break;
      }
      if (value < 0x21 || value > 0x7e) image.denied();
      name += String.fromCharCode(value);
    }
    name = name.toLowerCase();
    if (
      !complete ||
      !importBasename(name, flags === 0xa00 ? 'electron' : 'console') ||
      seen.has(name)
    )
      image.denied();
    seen.add(name);
    count++;
  }
  if (!ended || !count) image.denied();
  const delay = image.directory(13);
  if (delay.rva || delay.size) image.denied();
  const config = image.directory(10);
  if (!config.rva || config.size < 80) image.denied();
  const configOffset = image.offset(config.rva, config.size);
  const declaredSize = bytes.readUInt32LE(configOffset);
  if (declaredSize < 80 || declaredSize > config.size) image.denied();
  image.offset(config.rva, declaredSize);
  if (requireSealed && bytes.readUInt16LE(configOffset + 78) !== flags) image.denied();
  return configOffset + 78;
}

/** New owned image only: eager simple RVA imports, then seal static import search. */
export function sealWindowsSystemImportSearch(
  bytes: Buffer,
  kind: 'console' | 'electron' = 'console',
): Buffer {
  const subsystem = kind === 'electron' ? [2, 3] : 3;
  // Electron's private distribution supplies its own DLLs; all are pinned before launch.
  const flags = kind === 'electron' ? 0xa00 : 0x800;
  const sealed = Buffer.from(bytes);
  eagerDelayImports(sealed, kind);
  const offset = systemImportSearch(sealed, false, subsystem, flags);
  sealed.writeUInt16LE(flags, offset);
  systemImportSearch(sealed, true, subsystem, flags);
  return sealed;
}

/** Builder-only CREATE_NEW copy; original runtime/helper bytes and publisher identity are untouched. */
export function copyWindowsSystemExecutable(
  source: string,
  target: string,
  kind: 'console' | 'electron' = 'console',
): void {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('windows_terminal_launcher_platform_unsupported');
  if (
    !isAbsolute(source) ||
    realpathSync(source) !== source ||
    !isAbsolute(target) ||
    existsSync(target)
  )
    throw Error('windows_terminal_launcher_input_invalid');
  const security = defaultWindowsPathSecurity()!;
  const sourcePin = retainWindowsCandidateFiles(dirname(source), [basename(source)]);
  let targetPin: ReturnType<typeof retainWindowsCandidateFiles> | undefined;
  let failure: unknown;
  let failed = false;
  const errors: unknown[] = [];
  try {
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 512 * 1048576)
      throw Error('windows_terminal_launcher_input_invalid');
    const bytes = readFileSync(source);
    if (bytes.length !== stat.size) throw Error('windows_terminal_launcher_content_changed');
    sourcePin.verify();
    const sealed = sealWindowsSystemImportSearch(Buffer.from(bytes), kind);
    security.writePrivateArtifactFile(target, sealed);
    targetPin = retainWindowsCandidateFiles(dirname(target), [basename(target)]);
    security.verifyFile(target);
    const actual = readFileSync(target);
    if (!actual.equals(sealed)) throw Error('windows_terminal_launcher_content_changed');
    systemImportSearch(
      Buffer.from(actual),
      true,
      kind === 'electron' ? [2, 3] : 3,
      kind === 'electron' ? 0xa00 : 0x800,
    );
    targetPin.verify();
    sourcePin.verify();
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    for (const pin of [targetPin, sourcePin]) {
      try {
        pin?.release();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length)
    throw new AggregateError(
      [...(failed ? [failure] : []), ...errors],
      'windows_terminal_launcher_release_failed',
    );
  if (failed) throw failure;
}

/** Bun 1.4.2 copies the compiling process executable's DACL, even with executablePath.
 * Compile inside the qualified private runtime instead of repairing an unsafe output.
 */
export async function compileWindowsVerifier(input: {
  runtime: string;
  entrypoint: string;
  outfile: string;
}): Promise<void> {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('windows_terminal_launcher_platform_unsupported');
  for (const path of [input.runtime, input.entrypoint, input.outfile])
    if (!isAbsolute(path)) throw Error('windows_terminal_launcher_input_invalid');
  if (existsSync(input.outfile)) throw Error('windows_terminal_launcher_input_invalid');
  const pin = retainWindowsCandidateFiles(dirname(input.runtime), [basename(input.runtime)]);
  let failure: unknown;
  let failed = false;
  try {
    systemImportSearch(readFileSync(input.runtime), true);
    const script = `const result=await Bun.build(${JSON.stringify({
      entrypoints: [input.entrypoint],
      target: 'bun',
      packages: 'bundle',
      compile: {
        executablePath: input.runtime,
        outfile: input.outfile,
        autoloadDotenv: false,
        autoloadBunfig: false,
        autoloadTsconfig: false,
        autoloadPackageJson: false,
      },
    })});if(!result.success)throw new AggregateError(result.logs,'windows_verifier_build_failed');`;
    await new Promise<void>((resolve, reject) => {
      execFile(
        input.runtime,
        ['--no-env-file', '--no-clear-screen', '--eval', script],
        {
          cwd: dirname(input.outfile),
          env: {
            PATH: process.env.PATH ?? '',
            SystemRoot: process.env.SystemRoot ?? '',
            TEMP: process.env.TEMP ?? '',
            TMP: process.env.TMP ?? '',
          },
          windowsHide: true,
          timeout: 60000,
          maxBuffer: 1048576,
        },
        (error, _stdout, stderr) => {
          if (error) reject(new Error(`windows_verifier_build_failed:${stderr}`, { cause: error }));
          else resolve();
        },
      );
    });
    pin.verify();
    defaultWindowsPathSecurity()!.verifyFile(input.outfile);
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    pin.release();
  } catch (error) {
    throw new AggregateError(
      [...(failed ? [failure] : []), error],
      'windows_verifier_build_close_unknown',
    );
  }
  if (failed) throw failure;
}

/** Audit the first-stage loader before any of its code can set a DLL search policy. */
function verifyLauncher(bytes: Buffer) {
  const image = pe(bytes);
  const imports = image.directory(1);
  if (!imports.rva || imports.size < 20 || imports.size > 65536) image.denied();
  const allowed = new Set(['kernel32.dll', 'advapi32.dll', 'bcrypt.dll']);
  const seen = new Set<string>();
  let ended = false;
  for (let index = 0; index < 128 && index * 20 + 20 <= imports.size; index++) {
    const entry = image.offset(imports.rva + index * 20, 20);
    if (bytes.subarray(entry, entry + 20).every((value) => value === 0)) {
      ended = true;
      break;
    }
    const nameRva = bytes.readUInt32LE(entry + 12);
    let name = '';
    let complete = false;
    for (let i = 0; i < 128; i++) {
      const ch = bytes[image.offset(nameRva + i, 1)]!;
      if (!ch) {
        complete = true;
        break;
      }
      if (ch < 0x20 || ch > 0x7e) image.denied();
      name += String.fromCharCode(ch);
    }
    name = name.toLowerCase();
    if (!complete || !allowed.has(name) || seen.has(name)) image.denied();
    seen.add(name);
  }
  if (!ended || seen.size !== allowed.size) image.denied();
  const delay = image.directory(13);
  if (delay.rva || delay.size) image.denied();
  const config = image.directory(10);
  if (!config.rva || config.size < 80) image.denied();
  const configOffset = image.offset(config.rva, 80);
  if (bytes.readUInt32LE(configOffset) < 80 || bytes.readUInt16LE(configOffset + 78) !== 0x800)
    image.denied();
}

/** Builder-only trusted helper binding; neither installed launcher discovers a compiler. */
export async function buildWindowsTerminalLauncher(
  input: {
    outdir: string;
    verifierPath: string;
    verifierSha256: string;
    verifierSize: number;
    kind?: 'native';
  },
  compiler = process.env.KITE_WINDOWS_MSVC,
) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('windows_terminal_launcher_platform_unsupported');
  if (!compiler || !isAbsolute(compiler) || realpathSync(compiler) !== compiler)
    throw Error('windows_terminal_launcher_compiler_unavailable');
  if (
    !isAbsolute(input.outdir) ||
    existsSync(input.outdir) ||
    !isAbsolute(input.verifierPath) ||
    realpathSync(input.verifierPath) !== input.verifierPath ||
    !lstatSync(input.verifierPath).isFile() ||
    !/^[0-9a-f]{64}$/.test(input.verifierSha256) ||
    !Number.isSafeInteger(input.verifierSize) ||
    input.verifierSize <= 0 ||
    input.verifierSize > 512 * 1048576
  )
    throw Error('windows_terminal_launcher_input_invalid');
  const verifier = readFileSync(input.verifierPath);
  systemImportSearch(verifier, true);
  if (
    verifier.length !== input.verifierSize ||
    createHash('sha256').update(verifier).digest('hex') !== input.verifierSha256
  )
    throw Error('windows_terminal_launcher_verifier_changed');
  privateDirectory(input.outdir);
  // A copy must not add siblings inside its own pinned, immutable source inventory.
  const compileRoot = join(input.outdir, 'compiler');
  privateDirectory(compileRoot);
  const output = join(compileRoot, 'kite.exe');
  const verifierPin = retainWindowsCandidateFiles(dirname(input.verifierPath), [
    basename(input.verifierPath),
  ]);
  const owner: {
    input: typeof input;
    verifierPin: typeof verifierPin;
    child?: ReturnType<typeof Bun.spawn>;
  } = { input, verifierPin };
  pendingLauncherBuilds.add(owner);
  let succeeded = false;
  let uncertain = false;
  let failure: unknown;
  let failed = false;
  let result:
    | {
        readonly root: string;
        readonly verifierSha256: string;
        readonly verifierSize: number;
        readonly launchers: readonly string[];
      }
    | undefined;
  try {
    const child = Bun.spawn(
      [
        compiler,
        '/nologo',
        '/MT',
        '/std:c++17',
        '/EHsc',
        '/W4',
        '/DUNICODE',
        '/D_UNICODE',
        '/D_WIN32_WINNT=0x0A00',
        ...(input.kind === 'native' ? ['/DKITE_NATIVE_LAUNCHER'] : []),
        `/DKITE_TERMINAL_VERIFIER_SHA256="${input.verifierSha256}"`,
        `/DKITE_TERMINAL_VERIFIER_SIZE=${input.verifierSize}ULL`,
        join(import.meta.dir, 'native/terminal-launcher.cc'),
        `/Fo${join(compileRoot, 'terminal-launcher.obj')}`,
        `/Fe${output}`,
        '/link',
        '/SUBSYSTEM:CONSOLE',
        '/DEPENDENTLOADFLAG:0x800',
        '/DYNAMICBASE',
        '/NXCOMPAT',
        'advapi32.lib',
        'bcrypt.lib',
      ],
      {
        cwd: compileRoot,
        env: {
          ...process.env,
          CL: '',
          _CL_: '',
          LINK: '',
          _LINK_: '',
          NODE_OPTIONS: '',
          NODE_PATH: '',
          BUN_OPTIONS: '',
          ELECTRON_RUN_AS_NODE: '',
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    owner.child = child;
    let timeoutFailure!: (error: unknown) => void;
    const failedTermination = new Promise<never>((_resolve, reject) => {
      timeoutFailure = reject;
    });
    let forced = false;
    const timer = setTimeout(() => {
      forced = true;
      try {
        child.kill('SIGKILL');
      } catch (error) {
        timeoutFailure(error);
      }
    }, 60000);
    let compilerFailure: unknown;
    try {
      const [exit, stdout, stderr] = await Promise.race([
        Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]),
        failedTermination,
      ]);
      if (forced || exit !== 0 || !existsSync(output))
        throw Error(`windows_terminal_launcher_build_failed:${exit}\n${stdout}\n${stderr}`);
    } catch (error) {
      compilerFailure = error;
    }
    clearTimeout(timer);
    if (child.exitCode === null) {
      const errors: unknown[] = compilerFailure ? [compilerFailure] : [];
      try {
        child.kill('SIGKILL');
      } catch (error) {
        errors.push(error);
      }
      let confirmation: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          child.exited,
          new Promise<never>((_resolve, reject) => {
            confirmation = setTimeout(
              () => reject(Error('windows_terminal_launcher_close_unknown')),
              5000,
            );
          }),
        ]);
      } catch (error) {
        uncertain = true;
        throw new AggregateError([...errors, error], 'windows_terminal_launcher_close_unknown');
      } finally {
        if (confirmation) clearTimeout(confirmation);
      }
    }
    if (compilerFailure) throw compilerFailure;
    verifierPin.verify();
    verifyLauncher(readFileSync(output));
    // Do not let a changed builder input become the subsequently installed helper.
    const finalVerifier = readFileSync(input.verifierPath);
    if (
      finalVerifier.length !== input.verifierSize ||
      createHash('sha256').update(finalVerifier).digest('hex') !== input.verifierSha256
    )
      throw Error('windows_terminal_launcher_verifier_changed');
    const security = defaultWindowsPathSecurity()!;
    security.copyPrivateFile(output, join(input.outdir, 'kite.exe'));
    security.copyPrivateFile(output, join(input.outdir, 'kite-tui.exe'));
    if (input.kind === 'native')
      security.copyPrivateFile(output, join(input.outdir, 'kite-desktop.exe'));
    succeeded = true;
    result = Object.freeze({
      root: realpathSync(input.outdir),
      verifierSha256: input.verifierSha256,
      verifierSize: input.verifierSize,
      launchers: Object.freeze(
        input.kind === 'native'
          ? (['kite.exe', 'kite-tui.exe', 'kite-desktop.exe'] as const)
          : (['kite.exe', 'kite-tui.exe'] as const),
      ),
    });
  } catch (error) {
    failed = true;
    failure = error;
    const unknown = (error: unknown): boolean =>
      error instanceof Error &&
      (error.message === 'windows_path_security_denied' ||
        /(?:close|release|acquire).*?(?:unknown|failed)/u.test(error.message) ||
        (error instanceof AggregateError && error.errors.some(unknown)) ||
        unknown(error.cause));
    uncertain ||= unknown(error);
  }
  if (!uncertain) {
    try {
      verifierPin.release();
    } catch (error) {
      throw new AggregateError(
        [...(failed ? [failure] : []), error],
        'windows_terminal_launcher_close_unknown',
      );
    }
    pendingLauncherBuilds.delete(owner);
    try {
      rmSync(compileRoot, { recursive: true, force: true });
      if (!succeeded) rmSync(input.outdir, { recursive: true, force: true });
    } catch (error) {
      throw new AggregateError(
        [...(failed ? [failure] : []), error],
        'windows_terminal_launcher_cleanup_failed',
      );
    }
  }
  if (failed) throw failure;
  return result!;
}
