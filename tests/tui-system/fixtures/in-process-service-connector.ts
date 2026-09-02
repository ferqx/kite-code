import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { McpCredentialStore } from '@kite-ai/builtin-runtime/mcp';
import type { KiteAppServerConnection } from '@kite-ai/kite-local-runtime/client';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import type { RuntimeServerAdmissionPort } from '@kite-ai/runtime-server';
import { createKiteInProcessAppControlComposition } from '#kite-service/app-control';
import {
  createKiteMultiWorkspaceRuntimeServer,
  createKiteRuntimeHistory,
} from '#kite-service/bootstrap';
import type { AppShellExecutor } from '#kite-service/sandbox/composition';

/** Test-only connector: one Service Host/Store owner with an injected synthetic shell. */
export function createInProcessTuiServiceConnector(
  shellExecutor: AppShellExecutor,
  options: { readonly mcpCredentialStore?: McpCredentialStore } = {},
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
      const owner = createKiteMultiWorkspaceRuntimeServer({
        checkpointPath,
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
      const transport: RuntimeClientTransport = Object.freeze({
        connect: async () => {
          const pair = owner.open({ admission });
          return Object.freeze({
            send: (message: RuntimeProtocolMessage) => pair.client.send(message),
            messages: () => pair.client.messages(),
            close: (reason?: string) => pair.client.close(reason),
          });
        },
      });
      const history = createKiteRuntimeHistory(checkpointPath);
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
