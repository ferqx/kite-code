import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProfileSelection } from '@kite-ai/agent/profile';
import { type AgentClient, createClient, type ServerInfo } from '@kite-ai/client';

export class SharedConnectionError extends Error {
  readonly code: string;
  constructor(
    code:
      | 'shared_bootstrap_failed'
      | 'shared_connection_failed'
      | 'shared_workspace_invalid'
      | 'shared_workspace_mismatch'
      | 'shared_connection_aborted',
  ) {
    super(code);
    this.code = code;
  }
}

/** An explicit workspace must select the daemon's original canonical workspace. */
export function assertSharedWorkspace(input: {
  fixedWorkspace: string;
  workspace?: string;
  cwd?: string;
}): string {
  let fixed: string, selected: string | undefined;
  try {
    fixed = realpathSync(input.fixedWorkspace);
    if (fixed !== input.fixedWorkspace || !statSync(fixed).isDirectory())
      throw Error('noncanonical_workspace');
    if (input.workspace !== undefined)
      selected = realpathSync(resolve(input.cwd ?? process.cwd(), input.workspace));
  } catch {
    throw new SharedConnectionError('shared_workspace_invalid');
  }
  if (selected !== undefined && selected !== fixed)
    throw new SharedConnectionError('shared_workspace_mismatch');
  return fixed;
}

export async function connectSharedService(input: {
  profile: ProfileSelection;
  server: string;
  requiredCapabilities: readonly string[];
  workspace?: string;
  cwd?: string;
  signal?: AbortSignal;
}): Promise<{
  mode: 'shared';
  client: AgentClient;
  bootstrap: ServerInfo;
  fixedWorkspace: string;
  close(): Promise<void>;
}> {
  const { signal, server, workspace, cwd } = input;
  const profileAccessKey = input.profile.profileAccessKey;
  const checkAbort = () => {
    if (signal?.aborted) throw new SharedConnectionError('shared_connection_aborted');
  };
  checkAbort();
  const expectedProfile = {
    dataRoot: input.profile.dataRoot,
    name: input.profile.profile,
    accessKey: input.profile.profileAccessKey,
  };
  const capabilities = [...input.requiredCapabilities];
  let native: Awaited<ReturnType<typeof import('@kite-ai/service/daemon').requestDaemonBootstrap>>;
  try {
    // This private native dependency is loaded only after shared mode is selected.
    const { selectDaemonEndpoint, requestDaemonBootstrap } = await import(
      '@kite-ai/service/daemon'
    );
    checkAbort();
    native = await requestDaemonBootstrap(
      selectDaemonEndpoint({
        profileAccessKey,
        explicitSocket: server,
      }),
      expectedProfile,
    );
  } catch {
    checkAbort();
    throw new SharedConnectionError('shared_bootstrap_failed');
  }
  checkAbort();
  const fixedWorkspace = assertSharedWorkspace({
    fixedWorkspace: native.workspace,
    workspace,
    cwd,
  });
  const client = createClient({
    endpoint: native.httpEndpoint,
    token: native.token,
    expected: {
      profile: expectedProfile,
      apiMajor: 1,
      requiredCapabilities: capabilities,
      instanceId: native.instanceId,
      buildId: native.buildId,
    },
  });
  let bootstrap: ServerInfo;
  try {
    bootstrap = await client.connect({ signal });
    checkAbort();
  } catch {
    client.disposeNetwork();
    checkAbort();
    throw new SharedConnectionError('shared_connection_failed');
  }
  let completion: Promise<void> | undefined;
  return {
    mode: 'shared',
    client,
    bootstrap,
    fixedWorkspace,
    close() {
      if (!completion) {
        client.disposeNetwork();
        completion = Promise.resolve();
      }
      return completion;
    },
  };
}
