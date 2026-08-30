import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKSPACES = [
  'packages/agent-api-contract',
  'packages/runtime-contract',
  'packages/runtime-protocol',
  'packages/runtime-server',
  'packages/runtime-client',
  'packages/kite-app-contract',
  'packages/kite-local-runtime',
  'packages/agent-kernel',
  'packages/runtime-spi',
  'packages/runtime-host',
  'packages/runtime-storage-sqlite',
  'packages/builtin-runtime',
  'apps/kite-cli',
  'apps/kite-service',
  'apps/kite-web',
] as const;

const supportedScripts = new Set(['build', 'test', 'typecheck']);
const scriptName = process.argv[2];
if (!scriptName || !supportedScripts.has(scriptName)) {
  console.error('usage: bun run scripts/run-runtime-workspace-script.ts <build|test|typecheck>');
  process.exit(2);
}

for (const workspace of WORKSPACES) {
  const workspaceRoot = join(process.cwd(), workspace);
  const packageJsonPath = join(workspaceRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    console.error(`[workspace:${workspace}] missing package.json`);
    process.exit(1);
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    name?: string;
    scripts?: Record<string, string>;
  };
  if (!packageJson.scripts?.[scriptName]) {
    console.error(`[workspace:${workspace}] missing script ${scriptName}`);
    process.exit(1);
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
  if (exitCode !== 0) process.exit(exitCode);
}

console.log(`\n[workspace] ${scriptName} passed for ${WORKSPACES.length} workspaces`);
