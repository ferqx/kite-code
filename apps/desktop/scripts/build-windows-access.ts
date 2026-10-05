import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const nodeApiHeaderHashes = Object.freeze({
  'node_api.h': 'd14db85d16f182045c42745a6e44b96e932dfe6e3bfcaac7a1096fae8412c579',
  'node_api_types.h': '8d5d854088d5725fec9775510e0aeeeb790a41ad083c49bb721d950b86e6bd61',
  'js_native_api.h': 'c024813df81c100be91fa339b57294fbf5cca3a93b9c91775db9e886dedad114',
  'js_native_api_types.h': '0410c31e227f81e2981363c4d543f4832ac3df785343ec64cee621742ff8a034',
});
export function verifyNodeApiHeaders() {
  const root = join(import.meta.dir, '../native/windows-access');
  for (const [name, hash] of Object.entries(nodeApiHeaderHashes)) {
    if (
      createHash('sha256')
        .update(readFileSync(join(root, 'include', name)))
        .digest('hex') !== hash
    )
      throw Error('windows_access_header_identity_mismatch');
  }
  return root;
}
/** Builder-only compiler selection. Installed Main never discovers or compiles code. */
export async function buildWindowsAccess(outdir: string, compiler = process.env.KITE_WINDOWS_MSVC) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('windows_access_build_platform_unsupported');
  if (!compiler || !isAbsolute(compiler) || realpathSync(compiler) !== compiler)
    throw Error('windows_access_compiler_unavailable');
  const root = verifyNodeApiHeaders();
  const output = join(outdir, 'windows-access.node');
  if (!isAbsolute(outdir) || existsSync(output)) throw Error('windows_access_output_invalid');
  const child = Bun.spawn(
    [
      compiler,
      '/nologo',
      '/LD',
      '/MT',
      '/std:c++17',
      '/EHsc',
      '/W4',
      '/DUNICODE',
      '/D_UNICODE',
      '/D_WIN32_WINNT=0x0A00',
      `/I${join(root, 'include')}`,
      join(root, 'access.cc'),
      `/Fo${join(outdir, 'windows-access.obj')}`,
      '/link',
      'advapi32.lib',
      'bcrypt.lib',
      `/OUT:${output}`,
      `/IMPLIB:${join(outdir, 'windows-access.lib')}`,
    ],
    {
      cwd: outdir,
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', BUN_OPTIONS: '' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exit !== 0 || !existsSync(output))
      throw Error(`windows_access_build_failed:${exit}\n${stdout}\n${stderr}`);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
    for (const extension of ['obj', 'lib', 'exp'])
      rmSync(join(outdir, `windows-access.${extension}`), { force: true });
  }
  const binary = readFileSync(output),
    offset = binary.length >= 64 ? binary.readUInt32LE(60) : -1;
  if (
    binary.toString('ascii', 0, 2) !== 'MZ' ||
    offset < 64 ||
    offset + 24 > binary.length ||
    binary.toString('ascii', offset, offset + 4) !== 'PE\0\0' ||
    binary.readUInt16LE(offset + 4) !== 0x8664
  )
    throw Error('windows_access_binary_identity_invalid');
  writeFileSync(
    join(outdir, 'windows-access.LICENSE'),
    readFileSync(join(root, 'include/LICENSE')),
  );
  return {
    relativePath: 'windows-access.node' as const,
    sha256: createHash('sha256').update(readFileSync(output)).digest('hex'),
  };
}
