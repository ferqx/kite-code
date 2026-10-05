import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { UNIFIED_RUNTIME_WORKSPACES } from './unified-test-plan';

const supportedScripts = new Set(['build', 'test', 'typecheck']);
export async function runWorkspaceScript(root: string, args: readonly string[]): Promise<number> {
  const scriptName = args[0];
  if (args.length !== 1 || !scriptName || !supportedScripts.has(scriptName)) {
    console.error('usage: bun run scripts/run-runtime-workspace-script.ts <build|test|typecheck>');
    return 2;
  }

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
    const child = Bun.spawn([process.execPath, 'run', scriptName], {
      cwd: workspaceRoot,
      env: process.env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
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
