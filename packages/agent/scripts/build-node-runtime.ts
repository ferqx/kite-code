import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../native/runtime/', import.meta.url));
const target = process.platform;

function buildTool(args: string[], cwd: string) {
  const [command, ...parameters] = args;
  const result = spawnSync(command!, parameters, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
    ...(target === 'win32'
      ? { env: { ...process.env, CL: '', _CL_: '', LINK: '', _LINK_: '' } }
      : {}),
  });
  if (result.status !== 0) throw Error('native_node_runtime_build_failed', { cause: result.error });
}

function suppliedFile(value: string | undefined, name: string) {
  if (!value || !isAbsolute(value) || !existsSync(value)) throw Error(name);
  return value;
}

function build(outdir: string) {
  if (
    !['darwin', 'linux', 'win32'].includes(target) ||
    !['x64', 'arm64'].includes(process.arch) ||
    (target === 'win32' && process.arch !== 'x64')
  )
    throw Error('native_node_runtime_build_unsupported');
  const headers = suppliedFile(
    process.env.KITE_RELEASE_NODE_HEADERS,
    'native_node_headers_required',
  );
  suppliedFile(join(headers, 'node_api.h'), 'native_node_headers_required');
  const sqliteHeaders = process.env.KITE_RELEASE_SQLITE_HEADERS;
  if (sqliteHeaders) {
    suppliedFile(sqliteHeaders, 'native_sqlite_headers_required');
    suppliedFile(join(sqliteHeaders, 'sqlite3.h'), 'native_sqlite_headers_required');
  } else if (target !== 'darwin') {
    throw Error('native_sqlite_headers_required');
  }

  mkdirSync(outdir, { recursive: true });
  const work = mkdtempSync(join(outdir, '.runtime-native-'));
  const output = join(work, 'runtime-native.node');
  const sources = ['index.cc', 'ffi.cc', 'sqlite.cc'].map((name) => join(source, name));
  try {
    if (target === 'win32') {
      const compiler = suppliedFile(process.env.KITE_WINDOWS_MSVC, 'native_msvc_required');
      const nodeLibrary = suppliedFile(
        process.env.KITE_RELEASE_NODE_LIBRARY,
        'native_node_library_required',
      );
      buildTool(
        [
          compiler,
          '/nologo',
          '/LD',
          '/O2',
          '/MT',
          '/std:c++17',
          '/EHsc',
          '/utf-8',
          '/DNAPI_VERSION=8',
          '/D_WIN32_WINNT=0x0A00',
          `/I${headers}`,
          `/I${sqliteHeaders}`,
          ...sources,
          join(source, 'windows-node.cc'),
          '/link',
          '/MACHINE:X64',
          '/DEPENDENTLOADFLAG:0x800',
          '/DYNAMICBASE',
          '/NXCOMPAT',
          `/OUT:${output}`,
          '/DELAYLOAD:node.exe',
          nodeLibrary,
          'delayimp.lib',
        ],
        work,
      );
    } else {
      const mac = target === 'darwin';
      let ffiLibrary = '-lffi';
      if (!mac) {
        const libdir = spawnSync('pkg-config', ['--variable=libdir', 'libffi'], {
          encoding: 'utf8',
        });
        if (libdir.status !== 0)
          throw Error('native_libffi_development_required', { cause: libdir.error });
        ffiLibrary = suppliedFile(
          join(libdir.stdout.trim(), 'libffi.a'),
          'native_libffi_static_required',
        );
      }
      buildTool(
        [
          mac ? '/usr/bin/clang++' : 'c++',
          '-std=c++17',
          '-O2',
          '-fvisibility=hidden',
          ...(mac
            ? ['-dynamiclib', '-undefined', 'dynamic_lookup', '-mmacosx-version-min=12.0']
            : ['-shared', '-fPIC', '-pthread', '-Wl,--exclude-libs,ALL']),
          '-DNAPI_VERSION=8',
          '-I',
          headers,
          ...(sqliteHeaders ? ['-I', sqliteHeaders] : []),
          ...sources,
          ffiLibrary,
          ...(mac ? [] : ['-ldl']),
          '-o',
          output,
        ],
        work,
      );
    }
    renameSync(output, join(outdir, 'runtime-native.node'));
    if (target === 'linux')
      copyFileSync(join(source, 'LICENSE.libffi'), join(outdir, 'LICENSE.libffi'));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const output = resolve(process.argv[2] ?? 'dist');
if (process.env.KITE_RELEASE_NODE_HEADERS) build(output);
else {
  const checkout = fileURLToPath(new URL('../../../', import.meta.url));
  if (output !== resolve(checkout, 'packages/agent/dist'))
    throw Error('native_node_headers_required');
  await (
    await import('../../../scripts/development/prepare-node-runtime')
  ).prepareDevelopmentRuntime(checkout);
}
