#!/usr/bin/env bun
import {
  isMcpStdioWrapperInvocation,
  MCP_STDIO_WRAPPER_ENTRYPOINT_,
  runMcpStdioChildRuntime,
  runPosixSupervisorChild,
  runProcessTreeChild,
} from '@kite-ai/runtime-host';
import { runKiteAppServerMain } from './app-server';
import { runKiteAppServerDaemonMain } from './app-server-daemon';
export interface KiteServiceMainDependencies {
  /** Parent-provided explicit child environment; defaults to the process environment at entry. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/**
 * Internal executable router. Public clients reach App Server entrypoints through their parent
 * composition; the remaining markers are private MCP/process-tree helpers.
 */
export async function runKiteServiceMain(
  args: readonly string[] = process.argv.slice(2),
  dependencies: KiteServiceMainDependencies = {},
): Promise<void> {
  if (isKiteServiceMcpStdioInvocation(args)) {
    await runMcpStdioChildRuntime([MCP_STDIO_WRAPPER_ENTRYPOINT_]);
    return;
  }
  if (args[0] === 'app-server') {
    if (args[1] === 'run-daemon') {
      await runKiteAppServerDaemonMain(args, { environment: dependencies.environment });
    } else {
      await runKiteAppServerMain(args, { environment: dependencies.environment });
    }
    return;
  }
  if (args.length === 1 && args[0] === '--kite-internal-process-tree-v1') {
    runProcessTreeChild([]);
    return;
  }
  const posixSupervisorMarker = '--kite-internal-posix-supervisor-v1';
  if (
    args[0] === posixSupervisorMarker &&
    !args.slice(1).some((argument) => argument.startsWith('--kite-internal-'))
  ) {
    runPosixSupervisorChild(args.slice(1));
    return;
  }
  throw new Error('Unsupported Kite Service internal entrypoint.');
}

/** Bun standalone uses a platform-specific argv prefix; private markers are validated at either seam. */
export function isKiteServiceMcpStdioInvocation(
  args: readonly string[],
  processArguments: readonly string[] = process.argv,
): boolean {
  return isMcpStdioWrapperInvocation(args) || isMcpStdioWrapperInvocation(processArguments);
}

if (import.meta.main) {
  await runKiteServiceMain().catch((error: unknown) => {
    process.stderr.write(
      `[kite-service] ${error instanceof Error ? error.message : 'service failed'}\n`,
    );
    process.exitCode = 1;
  });
}
