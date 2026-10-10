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
  return { directory, offset, denied };
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
      !/^[a-z0-9_][a-z0-9_.-]*\.dll$/.test(name) ||
      name.includes('..') ||
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

/** New owned image only: restrict its existing static import search on Windows 10 RS1+. */
export function sealWindowsSystemImportSearch(
  bytes: Buffer,
  kind: 'console' | 'electron' = 'console',
): Buffer {
  const subsystem = kind === 'electron' ? [2, 3] : 3;
  // Electron's private distribution supplies its own DLLs; all are pinned before launch.
  const flags = kind === 'electron' ? 0xa00 : 0x800;
  const offset = systemImportSearch(bytes, false, subsystem, flags);
  const sealed = Buffer.from(bytes);
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
  const output = join(input.outdir, 'kite.exe');
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
        `/Fo${join(input.outdir, 'terminal-launcher.obj')}`,
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
        cwd: input.outdir,
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
      for (const suffix of ['obj', 'lib', 'exp'])
        rmSync(join(input.outdir, `terminal-launcher.${suffix}`), { force: true });
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
