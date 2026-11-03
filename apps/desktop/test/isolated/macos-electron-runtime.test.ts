import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  macosElectronResize,
  verifyMacosElectronFramework,
} from '../../electron/macos-electron-resize';
import {
  patchMacosElectronRuntime,
  prepareMacosElectronRuntime,
} from '../../scripts/macos-electron-runtime';

const supported = process.platform === 'darwin' && process.arch === 'arm64';
test.skipIf(!supported)(
  'invalid version, external links and hardlinks fail before copying or patching',
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-resize-reject-')));
    const source = join(root, 'source');
    mkdirSync(source);
    try {
      writeFileSync(join(source, 'version'), '44.3.1');
      expect(() =>
        prepareMacosElectronRuntime({ sourceDist: source, outdir: join(root, 'target') }),
      ).toThrow('runtime_input_invalid');
      writeFileSync(join(source, 'version'), '44.3.0');
      const outside = join(root, 'outside');
      writeFileSync(outside, 'private fixture');
      symlinkSync(outside, join(source, 'external'));
      expect(() =>
        prepareMacosElectronRuntime({ sourceDist: source, outdir: join(root, 'target') }),
      ).toThrow('runtime_input_invalid');
      rmSync(join(source, 'external'));
      linkSync(outside, join(source, 'linked'));
      expect(() =>
        prepareMacosElectronRuntime({ sourceDist: source, outdir: join(root, 'target') }),
      ).toThrow('runtime_input_invalid');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!supported)(
  'real copied Electron receives both patches, signed payload identity, and pre-ready V2 pairing without a UI',
  async () => {
    const require = createRequire(import.meta.url);
    const source = realpathSync(join(dirname(require.resolve('electron/package.json')), 'dist'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-resize-runtime-')));
    const original = readFileSync(join(source, macosElectronResize.framework));
    const originalHash = createHash('sha256').update(original).digest('hex');
    try {
      expect(() => prepareMacosElectronRuntime({ sourceDist: source, outdir: source })).toThrow(
        'runtime_input_invalid',
      );
      expect(() =>
        prepareMacosElectronRuntime({
          sourceDist: source,
          outdir: join(source, 'forbidden-nested'),
        }),
      ).toThrow('runtime_input_invalid');
      const runtime = prepareMacosElectronRuntime({
        sourceDist: source,
        outdir: join(root, 'electron'),
      });
      const patched = readFileSync(join(root, 'electron', macosElectronResize.framework));
      const sourceFramework = lstatSync(join(source, macosElectronResize.framework));
      const copiedFramework = lstatSync(join(root, 'electron', macosElectronResize.framework));
      expect(sourceFramework.nlink).toBe(1);
      expect(copiedFramework.nlink).toBe(1);
      expect(`${copiedFramework.dev}:${copiedFramework.ino}`).not.toBe(
        `${sourceFramework.dev}:${sourceFramework.ino}`,
      );
      expect(runtime.resize.frameworkSha256).toBe(
        createHash('sha256').update(patched).digest('hex'),
      );
      expect(() => verifyMacosElectronFramework(patched, 'patched')).not.toThrow();
      expect(runtime.executable).toBe(join(root, 'electron', macosElectronResize.executable));
      expect(
        createHash('sha256')
          .update(readFileSync(join(source, macosElectronResize.framework)))
          .digest('hex'),
      ).toBe(originalHash);
      expect(() =>
        patchMacosElectronRuntime({ sourceDist: source, targetDist: join(root, 'electron') }),
      ).toThrow('runtime_input_invalid');
      const build = await Bun.build({
        entrypoints: [resolve(import.meta.dir, '../../electron/macos-electron-resize.ts')],
        target: 'node',
        format: 'cjs',
        outdir: root,
        naming: 'resize.cjs',
      });
      expect(build.success).toBe(true);
      const program = `
        const {configureMacosElectronResize}=require(${JSON.stringify(join(root, 'resize.cjs'))});
        const proof=${JSON.stringify(runtime.resize)}, writes=[];
        const app={isReady:()=>false,commandLine:{getSwitchValue:n=>n==='enable-features'?'OtherFeature:parameter/value':'',appendSwitch:(...args)=>writes.push(args)}};
        configureMacosElectronResize(app,proof);
        const failures={};
        for (const [name,configured,value] of [
          ['ready',{...app,isReady:()=>true},proof],
          ['disabled',{...app,commandLine:{...app.commandLine,getSwitchValue:n=>n==='disable-features'?'OtherFeature,CATransactionV2':''}},proof],
          ['badHash',app,{frameworkSha256:'0'.repeat(64)}],
        ]) {try {configureMacosElectronResize(configured,value);failures[name]='accepted';}catch(e){failures[name]=e.message;}}
        const originalReport=process.report.getReport;
        try {process.report.getReport=()=>({sharedObjects:[]});configureMacosElectronResize(app,proof);failures.loaded='accepted';}
        catch(e){failures.loaded=e.message;}
        finally{process.report.getReport=originalReport;}
        console.log(JSON.stringify({writes,failures}));
      `;
      const output = execFileSync(runtime.executable, ['-e', program], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        timeout: 30000,
      });
      expect(JSON.parse(output)).toEqual({
        writes: [['enable-features', 'OtherFeature:parameter/value,CATransactionV2']],
        failures: {
          ready: 'macos_electron_resize_configuration_too_late',
          disabled: 'macos_electron_resize_feature_conflict',
          badHash: 'macos_electron_resize_identity_invalid',
          loaded: 'macos_electron_resize_identity_invalid',
        },
      });
      // A stock binary cannot use a stock-file hash as proof for the paired app.
      const stockProof = { frameworkSha256: originalHash };
      const stockProgram = `const {configureMacosElectronResize}=require(${JSON.stringify(join(root, 'resize.cjs'))});try{configureMacosElectronResize({isReady:()=>false,commandLine:{getSwitchValue:()=>'',appendSwitch(){throw Error('must_not_enable');}}},${JSON.stringify(stockProof)});process.exitCode=2;}catch(e){console.log(e.message);}`;
      expect(
        execFileSync(join(source, macosElectronResize.executable), ['-e', stockProgram], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          encoding: 'utf8',
          timeout: 30000,
        }).trim(),
      ).toBe('macos_electron_resize_identity_invalid');
      // An incomplete copied dist must fail before any Framework mutation.
      const invalid = join(root, 'invalid');
      mkdirSync(invalid);
      copyFileSync(join(source, 'version'), join(invalid, 'version'));
      expect(() => patchMacosElectronRuntime({ sourceDist: source, targetDist: invalid })).toThrow(
        'runtime_input_invalid',
      );
      // A normal copied resource must also remain independent after writes, whether
      // the filesystem used copy-on-write cloning or its fallback copy mechanism.
      const sourceVersion = readFileSync(join(source, 'version'));
      const sourceVersionStat = lstatSync(join(source, 'version'));
      const copiedVersion = join(root, 'electron', 'version');
      const copiedVersionStat = lstatSync(copiedVersion);
      expect(copiedVersionStat.nlink).toBe(1);
      expect(`${copiedVersionStat.dev}:${copiedVersionStat.ino}`).not.toBe(
        `${sourceVersionStat.dev}:${sourceVersionStat.ino}`,
      );
      writeFileSync(copiedVersion, 'independent copy changed');
      expect(readFileSync(copiedVersion, 'utf8')).toBe('independent copy changed');
      expect(readFileSync(join(source, 'version'))).toEqual(sourceVersion);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  120000,
);
