import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { windowsTerminalRuntimeArguments } from '../../../apps/service/src/runtime-assets';
import {
  defaultWindowsPathSecurity,
  privateDirectory,
} from '../../../packages/agent/src/platform/windows-path-security';
import {
  compileWindowsVerifier,
  copyWindowsSystemExecutable,
  sealWindowsSystemImportSearch,
} from '../../../scripts/release/build-windows-terminal-launcher';

const probe = `import {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
const db=new Database(':memory:');
if(db.query('select 42 as value').get().value!==42)throw Error('sqlite');db.close();
if(createHash('sha256').update('probe').digest('hex').length!==64)throw Error('hash');
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('system32-imports')});
try{if(await(await fetch(server.url)).text()!=='system32-imports')throw Error('network');}finally{await server.stop(true);}
console.log('WINDOWS_EAGER_IMPORTS_OK');`;

function execute(
  executable: string,
  args: string[],
  cwd: string,
  expectedCode = 0,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        cwd,
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 1048576,
        env: { SystemRoot: process.env.SystemRoot ?? '', PATH: cwd },
      },
      (error, stdout, stderr) => {
        if (
          expectedCode === 0
            ? !!error || stderr !== ''
            : error?.code !== expectedCode || error.killed || error.signal
        )
          reject(new Error(stderr, { cause: error }));
        else resolve(expectedCode ? stderr.trim() : stdout.trim());
      },
    );
  });
}

test.skipIf(process.platform !== 'win32' || process.arch !== 'x64')(
  'real Bun and standalone compilation retain private ACLs, code and imports under DLL shadowing',
  async () => {
    const root = join(realpathSync(tmpdir()), `kite-windows-eager-imports-${randomUUID()}`);
    privateDirectory(root);
    const security = defaultWindowsPathSecurity()!;
    const folders = ['input', 'runtime', 'compile', 'standalone', 'cwd'];
    for (const name of folders) privateDirectory(join(root, name));
    const source = readFileSync(process.execPath),
      digest = createHash('sha256').update(source).digest('hex');
    const input = join(root, 'input/bun.exe'),
      runtime = join(root, 'runtime/bun.exe'),
      compiled = join(root, 'compile/probe.exe'),
      standalone = join(root, 'standalone/probe.exe'),
      entrypoint = join(root, 'compile/probe.ts'),
      cwd = join(root, 'cwd');
    try {
      security.writePrivateArtifactFile(input, source);
      await expect(
        compileWindowsVerifier({ runtime: input, entrypoint, outfile: compiled }),
      ).rejects.toThrow('windows_terminal_launcher_pe_invalid');
      expect(existsSync(compiled)).toBe(false);
      copyWindowsSystemExecutable(input, runtime);
      const sealed = readFileSync(runtime),
        header = source.readUInt32LE(60) + 24;
      if (['1.4.2', '1.4.3'].includes(Bun.version))
        expect(source.readUInt32LE(header + 216)).toBeGreaterThan(0);
      expect(sealed.readUInt32LE(header + 216)).toBe(0);
      expect(sealed.readUInt32LE(header + 220)).toBe(0);
      expect(sealed.length).toBe(source.length);
      expect(sealed.equals(sealWindowsSystemImportSearch(source))).toBe(true);
      // These are real Bun delay dependencies, and are not KnownDLLs.
      for (const folder of [join(root, 'runtime'), join(root, 'standalone'), cwd])
        for (const dll of ['dbghelp.dll', 'USERENV.dll'])
          security.writePrivateFile(join(folder, dll), Buffer.from('INVALID_SHADOW_DLL'));
      expect(await execute(runtime, ['--version'], cwd)).toBe(Bun.version);
      expect(await execute(runtime, ['--no-env-file', '--eval', probe], cwd)).toBe(
        'WINDOWS_EAGER_IMPORTS_OK',
      );
      security.writePrivateFile(
        entrypoint,
        Buffer.from(
          `if(process.cwd()!==${JSON.stringify(cwd)})throw Error('original_cwd_lost');\n${probe}`,
        ),
      );
      // Bun's optional --config value must use '='. A separate value is executed
      // as the entrypoint and can silently exit 0 without running our application.
      security.writePrivateFile(
        join(root, 'runtime/windows-bunfig.toml'),
        Buffer.from('preload = []\n'),
      );
      security.writePrivateFile(
        join(root, 'runtime/windows-tsconfig.json'),
        Buffer.from('{"compilerOptions":{"paths":{}}}\n'),
      );
      const poison = join(cwd, 'poison.mjs'),
        marker = join(cwd, 'poison-ran');
      security.writePrivateFile(
        poison,
        Buffer.from(
          `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'bad');throw Error('CWD_PRELOAD_EXECUTED');`,
        ),
      );
      security.writePrivateFile(
        join(cwd, 'bunfig.toml'),
        Buffer.from(`preload = [${JSON.stringify(poison)}]\n`),
      );
      security.writePrivateFile(
        join(cwd, 'tsconfig.json'),
        Buffer.from(JSON.stringify({ compilerOptions: { paths: { '*': [poison] } } })),
      );
      expect(
        await execute(runtime, [...windowsTerminalRuntimeArguments(root), entrypoint], cwd),
      ).toBe('WINDOWS_EAGER_IMPORTS_OK');
      expect(existsSync(marker)).toBe(false);
      await compileWindowsVerifier({ runtime, entrypoint, outfile: compiled });
      security.verifyFile(compiled);
      const compiledBytes = readFileSync(compiled);
      await expect(
        compileWindowsVerifier({ runtime, entrypoint, outfile: compiled }),
      ).rejects.toThrow('windows_terminal_launcher_input_invalid');
      expect(readFileSync(compiled).equals(compiledBytes)).toBe(true);
      copyWindowsSystemExecutable(compiled, standalone);
      expect(readFileSync(standalone).length).toBe(compiledBytes.length);
      expect(readFileSync(standalone).equals(sealWindowsSystemImportSearch(compiledBytes))).toBe(
        true,
      );
      // The program must run from its embedded section after the source is gone.
      rmSync(entrypoint);
      expect(await execute(standalone, [], cwd)).toBe('WINDOWS_EAGER_IMPORTS_OK');
      for (const kind of ['terminal', 'native']) {
        const helper = join(root, `compile/${kind}-verifier.exe`);
        await compileWindowsVerifier({
          runtime,
          entrypoint: resolve(
            import.meta.dir,
            `../../../scripts/release/entrypoints/windows-${kind}-verifier-main.ts`,
          ),
          outfile: helper,
        });
        expect(await execute(helper, [], cwd, 1)).toBe(`${kind}_windows_frontdoor_invalid`);
      }
      expect(createHash('sha256').update(readFileSync(input)).digest('hex')).toBe(digest);
      expect(createHash('sha256').update(readFileSync(process.execPath)).digest('hex')).toBe(
        digest,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  90000,
);
