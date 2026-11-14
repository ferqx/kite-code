import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { spawn as spawnProcess } from './tooling/process';
import { UNIFIED_RUNTIME_WORKSPACES } from './unified-test-plan';

const supportedScripts = new Set(['build', 'test', 'typecheck']);
export async function runWorkspaceScript(root: string, args: readonly string[]): Promise<number> {
  const scriptName = args[0];
  if (args.length !== 1 || !scriptName || !supportedScripts.has(scriptName)) {
    console.error('usage: bun run build|test|typecheck');
    return 2;
  }

  const env = { ...process.env };
  const bun = process.versions.bun ? process.execPath : 'bun';
  if (!process.versions.bun)
    env.PATH = [dirname(process.execPath), env.PATH].filter(Boolean).join(delimiter);
  delete env.BUN_BE_BUN;
  delete env.BUN_OPTIONS;
  for (const workspace of UNIFIED_RUNTIME_WORKSPACES) {
    const workspaceRoot = join(root, workspace);
    const packageJsonPath = join(workspaceRoot, 'package.json');
    if (!existsSync(packageJsonPath)) {
      console.error(`[workspace:${workspace}] missing package.json`);
      return 1;
    }

    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    if (!packageJson.scripts?.[scriptName]) {
      console.error(`[workspace:${workspace}] missing script ${scriptName}`);
      return 1;
    }

    console.log(`\n[workspace:${packageJson.name ?? workspace}] ${scriptName}`);
    const child = spawnProcess(
      [bun, 'run', '--no-config', '--no-env-file', '--no-install', scriptName],
      {
        cwd: workspaceRoot,
        env,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    const exitCode = await child.exited;
    if (exitCode !== 0) return exitCode;
  }

  console.log(
    `\n[workspace] ${scriptName} passed for ${UNIFIED_RUNTIME_WORKSPACES.length} workspaces`,
  );

  return 0;
}

if (import.meta.main)
  process.exitCode = await runWorkspaceScript(process.cwd(), process.argv.slice(2));
