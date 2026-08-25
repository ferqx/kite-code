import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { projectApprovedProxyEnvironment } from '../src/sandbox/approved-proxy-environment';

const retiredShellModule = ['shell', 'wrapper'].join('-');
const shellWrapperPath = new URL(`../src/sandbox/${retiredShellModule}.ts`, import.meta.url);
const shellPreparationPath = new URL(
  '../src/sandbox/execution/local-shell-preparation.ts',
  import.meta.url,
);
const runtimeFilesystemPath = new URL(
  '../src/sandbox/execution/local-runtime-filesystem.ts',
  import.meta.url,
);
const shellContractPath = new URL('../src/sandbox/shell-contract.ts', import.meta.url);
const shellExecutorPath = new URL('../src/sandbox/shell-executor.ts', import.meta.url);
const preparationAuthorityPath = new URL(
  '../src/sandbox/preparation-authority.ts',
  import.meta.url,
);
const sandboxIndexPath = new URL('../src/sandbox/index.ts', import.meta.url);

function source(path: URL): string {
  return readFileSync(path, 'utf8');
}

describe('Builtin sandbox authority', () => {
  test('has one shell-preparation and runtime-filesystem implementation', () => {
    expect(existsSync(shellWrapperPath)).toBe(false);

    const preparation = source(shellPreparationPath);
    expect(
      preparation.match(
        /export function build(?:UlimitPreamble|HardenedEnv|EnvStripSnippet|EnvExportSnippet)/g,
      ) ?? [],
    ).toHaveLength(4);

    const filesystem = source(runtimeFilesystemPath);
    expect(
      filesystem.match(
        /export function (?:createSandboxRuntimeDirForPreparation|cleanupSandboxRuntimeDirNoSpawn)/g,
      ) ?? [],
    ).toHaveLength(2);

    const index = source(sandboxIndexPath);
    expect(index).not.toContain(`from './${retiredShellModule}'`);
    expect(index).toContain("from './execution/local-shell-preparation'");
    expect(index).toContain("from './execution/local-runtime-filesystem'");
    expect(index).not.toMatch(/\b(?:createSandboxRuntimeDir|cleanupSandboxRuntimeDir)\s*[,}]/);
  });

  test('canonical runtime cleanup never spawns a cleanup process', () => {
    const filesystem = source(runtimeFilesystemPath);
    expect(filesystem).not.toMatch(/Bun\.spawn(?:Sync)?\s*\(/);
    expect(filesystem).not.toContain('node:child_process');
  });

  test('owns the shell compile contract outside Core', () => {
    const contract = source(shellContractPath);
    expect(contract).toContain('export interface ShellInput');
    expect(contract).toContain('export interface ShellResult');
    expect(contract).toContain('export type ShellExecutor');
    expect(contract).toContain('export interface ShellNetworkBroker');
    expect(contract).toContain('export interface SandboxInvocationIdentity');
    expect(contract).toContain('SandboxPreparationLifecycle,');
    expect(source(sandboxIndexPath)).toContain(
      "export type { SandboxPreparationLifecycle } from '@kite-ai/runtime-spi';",
    );
    expect(contract).not.toContain('export interface SandboxPreparationLifecycle');
    expect(contract).not.toMatch(/@\/core|@kite-ai\/runtime-host/);
  });

  test('owns Shell semantics over a generic injected process port', () => {
    const executor = source(shellExecutorPath);
    expect(executor).toContain('export function createBuiltinShellExecutor');
    expect(executor).toContain('ShellProcessPort');
    expect(executor).not.toContain('@kite-ai/runtime-host');
    expect(executor).not.toContain('@/core/');
    expect(executor).not.toMatch(/Bun\.spawn(?:Sync)?\s*\(/);
    expect(executor).not.toContain('node:child_process');

    const contract = source(shellContractPath);
    expect(contract).toContain('export interface ShellProcessPort');
    expect(contract).toContain('readonly processTree: ShellProcessTree');
  });

  test('preparation authority is pure and cannot import Core or Host lifecycle', () => {
    const preparation = source(preparationAuthorityPath);
    expect(preparation).toContain('export function createBuiltinSandboxPreparation');
    expect(preparation).not.toMatch(/@\/core|@kite-ai\/runtime-host/);
    expect(preparation).not.toMatch(/Runtime(?:Event|State)|persistEvents|recordPreparation/);
    expect(preparation).not.toMatch(/Bun\.spawn(?:Sync)?\s*\(/);
  });

  test('projects only ephemeral approved proxy facts', () => {
    const source = {
      HTTP_PROXY: 'http://proxy.example.test:8080',
      NO_PROXY: 'localhost,127.0.0.1',
      PATH: '/workspace/bin',
      OPENAI_API_KEY: 'must-not-cross-the-seam',
    };
    const offline = projectApprovedProxyEnvironment({
      networkMode: 'disabled',
      source,
    });
    const approved = projectApprovedProxyEnvironment({
      networkMode: 'allow_all',
      source,
    });
    expect(offline).toEqual({});
    expect(approved).toEqual({
      HTTP_PROXY: source.HTTP_PROXY,
      NO_PROXY: source.NO_PROXY,
    });
    expect(Object.isFrozen(offline)).toBe(true);
    expect(Object.isFrozen(approved)).toBe(true);
    expect(approved).not.toHaveProperty('PATH');
    expect(approved).not.toHaveProperty('OPENAI_API_KEY');
  });
});
