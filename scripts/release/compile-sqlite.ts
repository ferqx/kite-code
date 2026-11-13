import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

/** Compile the reviewed amalgamation supplied by the release input verifier. */
export function compileSqlite(source: string, output: string) {
  const windows = process.platform === 'win32';
  const mac = process.platform === 'darwin';
  const definitions = ['SQLITE_THREADSAFE=1', 'SQLITE_OMIT_LOAD_EXTENSION', 'SQLITE_ENABLE_FTS5'];
  const arguments_ = windows
    ? [
        '/nologo',
        '/O2',
        '/LD',
        '/MT',
        ...definitions.map((value) => `/D${value}`),
        '/DSQLITE_API=__declspec(dllexport)',
        `/Fo${join(dirname(output), 'sqlite3.obj')}`,
        `/Fe${output}`,
        join(source, 'sqlite3.c'),
        '/link',
        '/DEPENDENTLOADFLAG:0x800',
        `/IMPLIB:${join(dirname(output), 'sqlite3.lib')}`,
      ]
    : [
        '-O2',
        '-fPIC',
        ...(mac ? ['-dynamiclib', '-mmacosx-version-min=12.0'] : ['-shared']),
        ...definitions.map((value) => `-D${value}`),
        join(source, 'sqlite3.c'),
        '-o',
        output,
        '-lm',
        ...(mac ? [] : ['-pthread']),
      ];
  const compiler = windows ? process.env.KITE_WINDOWS_MSVC : mac ? '/usr/bin/clang' : 'cc';
  if (!compiler) throw Error('sqlite_release_compiler_unavailable');
  const env = { ...process.env };
  if (windows)
    for (const key of Object.keys(env))
      if (['CL', '_CL_', 'LINK', '_LINK_'].includes(key.toUpperCase())) delete env[key];
  const result = spawnSync(compiler, arguments_, {
    cwd: dirname(output),
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw Error('sqlite_release_compile_failed', { cause: result.error });
  return output;
}

export function sqliteLibraryBasename(platform: string) {
  if (platform === 'darwin') return 'libsqlite3.dylib';
  if (platform === 'linux') return 'libsqlite3.so';
  if (platform === 'win32') return 'sqlite3.dll';
  throw Error('sqlite_release_target_unsupported');
}
