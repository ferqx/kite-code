import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import {
  type KiteAppControlClient,
  WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
} from '@kite-ai/kite-app-contract';
import {
  KITE_APP_SERVER_DAEMON_VERSION_,
  kiteAppServerVersion,
} from '@kite-ai/kite-local-runtime/client';
import type { RuntimeProtocolCommand } from '@kite-ai/runtime-protocol';
import type {
  RuntimeServerAdmissionInput,
  RuntimeServerAdmissionPort,
} from '@kite-ai/runtime-server';
import { createKiteSessionAppServerStorageComposition } from './bootstrap';
import type { KiteSessionAppServerStorageOwner } from './bootstrap/kite-session-app-server-storage';
import {
  createNodeRuntimeStdioOutput,
  createProcessRuntimeStdioSignals,
  createRuntimeStdioCarrier,
} from './carrier/runtime-server-stdio';
import {
  createKiteServiceRuntimeComposition,
  type KiteServiceRuntimeComposition,
} from './composition';

export interface KiteAppServerEnvironment {
  readonly runtimeRoot: string;
  readonly configRoot: string;
  readonly osHome: string;
  readonly workspace?: string;
  readonly buildId: string;
}

export interface KiteAppServerMainDependencies {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly createStorage?: (input: {
    readonly databasePath: string;
    readonly hostInstanceId: string;
  }) => KiteSessionAppServerStorageOwner;
  readonly createComposition?: typeof createKiteServiceRuntimeComposition;
  readonly stdin?: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
  readonly stdout?: Parameters<typeof createNodeRuntimeStdioOutput>[0];
  readonly stderr?: { write(message: string): unknown };
  readonly signals?: Parameters<typeof createProcessRuntimeStdioSignals>[0];
}

export interface KiteAppServerRuntimeOwner {
  readonly instanceId: string;
  readonly composition: KiteServiceRuntimeComposition;
  readonly admission: RuntimeServerAdmissionPort;
  readonly appControl: ReturnType<
    KiteServiceRuntimeComposition['appControl']['gateway']['forWorkspace']
  >;
  readonly storageOwner: KiteSessionAppServerStorageOwner;
}

export function resolveKiteAppServerEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): KiteAppServerEnvironment {
  const runtimeRoot = requiredAbsolute(source, 'KITE_CODE_HOME');
  return Object.freeze({
    runtimeRoot,
    configRoot:
      source.KITE_CODE_CONFIG_HOME === undefined
        ? runtimeRoot
        : requiredAbsolute(source, 'KITE_CODE_CONFIG_HOME'),
    osHome: requiredAbsolute(source, process.platform === 'win32' ? 'USERPROFILE' : 'HOME'),
    ...(source.KITE_APP_SERVER_WORKSPACE
      ? { workspace: requiredAbsolute(source, 'KITE_APP_SERVER_WORKSPACE') }
      : {}),
    buildId: required(source, 'KITE_APP_SERVER_BUILD_ID'),
  });
}

export async function runKiteAppServerMain(
  args: readonly string[] = process.argv.slice(2),
  dependencies: KiteAppServerMainDependencies = {},
): Promise<void> {
  if (args.length !== 2 || args[0] !== 'app-server' || args[1] !== 'run-stdio') {
    throw new Error('Kite App Server requires exact `app-server run-stdio` arguments.');
  }
  const environment = resolveKiteAppServerEnvironment(dependencies.environment);
  const owner = createKiteAppServerRuntimeOwner(environment, dependencies);
  const { composition, admission, appControl } = owner;
  const stdin = dependencies.stdin ?? process.stdin;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const signals = dependencies.signals ?? process;
  const carrier = createRuntimeStdioCarrier({
    server: composition.server,
    admission,
    stdin,
    stdout: createNodeRuntimeStdioOutput(stdout),
    stderr,
    signals: createProcessRuntimeStdioSignals(signals),
    history: composition.history,
    appControl,
    credential: composition.appControl.credentialClient,
    shutdownComposition: () => Promise.resolve(composition[Symbol.asyncDispose]()),
  });
  let primaryError: unknown;
  try {
    await carrier.done;
    await carrier.shutdown();
  } catch (error) {
    primaryError = error;
  }
  try {
    await composition[Symbol.asyncDispose]();
  } catch (error) {
    primaryError ??= error;
  }
  if (primaryError !== undefined) throw primaryError;
}

export function createKiteAppServerRuntimeOwner(
  environment: KiteAppServerEnvironment,
  dependencies: Pick<KiteAppServerMainDependencies, 'createStorage' | 'createComposition'> = {},
  options: { readonly daemonProtocol?: boolean; readonly instanceId?: string } = {},
): KiteAppServerRuntimeOwner {
  const instanceId = options.instanceId ?? `app-server_${randomUUID()}`;
  const databasePath = join(environment.runtimeRoot, 'kite-session.sqlite');
  const createStorage =
    dependencies.createStorage ?? ((input) => createKiteSessionAppServerStorageComposition(input));
  const storageOwner = createStorage({ databasePath, hostInstanceId: instanceId });
  const createComposition = dependencies.createComposition ?? createKiteServiceRuntimeComposition;
  let composition: KiteServiceRuntimeComposition;
  try {
    composition = createComposition({
      instanceId,
      runtimeServerVersion: options.daemonProtocol
        ? KITE_APP_SERVER_DAEMON_VERSION_
        : kiteAppServerVersion(environment.buildId),
      appServerProtocol: true,
      ...(options.daemonProtocol ? { appServerDaemonProtocol: true } : {}),
      checkpointPath: databasePath,
      storageOwner,
      ...(environment.workspace ? { workspaces: [{ workspace: environment.workspace }] } : {}),
      userConfigPath: join(environment.configRoot, 'kite-code.jsonc'),
      workspaceTrustStorePath: join(environment.configRoot, 'workspace-trust.jsonc'),
      userMcpConfigPath: join(environment.configRoot, 'mcp.json'),
      mcpApprovalPath: join(environment.configRoot, 'mcp-project-approvals.jsonc'),
      userKiteCodeSkillsDir: join(environment.configRoot, 'skills'),
      userAgentsSkillsDir: join(environment.osHome, '.agents', 'skills'),
    });
  } catch (error) {
    storageOwner.disposeStorage?.();
    throw error;
  }
  const scopedAppControl = () => {
    if (!environment.workspace) throw new Error('Select a Workspace before preparing execution.');
    return composition.appControl.gateway.forWorkspace(
      composition.appControl.admitWorkspace(environment.workspace),
    );
  };
  // Opening the application's Store and History must not resolve a project path, config or Git.
  // Scope is admitted only when an execution-related App operation is actually requested.
  const appControl = Object.freeze<KiteAppControlClient>({
    queryWorkspaceTrust: composition.appControl.gateway.discovery.queryWorkspaceTrust,
    decideWorkspaceTrust: async (request) => scopedAppControl().decideWorkspaceTrust(request),
    getProviderModelSnapshot: async (request) =>
      scopedAppControl().getProviderModelSnapshot(request),
    selectProviderModel: async (request) => scopedAppControl().selectProviderModel(request),
    getMcpSnapshot: async (request) => scopedAppControl().getMcpSnapshot(request),
    applyMcpAction: async (request) => scopedAppControl().applyMcpAction(request),
    getSkillCatalog: async (request) => scopedAppControl().getSkillCatalog(request),
    getExecutionStatus: async (request) => scopedAppControl().getExecutionStatus(request),
    getReleaseStatus: composition.appControl.gateway.discovery.getReleaseStatus,
  });
  const admission: RuntimeServerAdmissionPort = Object.freeze({
    authorize: async (request: RuntimeServerAdmissionInput) => {
      if (
        request.operation === 'initialize' ||
        request.operation === 'runtime/query' ||
        request.operation === 'runtime/subscribe'
      ) {
        // The workspace field is not consumed by reads. No execution is admitted here.
        return {
          allowed: true as const,
          workspace: environment.workspace ?? environment.runtimeRoot,
        };
      }
      if (!environment.workspace)
        return { allowed: false as const, reason: 'unauthorized' as const };
      const command = request.command as RuntimeProtocolCommand | undefined;
      if (command?.type === 'cancel_turn' && storageOwner.ownsSessionExecution(command.sessionId))
        return { allowed: true as const, workspace: environment.workspace };
      const trust = await composition.appControl.gateway.discovery.queryWorkspaceTrust({
        schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
        workspace: environment.workspace,
      });
      if (command && 'sessionId' in command) {
        const result = await composition.runtime.query({
          schema: 'kite.runtime-query.v1',
          type: 'get_session_projection',
          sessionId: command.sessionId,
        });
        if (
          result.status !== 'ok' ||
          result.session?.workspaceDigest !== trust.workspace.workspaceDigest
        )
          return { allowed: false as const, reason: 'unauthorized' as const };
      }
      return trust.status === 'trusted'
        ? { allowed: true as const, workspace: trust.workspace.canonicalPath }
        : { allowed: false as const, reason: 'unauthorized' as const };
    },
  });
  return Object.freeze({ instanceId, composition, admission, appControl, storageOwner });
}

function required(source: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = source[name];
  if (!value || value.length > 4_096 || /\p{Cc}/u.test(value)) {
    throw new Error(`Kite App Server requires ${name}.`);
  }
  return value;
}

function requiredAbsolute(
  source: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = required(source, name);
  if (!isAbsolute(value)) throw new Error(`Kite App Server ${name} must be absolute.`);
  return value;
}
