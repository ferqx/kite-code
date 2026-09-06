import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { McpCredentialStore } from '@kite-ai/builtin-runtime/mcp';
import type { KiteAppServerConnection } from '@kite-ai/kite-local-runtime/client';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import type { RuntimeServerAdmissionPort } from '@kite-ai/runtime-server';
import { createKiteInProcessAppControlComposition } from '#kite-service/app-control';
import {
  createKiteMultiWorkspaceRuntimeServer,
  createKiteRuntimeObserverHistoryFromStorage,
  createKiteSessionAppServerStorageComposition,
} from '#kite-service/bootstrap';
import type { AppShellExecutor } from '#kite-service/sandbox/composition';
import { sourceKiteSessionStorePath } from '../../../scripts/release/local-service-client';

/**
 * Delivery races that are only meaningful at the PTY boundary.  These hooks
 * wrap the in-process transport owned by this fixture; they never reach the
 * production Runtime or App Server code.
 */
export interface TuiFixtureProtocolDeliveryOptions {
  /** Hold the accepted start_turn response until the matching Run terminal. */
  readonly deferStartTurnReceiptUntilTerminal?: boolean;
  /** Replay matching ephemeral events after Run terminal with a fresh stream sequence. */
  readonly duplicateEphemeralEventMarkersAfterTerminal?: readonly string[];
  /** Replay matching durable events after Run terminal at their original revision. */
  readonly duplicateDurableEventMarkersAfterTerminal?: readonly string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function runtimeCommandType(message: unknown): string | undefined {
  const candidate = record(message);
  const params = record(candidate?.params);
  const command = record(params?.command);
  return typeof command?.type === 'string' ? command.type : undefined;
}

function runtimeRequestId(message: unknown): string | number | null | undefined {
  const candidate = record(message);
  const requestId = candidate?.id;
  return typeof requestId === 'string' || typeof requestId === 'number' || requestId === null
    ? requestId
    : undefined;
}

function subscriptionMessage(message: unknown): Record<string, unknown> | undefined {
  const candidate = record(message);
  if (candidate?.method !== 'runtime/subscription') return undefined;
  const params = record(candidate.params);
  return record(params?.message);
}

function subscriptionEvent(message: Record<string, unknown>): Record<string, unknown> | undefined {
  return record(message.event);
}

function isRunTerminal(message: Record<string, unknown>): boolean {
  return subscriptionEvent(message)?.type === 'run.terminal';
}

function isCommandReceiptResponse(
  message: unknown,
  requestId: string | number | null | undefined,
): boolean {
  if (requestId === undefined || requestId === null) return false;
  const candidate = record(message);
  if (candidate?.id !== requestId || !('result' in candidate)) return false;
  const result = record(candidate.result);
  return typeof result?.status === 'string' && typeof result.commandId === 'string';
}

function eventContainsMarker(event: Record<string, unknown>, markers: readonly string[]): boolean {
  if (markers.length === 0) return false;
  return markers.some((marker) => JSON.stringify(event).includes(marker));
}

function withEphemeralSequence(message: unknown, sequence: number): unknown {
  const candidate = record(message);
  const params = record(candidate?.params);
  const subscription = record(params?.message);
  if (!candidate || !params || !subscription) return message;
  return {
    ...candidate,
    params: { ...params, message: { ...subscription, sequence } },
  };
}

async function* deliverWithFixtureRaces(
  source: AsyncIterable<unknown>,
  options: TuiFixtureProtocolDeliveryOptions,
  state: {
    readonly getStartTurnRequestId: () => string | number | null | undefined;
  },
): AsyncIterable<unknown> {
  let terminalSeen = false;
  let deferredReceipt: unknown;
  const replayAfterTerminal: unknown[] = [];
  let nextReplaySequence = 1_000_000;

  for await (const message of source) {
    const subscription = subscriptionMessage(message);
    const event = subscription ? subscriptionEvent(subscription) : undefined;
    if (
      !terminalSeen &&
      subscription &&
      event &&
      subscription.durability === 'ephemeral' &&
      options.duplicateEphemeralEventMarkersAfterTerminal &&
      eventContainsMarker(event, options.duplicateEphemeralEventMarkersAfterTerminal)
    ) {
      yield message;
      replayAfterTerminal.push(withEphemeralSequence(message, nextReplaySequence++));
      continue;
    }
    if (
      !terminalSeen &&
      subscription &&
      event &&
      subscription.durability === 'durable' &&
      options.duplicateDurableEventMarkersAfterTerminal &&
      eventContainsMarker(event, options.duplicateDurableEventMarkersAfterTerminal)
    ) {
      yield message;
      replayAfterTerminal.push(message);
      continue;
    }
    if (subscription && isRunTerminal(subscription)) {
      terminalSeen = true;
      yield message;
      for (const replay of replayAfterTerminal.splice(0)) yield replay;
      if (deferredReceipt !== undefined) {
        yield deferredReceipt;
        deferredReceipt = undefined;
      }
      continue;
    }

    if (
      options.deferStartTurnReceiptUntilTerminal &&
      !terminalSeen &&
      isCommandReceiptResponse(message, state.getStartTurnRequestId())
    ) {
      deferredReceipt = message;
      continue;
    }

    yield message;
  }

  // Flush only if the server closes before emitting a terminal. This keeps
  // fixture teardown from silently losing an in-flight command response.
  if (deferredReceipt !== undefined) yield deferredReceipt;
}

/** Test-only connector: one Service Host/Store owner with an injected synthetic shell. */
export function createInProcessTuiServiceConnector(
  shellExecutor: AppShellExecutor,
  options: {
    readonly mcpCredentialStore?: McpCredentialStore;
    readonly protocolDelivery?: TuiFixtureProtocolDeliveryOptions;
  } = {},
): Readonly<{
  connect(input: { readonly workspace: string }): Promise<KiteAppServerConnection>;
}> {
  return Object.freeze({
    connect: async ({ workspace }) => {
      const codeRoot = process.env.KITE_CODE_HOME;
      if (!codeRoot) throw new Error('TUI fixture requires an explicit KITE_CODE_HOME.');
      const checkpointPath = join(codeRoot, 'checkpoints.sqlite');
      const appControl = createKiteInProcessAppControlComposition(undefined, {
        checkpointPath,
        userConfigPath: join(codeRoot, 'kite-code.jsonc'),
        workspaceTrustStorePath: join(codeRoot, 'workspace-trust.jsonc'),
        userMcpConfigPath: join(codeRoot, 'mcp.json'),
        mcpApprovalPath: join(codeRoot, 'mcp-project-approvals.jsonc'),
        userKiteCodeSkillsDir: join(codeRoot, 'skills'),
        userAgentsSkillsDir: join(process.env.HOME ?? codeRoot, '.agents', 'skills'),
        shellExecutorForWorkspace: () => shellExecutor,
        ...(options.mcpCredentialStore === undefined
          ? {}
          : { mcpCredentialStoreForWorkspace: () => options.mcpCredentialStore! }),
      });
      const identity = appControl.admitWorkspace(workspace);
      const runtimeInputs = appControl.runtimeInputsFor(identity);
      await runtimeInputs.workspaceReady;
      const repositoryRoot = realpathSync.native(resolve(import.meta.dir, '..', '..', '..'));
      const databasePath = sourceKiteSessionStorePath(codeRoot, repositoryRoot);
      mkdirSync(dirname(databasePath), { recursive: true });
      const storageOwner = createKiteSessionAppServerStorageComposition({
        databasePath,
        hostInstanceId: `tui_fixture_host_${randomUUID()}`,
      });
      const owner = createKiteMultiWorkspaceRuntimeServer({
        checkpointPath,
        storageOwner,
        workspaces: [
          {
            userId: 'tui-system-fixture',
            workspace: identity.canonicalPath,
            config: runtimeInputs.config,
            shellExecutor,
            interactionMode: runtimeInputs.config.interactionMode ?? 'auto',
            sandboxBackend: 'none',
            mcpManager: runtimeInputs.mcpManager,
            skillManifests: runtimeInputs.skillManifests,
            skillOptions: runtimeInputs.skillOptions,
            initialSkillActivations: [],
          },
        ],
      });
      const admission: RuntimeServerAdmissionPort = Object.freeze({
        authorize: async () => ({ allowed: true as const, workspace: identity.canonicalPath }),
      });
      let startTurnRequestId: string | number | null | undefined;
      const transport: RuntimeClientTransport = Object.freeze({
        connect: async () => {
          const pair = owner.open({ admission });
          return Object.freeze({
            send: (message: RuntimeProtocolMessage) => {
              if (runtimeCommandType(message) === 'start_turn') {
                startTurnRequestId = runtimeRequestId(message);
              }
              return pair.client.send(message);
            },
            messages: () =>
              deliverWithFixtureRaces(pair.client.messages(), options.protocolDelivery ?? {}, {
                getStartTurnRequestId: () => startTurnRequestId,
              }),
            close: (reason?: string) => pair.client.close(reason),
          });
        },
      });
      const history = createKiteRuntimeObserverHistoryFromStorage(owner.storage);
      const runtime = new RuntimeClient({
        transport,
        history,
        clientInfo: {
          name: 'tui-system-fixture',
          version: '1',
          instanceId: `tui_fixture_${randomUUID()}`,
        },
      });
      let closed = false;
      const close = async (reason = 'tui_fixture_closed') => {
        if (closed) return;
        closed = true;
        try {
          await runtime.close(reason);
        } finally {
          try {
            await owner[Symbol.asyncDispose]();
          } finally {
            await appControl[Symbol.asyncDispose]();
          }
        }
      };
      return Object.freeze({
        runtime,
        history,
        app: appControl.gateway.forWorkspace(identity),
        credential: appControl.credentialClient,
        get status() {
          return closed
            ? ('closed' as const)
            : runtime.snapshotStore.getSnapshot().status === 'active'
              ? ('active' as const)
              : ('disconnected' as const);
        },
        get generation() {
          return runtime.snapshotStore.getSnapshot().connectionGeneration;
        },
        snapshotStore: runtime.snapshotStore,
        subscribe: (listener: () => void) => runtime.snapshotStore.subscribe(listener),
        prepareAppControl: async () => undefined,
        connect: async () => runtime.connect(),
        reconnect: async () => runtime.reconnect(),
        close,
        [Symbol.asyncDispose]: close,
      }) satisfies KiteAppServerConnection;
    },
  });
}
