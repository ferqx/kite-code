import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '#kite-test';
import { windowsTerminalRuntimeArguments } from '../../../apps/service/src/runtime-assets';
import {
  defaultWindowsPathSecurity,
  privateDirectory,
} from '../../../packages/agent/src/platform/windows-path-security';
import { runtimeNativeAsset } from '../../../packages/agent/src/runtime-native';
import {
  compileWindowsNodeVerifier,
  copyWindowsSystemExecutable,
  sealWindowsSystemImportSearch,
} from '../../../scripts/release/build-windows-terminal-launcher';

const probe = `import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {isSea} from 'node:sea';
const db=new DatabaseSync(':memory:');
if(db.prepare('select 42 as value').get().value!==42)throw Error('sqlite');db.close();
if(createHash('sha256').update('probe').digest('hex').length!==64)throw Error('hash');
if(isSea()){
 const path=join(dirname(process.execPath),'runtime-native.node');
 if(createHash('sha256').update(readFileSync(path)).digest('hex')!==__KITE_EMBEDDED_RUNTIME_NATIVE__.sha256)throw Error('addon identity');
 const addon={exports:{}};process.dlopen(addon,path);
 const library=addon.exports.ffiOpen('kernel32.dll');
 try{if(addon.exports.ffiBind(library,'GetCurrentProcessId',[],'u32')()!==process.pid)throw Error('SEA Node-API identity');}
 finally{addon.exports.ffiClose(library);}
}
const server=createServer((_request,response)=>response.end('system32-imports'));
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
try{if(await(await fetch('http://127.0.0.1:'+server.address().port)).text()!=='system32-imports')throw Error('network');}
finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
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
  'real Node and SEA retain private ACLs, code and system imports under DLL shadowing',
  async () => {
    const root = join(realpathSync(tmpdir()), `kite-windows-eager-imports-${randomUUID()}`);
    privateDirectory(root);
    const security = defaultWindowsPathSecurity()!;
    const folders = ['input', 'runtime', 'compile', 'shared', 'standalone', 'cwd'];
    for (const name of folders) privateDirectory(join(root, name));
    const source = readFileSync(process.execPath),
      digest = createHash('sha256').update(source).digest('hex');
    const input = join(root, 'input/node.exe'),
      runtime = join(root, 'runtime/node.exe'),
      compiled = join(root, 'compile/probe.exe'),
      standalone = join(root, 'standalone/probe.exe'),
      entrypoint = join(root, 'compile/probe.mjs'),
      cwd = join(root, 'cwd');
    try {
      security.writePrivateArtifactFile(input, source);
      copyWindowsSystemExecutable(input, runtime);
      const sealed = readFileSync(runtime),
        header = source.readUInt32LE(60) + 24;
      expect(sealed.readUInt32LE(header + 216)).toBe(0);
      expect(sealed.readUInt32LE(header + 220)).toBe(0);
      expect(sealed.length).toBe(source.length);
      expect(sealed.equals(sealWindowsSystemImportSearch(source))).toBe(true);
      // Node's checked system imports must ignore adjacent and CWD copies.
      for (const folder of [join(root, 'runtime'), join(root, 'standalone'), cwd])
        for (const dll of ['dbghelp.dll', 'USERENV.dll', 'IPHLPAPI.dll'])
          security.writePrivateFile(join(folder, dll), Buffer.from('INVALID_SHADOW_DLL'));
      expect(await execute(runtime, ['--version'], cwd)).toBe(process.version);
      expect(
        await execute(
          runtime,
          ['--no-global-search-paths', '--input-type=module', '--eval', probe],
          cwd,
        ),
      ).toBe('WINDOWS_EAGER_IMPORTS_OK');
      security.writePrivateFile(
        entrypoint,
        Buffer.from(
          `if(process.cwd()!==${JSON.stringify(cwd)})throw Error('original_cwd_lost');\n${probe}`,
        ),
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
        join(cwd, '.env'),
        Buffer.from(`NODE_OPTIONS=--import=${JSON.stringify(poison)}\n`),
      );
      security.writePrivateFile(
        join(cwd, 'tsconfig.json'),
        Buffer.from(JSON.stringify({ compilerOptions: { paths: { '*': [poison] } } })),
      );
      expect(
        await execute(runtime, [...windowsTerminalRuntimeArguments(root, 'node'), entrypoint], cwd),
      ).toBe('WINDOWS_EAGER_IMPORTS_OK');
      expect(existsSync(marker)).toBe(false);
      const addon = readFileSync(runtimeNativeAsset());
      const addonSha256 = createHash('sha256').update(addon).digest('hex');
      const standaloneAddon = join(root, 'standalone/runtime-native.node');
      security.writePrivateArtifactFile(standaloneAddon, addon);
      security.verifyFile(standaloneAddon);
      await compileWindowsNodeVerifier({ runtime, addonSha256, entrypoint, outfile: compiled });
      security.verifyFile(compiled);
      const compiledBytes = readFileSync(compiled);
      await expect(
        compileWindowsNodeVerifier({ runtime, addonSha256, entrypoint, outfile: compiled }),
      ).rejects.toThrow('windows_node_verifier_destination_exists');
      expect(readFileSync(compiled).equals(compiledBytes)).toBe(true);
      copyWindowsSystemExecutable(compiled, standalone);
      expect(readFileSync(standalone).length).toBe(compiledBytes.length);
      expect(readFileSync(standalone).equals(sealWindowsSystemImportSearch(compiledBytes))).toBe(
        true,
      );
      // The program must run from its embedded section after the source is gone.
      rmSync(entrypoint);
      expect(await execute(standalone, [], cwd)).toBe('WINDOWS_EAGER_IMPORTS_OK');
      const sharedVerifier = join(root, 'shared/shared-verifier.exe');
      await compileWindowsNodeVerifier({
        runtime,
        addonSha256,
        entrypoint: resolve(
          import.meta.dirname,
          '../../../scripts/release/entrypoints/windows-verifier-main.ts',
        ),
        outfile: sharedVerifier,
      });
      expect(await execute(sharedVerifier, [], cwd, 1)).toBe('windows_shared_verifier_invalid');
      const expectedVerifier = sealWindowsSystemImportSearch(readFileSync(sharedVerifier));
      for (const kind of ['terminal', 'native']) {
        const helper = join(root, `standalone/${kind}-verifier.exe`);
        copyWindowsSystemExecutable(sharedVerifier, helper);
        expect(readFileSync(helper).equals(expectedVerifier)).toBe(true);
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
