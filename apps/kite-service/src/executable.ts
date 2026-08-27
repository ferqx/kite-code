#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import { closeSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createKiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';
import {
  isMcpStdioWrapperInvocation,
  MCP_STDIO_WRAPPER_ENTRYPOINT_,
  runMcpStdioChildRuntime,
  runPosixSupervisorChild,
} from '@kite-ai/runtime-host';
import { createKiteServiceRuntimeComposition } from './composition';
import type {
  KiteRuntimeApplicationPort,
  KiteServiceReadinessPort,
  KiteServiceShell,
  KiteServiceSignalPort,
  KiteServiceStatePort,
  KiteServiceTransportPort,
} from './ports';
import { createKiteServiceShell } from './shell';
import { createProcessSignalPort } from './signals';

/** Internal executable input. Runtime/Application ownership is always supplied by the caller. */
export interface KiteServiceExecutableOptions {
  readonly application: KiteRuntimeApplicationPort;
  readonly state: KiteServiceStatePort;
  readonly transport: KiteServiceTransportPort;
  readonly readiness?: KiteServiceReadinessPort;
  readonly signals?: KiteServiceSignalPort;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

export function createKiteServiceExecutable(
  options: KiteServiceExecutableOptions,
): KiteServiceShell {
  return createKiteServiceShell({
    ...options,
    signals: options.signals ?? createProcessSignalPort(),
  });
}

/**
 * Run the internal foreground child until SIGINT/SIGTERM. No default Runtime Application is
 * constructed here: the later composition tranche supplies the sole Host/Store owner.
 */
export async function runKiteService(options: KiteServiceExecutableOptions): Promise<void> {
  const shell = createKiteServiceExecutable(options);
  await shell.start();
  const result = await shell.waitForShutdown();
  if (result.outcome !== 'applied') {
    throw new Error(result.diagnostic ?? 'Service shutdown failed.');
  }
}

export interface KiteServiceMainDependencies {
  /** Manager-provided explicit child environment; defaults to the process environment at entry. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Test seam for the otherwise concrete Service composition. */
  readonly createComposition?: typeof createKiteServiceRuntimeComposition;
}

export interface KiteServiceMainEnvironment {
  readonly codeRoot: string;
  readonly osHome: string;
  readonly buildId: string;
  readonly readinessFd?: string;
}

export function resolveKiteServiceMainEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): KiteServiceMainEnvironment {
  const codeRoot = requiredAbsoluteEnvironmentValue(source, 'KITE_CODE_HOME');
  const osHome = requiredAbsoluteEnvironmentValue(
    source,
    process.platform === 'win32' ? 'USERPROFILE' : 'HOME',
  );
  const buildId = requiredEnvironmentValue(source, 'KITE_SERVICE_BUILD_ID');
  return Object.freeze({
    codeRoot,
    osHome,
    buildId,
    ...(source.KITE_SERVICE_READINESS_FD === undefined
      ? {}
      : { readinessFd: source.KITE_SERVICE_READINESS_FD }),
  });
}

/**
 * Internal foreground entry used by the managed Service child.  The concrete composition is
 * neutral at startup; Workspace configuration is resolved only after Trust/connection admission.
 * Readiness is written to the dedicated fd supplied by the manager, never to stdout.
 */
export async function runKiteServiceMain(
  args: readonly string[] = process.argv.slice(2),
  dependencies: KiteServiceMainDependencies = {},
): Promise<void> {
  if (isKiteServiceMcpStdioInvocation(args)) {
    await runMcpStdioChildRuntime([MCP_STDIO_WRAPPER_ENTRYPOINT_]);
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
  if (args.length !== 2 || args[0] !== 'service' || args[1] !== 'run') {
    throw new Error('Kite Service internal entry requires the exact `service run` arguments.');
  }
  // These values are supplied by the manager's explicit, neutral child environment.  Do not
  // derive Service identity from cwd, homedir(), Workspace files, or a missing ambient variable.
  const environment = resolveKiteServiceMainEnvironment(dependencies.environment);
  const createComposition = dependencies.createComposition ?? createKiteServiceRuntimeComposition;
  const instanceId = `service_${randomUUID()}`;
  const composition = createComposition({
    instanceId,
    checkpointPath: join(environment.codeRoot, 'checkpoints.sqlite'),
    userConfigPath: join(environment.codeRoot, 'kite-code.jsonc'),
    workspaceTrustStorePath: join(environment.codeRoot, 'workspace-trust.jsonc'),
    userMcpConfigPath: join(environment.codeRoot, 'mcp.json'),
    mcpApprovalPath: join(environment.codeRoot, 'mcp-project-approvals.jsonc'),
    userKiteCodeSkillsDir: join(environment.codeRoot, 'skills'),
    userAgentsSkillsDir: join(environment.osHome, '.agents', 'skills'),
  });
  const readinessFd = environment.readinessFd;
  const readiness =
    readinessFd === undefined
      ? undefined
      : createProcessReadinessPort(instanceId, Number(readinessFd));
  const infrastructure = composition.createInfrastructure({
    home: createKiteHomeIdentity(environment.codeRoot, 'explicit_argument'),
    instanceId,
    serverVersion: 'kite-service-v1',
    buildId: environment.buildId,
    ...(readiness === undefined ? {} : { readiness }),
  });
  try {
    const started = await infrastructure.start();
    if (started.outcome !== 'applied') {
      throw new Error(started.diagnostic ?? 'Service startup failed.');
    }
    const stopped = await infrastructure.shell.waitForShutdown();
    if (stopped.outcome !== 'applied') {
      throw new Error(stopped.diagnostic ?? 'Service shutdown failed.');
    }
  } finally {
    await infrastructure[Symbol.asyncDispose]();
    await composition[Symbol.asyncDispose]();
  }
}

/** Bun standalone uses a platform-specific argv prefix; private markers are validated at either seam. */
export function isKiteServiceMcpStdioInvocation(
  args: readonly string[],
  processArguments: readonly string[] = process.argv,
): boolean {
  return isMcpStdioWrapperInvocation(args) || isMcpStdioWrapperInvocation(processArguments);
}

function requiredEnvironmentValue(
  source: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = source[name];
  if (value === undefined || value.length === 0 || /\p{Cc}/u.test(value)) {
    throw new Error(`Kite Service requires explicit ${name}.`);
  }
  return value;
}

function requiredAbsoluteEnvironmentValue(
  source: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = requiredEnvironmentValue(source, name);
  if (!value.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(value)) {
    throw new Error(`Kite Service ${name} must be an absolute path.`);
  }
  return value;
}

function createProcessReadinessPort(instanceId: string, fd: number): KiteServiceReadinessPort {
  let published = false;
  return {
    publish(event) {
      if (published || event.state !== 'ready') return;
      if (!Number.isSafeInteger(fd) || fd < 0) {
        throw new TypeError('Service readiness fd is invalid.');
      }
      writeSync(fd, `${JSON.stringify({ instanceId })}\n`);
      closeSync(fd);
      published = true;
    },
  };
}

if (import.meta.main) {
  runKiteServiceMain().catch((error: unknown) => {
    process.stderr.write(
      `[kite-service] ${error instanceof Error ? error.message : 'service failed'}\n`,
    );
    process.exitCode = 1;
  });
}
