import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  BROKERED_GIT_FEATURE_REVISION_,
  type PreparedSandboxExecution,
  type SandboxCleanupGrant,
  type SandboxExecutionBackend,
  type SandboxExecutionProvider,
  type SandboxExecutionProviderFailureCode,
  type SandboxExecutionProviderResult,
  type SandboxPreparation,
  type SandboxPreparationGrant,
} from '@kite/runtime-spi';
import { generateBwrapArgs } from '../bwrap';
import type { CgroupPidsRunner } from '../cgroup-pids-contract';
import { discoverRuntimeReadOnlyRoots, generateSandboxProfile } from '../profile';
import { findApplySeccomp, resolveSeccompPath } from '../seccomp';
import type { ResourceLimits } from '../types';
import { sandboxBackendCapabilities } from './backend-capabilities';
import type { SandboxExecutionGrantVerifier } from './grant-authority';
import { sandboxCleanupDigest, sandboxPreparedPlanDigest } from './grant-authority';
import {
  cleanupPosixSandboxRuntimeRootsNoSpawn,
  cleanupWindowsSandboxRuntimeDirNoSpawn,
  createPosixSandboxRuntimeRootsForPreparation,
  createWindowsSandboxRuntimeDirForPreparation,
  sandboxRuntimeDirForPreparation,
  sandboxRuntimeRootsForPreparation,
} from './local-runtime-filesystem';
import {
  buildEnvExportSnippet,
  buildEnvStripSnippet,
  buildHardenedEnv,
  buildUlimitPreamble,
} from './local-shell-preparation';
import { prepareWindowsRestrictedTokenTransport } from './windows-preparation';

export interface LocalSandboxExecutionProviderOptions {
  readonly backend: Exclude<SandboxExecutionBackend, 'none'>;
  readonly canonicalWorkspace: string;
  readonly filesystemScope?: 'read_only' | 'workspace_write';
  readonly runtimeReadOnlyRoots?: readonly string[];
  readonly brokeredGitFeatureRevision?: typeof BROKERED_GIT_FEATURE_REVISION_;
  readonly startupProbe?: boolean;
  readonly bubblewrapPath?: string;
  readonly cgroupPidsRunner?: CgroupPidsRunner;
}

/** Local confinement preparation. This module never imports or calls Bun.spawn. */
export class LocalSandboxExecutionProvider implements SandboxExecutionProvider {
  readonly resourceSemantics = 'allocating' as const;
  readonly #verifier: SandboxExecutionGrantVerifier;
  readonly #options: LocalSandboxExecutionProviderOptions;

  constructor(
    verifier: SandboxExecutionGrantVerifier,
    options: LocalSandboxExecutionProviderOptions,
  ) {
    this.#verifier = verifier;
    this.#options = Object.freeze({
      ...options,
      canonicalWorkspace: realpathSync.native(resolve(options.canonicalWorkspace)),
    });
  }

  async prepare(input: {
    readonly grant: SandboxPreparationGrant;
    readonly signal?: AbortSignal;
  }): Promise<SandboxExecutionProviderResult<PreparedSandboxExecution>> {
    if (input.signal?.aborted) return failure('cancelled', 'Sandbox preparation was cancelled.');
    let grant: Readonly<SandboxPreparationGrant>;
    try {
      grant = this.#verifier.verify(input.grant);
    } catch (error) {
      return failure(
        'invalid_grant',
        error instanceof Error ? error.message : 'Invalid sandbox grant.',
      );
    }
    if (grant.resourceSemantics !== this.resourceSemantics) {
      return failure('invalid_grant', 'Sandbox preparation resource semantics mismatch.');
    }
    const preparation = grant.preparation;
    let canonicalWorkspace: string;
    try {
      canonicalWorkspace = realpathSync.native(resolve(this.#options.canonicalWorkspace));
    } catch (error) {
      return failure('preparation_failed', message(error));
    }
    if (canonicalWorkspace !== preparation.canonicalWorkspace) {
      return failure('invalid_grant', 'Sandbox preparation Workspace mismatch.');
    }
    if (preparation.filesystemMode === 'allow_all') {
      if (this.#options.backend === 'windows_restricted_token') {
        return this.#prepareWindows(grant, canonicalWorkspace);
      }
    }
    if (this.#options.backend === 'windows_restricted_token') {
      return this.#prepareWindows(grant, canonicalWorkspace);
    }
    let runtimeRoots: ReturnType<typeof sandboxRuntimeRootsForPreparation> | undefined;
    try {
      runtimeRoots = createPosixSandboxRuntimeRootsForPreparation(
        canonicalWorkspace,
        grant.preparationDigest,
      );
      if (input.signal?.aborted) {
        const cleaned = cleanupPosixSandboxRuntimeRootsNoSpawn(runtimeRoots);
        return cleaned
          ? failure('cancelled', 'Sandbox preparation was cancelled.')
          : failure('dispose_failed', 'Cancelled sandbox preparation could not be disposed.');
      }
      const plan = this.#preparePosix(grant, canonicalWorkspace, runtimeRoots);
      return { ok: true, observation: deepFreeze(plan) };
    } catch (error) {
      if (runtimeRoots && !cleanupPosixSandboxRuntimeRootsNoSpawn(runtimeRoots)) {
        return failure(
          'dispose_failed',
          `Sandbox preparation failed and its runtime could not be disposed: ${message(error)}`,
        );
      }
      return failure('preparation_failed', message(error));
    }
  }

  async dispose(input: {
    readonly grant: SandboxCleanupGrant;
    readonly prepared: PreparedSandboxExecution;
    readonly signal?: AbortSignal;
  }): Promise<SandboxExecutionProviderResult<{ readonly disposed: true }>> {
    return this.#dispose(input.grant, input.prepared, 'dispose');
  }

  async reconcile(input: {
    readonly grant: SandboxCleanupGrant;
    readonly prepared: PreparedSandboxExecution;
    readonly signal?: AbortSignal;
  }): Promise<SandboxExecutionProviderResult<{ readonly disposed: true }>> {
    return this.#dispose(input.grant, input.prepared, 'reconcile');
  }

  async reconcilePreparationIntent(input: {
    readonly grant: SandboxCleanupGrant;
    readonly signal?: AbortSignal;
  }): Promise<SandboxExecutionProviderResult<{ readonly disposed: true }>> {
    let grant: Readonly<SandboxCleanupGrant>;
    try {
      grant = this.#verifier.verifyCleanup(input.grant);
    } catch (error) {
      return failure('invalid_grant', message(error));
    }
    if (
      grant.purpose !== 'reconcile_preparation_intent' ||
      grant.canonicalWorkspace !== this.#options.canonicalWorkspace ||
      !grant.cleanupConfirmed
    ) {
      return failure('dispose_failed', 'Sandbox preparation intent cleanup identity is invalid.');
    }
    if (this.#options.backend === 'windows_restricted_token') {
      const runtimeRoot = sandboxRuntimeDirForPreparation(
        this.#options.canonicalWorkspace,
        grant.preparationDigest,
      );
      return cleanupWindowsSandboxRuntimeDirNoSpawn(runtimeRoot)
        ? { ok: true, observation: Object.freeze({ disposed: true as const }) }
        : failure(
            'dispose_failed',
            'Windows sandbox preparation runtime cleanup could not be confirmed.',
          );
    }
    try {
      const roots = sandboxRuntimeRootsForPreparation(
        this.#options.canonicalWorkspace,
        grant.preparationDigest,
      );
      return cleanupPosixSandboxRuntimeRootsNoSpawn(roots)
        ? { ok: true, observation: Object.freeze({ disposed: true as const }) }
        : failure('dispose_failed', 'Sandbox preparation intent cleanup could not be confirmed.');
    } catch (error) {
      return failure('dispose_failed', message(error));
    }
  }

  async #dispose(
    cleanupGrant: SandboxCleanupGrant,
    prepared: PreparedSandboxExecution,
    purpose: 'dispose' | 'reconcile',
  ): Promise<SandboxExecutionProviderResult<{ readonly disposed: true }>> {
    let grant: Readonly<SandboxCleanupGrant>;
    try {
      grant = this.#verifier.verifyCleanup(cleanupGrant);
    } catch (error) {
      return failure('invalid_grant', message(error));
    }
    if (
      grant.purpose !== purpose ||
      grant.preparedPlanDigest !== sandboxPreparedPlanDigest(prepared) ||
      grant.cleanupDigest !== sandboxCleanupDigest(prepared.cleanup) ||
      grant.toolCallId !== prepared.toolCallId ||
      grant.capabilityId !== prepared.capabilityId ||
      grant.capabilityRevision !== prepared.capabilityRevision ||
      grant.invocationId !== prepared.invocationId ||
      grant.attempt !== prepared.attempt ||
      grant.canonicalWorkspace !== prepared.canonicalWorkspace ||
      grant.effectiveEffectsDigest !== prepared.effectiveEffectsDigest ||
      grant.admissionDigest !== prepared.admissionDigest ||
      grant.preparationDigest !== prepared.preparationDigest ||
      prepared.schema !== 'kite.sandbox-execution-provider.v1' ||
      prepared.backend !== this.#options.backend ||
      !['runtime_directory', 'windows_restricted_token'].includes(prepared.cleanup.kind)
    ) {
      return failure('dispose_failed', 'Sandbox cleanup handle is invalid for this Provider.');
    }
    if (!grant.cleanupConfirmed) {
      return failure(
        'dispose_failed',
        'Sandbox process cleanup was not confirmed; runtime was retained.',
      );
    }
    if (prepared.cleanup.kind === 'windows_restricted_token') {
      const path = prepared.cleanup.recoveryPayload.path;
      if (typeof path !== 'string') {
        return failure('dispose_failed', 'Windows sandbox cleanup handle is incomplete.');
      }
      return cleanupWindowsSandboxRuntimeDirNoSpawn(path)
        ? { ok: true, observation: Object.freeze({ disposed: true as const }) }
        : failure('dispose_failed', 'Windows sandbox runtime cleanup could not be confirmed.');
    }
    const cleaned =
      prepared.cleanup.kind === 'runtime_directory' &&
      typeof prepared.cleanup.recoveryPayload.controlRoot === 'string' &&
      typeof prepared.cleanup.recoveryPayload.dataRoot === 'string' &&
      cleanupPosixSandboxRuntimeRootsNoSpawn({
        controlRoot: prepared.cleanup.recoveryPayload.controlRoot,
        dataRoot: prepared.cleanup.recoveryPayload.dataRoot,
      });
    if (!cleaned) {
      return failure('dispose_failed', 'Sandbox runtime cleanup could not be confirmed.');
    }
    return { ok: true, observation: Object.freeze({ disposed: true as const }) };
  }

  #preparePosix(
    grant: Readonly<SandboxPreparationGrant>,
    workspace: string,
    runtimeRoots: Readonly<ReturnType<typeof sandboxRuntimeRootsForPreparation>>,
  ): PreparedSandboxExecution {
    const preparation = grant.preparation;
    const command = commandFromArgv(preparation.argv);
    const policyProvenReadOnly = preparation.executionTrust === 'policy_proven_read_only';
    const hardenedEnv = buildHardenedEnv(workspace, runtimeRoots.dataRoot, {
      policyProvenReadOnly,
    });
    const preamble = [
      buildEnvStripSnippet(),
      buildUlimitPreamble(resourceLimits(preparation.resourceLimits)),
      buildEnvExportSnippet(hardenedEnv),
    ].join(' ');
    const wrappedCommand = `${preamble} ${command}`;
    const shell = policyProvenReadOnly ? '/bin/sh' : preparation.argv[0]!;
    let argv: string[];
    if (this.#options.backend === 'seatbelt') {
      const profile = generateSandboxProfile(workspace, {
        network: preparation.networkMode,
        filesystemScope:
          preparation.filesystemMode === 'allow_all'
            ? 'full_access'
            : (this.#options.filesystemScope ?? 'workspace_write'),
        sandboxRuntimeDir: runtimeRoots.dataRoot,
        sandboxControlBase: dirname(runtimeRoots.controlRoot),
        runtimeReadOnlyRoots: this.#options.runtimeReadOnlyRoots ?? discoverRuntimeReadOnlyRoots(),
        gitAccess:
          this.#options.brokeredGitFeatureRevision === BROKERED_GIT_FEATURE_REVISION_
            ? 'deny'
            : 'allow',
      });
      argv = ['/usr/bin/sandbox-exec', '-p', profile, shell, '-c', wrappedCommand];
    } else {
      const bwrap = this.#options.bubblewrapPath;
      if (!bwrap) throw new Error('bubblewrap_unusable');
      const seccomp = resolveSeccompPath(findApplySeccomp(), workspace, runtimeRoots.dataRoot);
      const args = generateBwrapArgs(workspace, {
        network: preparation.networkMode,
        sandboxRuntimeDir: runtimeRoots.dataRoot,
        sandboxControlBase: dirname(runtimeRoots.controlRoot),
        filesystemScope:
          preparation.filesystemMode === 'allow_all'
            ? 'full_access'
            : (this.#options.filesystemScope ?? 'workspace_write'),
      });
      const inner = seccomp
        ? [seccomp, shell, '-c', wrappedCommand]
        : [shell, '-c', wrappedCommand];
      const sandboxArgv = [bwrap, ...args, ...inner];
      if (preparation.resourceLimits.maxProcessTreeTasks !== null) {
        // A systemd scope is not usable as a production hard-limit backend
        // until its exact cgroup identity is durably acknowledged before GO
        // and its consumer-owned empty proof is persisted. The current
        // lifecycle has no such field; never emit a post-spawn-only plan.
        throw new Error('cgroup_pids_cleanup_authority_unavailable');
      } else {
        argv = sandboxArgv;
      }
    }
    const capabilities = sandboxBackendCapabilities(this.#options.backend);
    return {
      schema: 'kite.sandbox-execution-provider.v1',
      kind: 'prepared_sandbox_execution',
      planId: randomUUID(),
      toolCallId: preparation.toolCallId,
      capabilityId: preparation.capabilityId,
      capabilityRevision: preparation.capabilityRevision,
      invocationId: preparation.invocationId,
      attempt: preparation.attempt,
      canonicalWorkspace: preparation.canonicalWorkspace,
      effectiveEffectsDigest: preparation.effectiveEffectsDigest,
      admissionDigest: preparation.admissionDigest,
      preparationDigest: grant.preparationDigest,
      commandDigest: preparation.commandDigest,
      approvedArgv: preparation.argv,
      argv,
      cwd: workspace,
      env: policyProvenReadOnly ? hardenedEnv : null,
      stdin: null,
      transport: 'stdio',
      backend: this.#options.backend,
      backendCapabilities: capabilities,
      enforcement: Object.values(capabilities.filesystem).includes('unsupported')
        ? 'partial'
        : 'full',
      resourceSemantics: this.resourceSemantics,
      expiresAtMs: grant.expiresAtMs,
      cleanup: {
        kind: 'runtime_directory',
        resourceId: randomUUID(),
        recoveryPayload: {
          controlRoot: runtimeRoots.controlRoot,
          dataRoot: runtimeRoots.dataRoot,
        },
      },
    };
  }

  #prepareWindows(
    grant: Readonly<SandboxPreparationGrant>,
    workspace: string,
  ): SandboxExecutionProviderResult<PreparedSandboxExecution> {
    const preparation = grant.preparation;
    let runtimeRoot: string | undefined;
    try {
      runtimeRoot = createWindowsSandboxRuntimeDirForPreparation(
        workspace,
        grant.preparationDigest,
      );
      const prepared = prepareWindowsRestrictedTokenTransport(
        {
          enabled: true,
          workspace,
          filesystemScope: this.#options.filesystemScope,
          maxProcessTreeTasks: preparation.resourceLimits.maxProcessTreeTasks ?? undefined,
        },
        {
          workspace,
          command: commandFromArgv(preparation.argv),
          timeoutMs: preparation.timeoutMs,
          networkMode: preparation.networkMode,
          filesystemMode: preparation.filesystemMode,
          ...(preparation.executionTrust === 'policy_proven_read_only'
            ? { executionTrust: preparation.executionTrust }
            : {}),
        },
        runtimeRoot,
      );
      if (!prepared.ok) {
        cleanupWindowsSandboxRuntimeDirNoSpawn(runtimeRoot);
        return failure('backend_unavailable', prepared.error);
      }
      const transport = prepared.prepared;
      const capabilities = sandboxBackendCapabilities(this.#options.backend);
      const serialized = JSON.stringify(transport);
      return {
        ok: true,
        observation: deepFreeze({
          schema: 'kite.sandbox-execution-provider.v1',
          kind: 'prepared_sandbox_execution',
          planId: randomUUID(),
          toolCallId: preparation.toolCallId,
          capabilityId: preparation.capabilityId,
          capabilityRevision: preparation.capabilityRevision,
          invocationId: preparation.invocationId,
          attempt: preparation.attempt,
          canonicalWorkspace: preparation.canonicalWorkspace,
          effectiveEffectsDigest: preparation.effectiveEffectsDigest,
          admissionDigest: preparation.admissionDigest,
          preparationDigest: grant.preparationDigest,
          commandDigest: preparation.commandDigest,
          approvedArgv: preparation.argv,
          argv: [transport.runner.path],
          cwd: workspace,
          env: null,
          stdin: serialized,
          transport: 'windows_restricted_token_v1',
          backend: this.#options.backend,
          backendCapabilities: capabilities,
          enforcement: 'partial',
          resourceSemantics: this.resourceSemantics,
          expiresAtMs: grant.expiresAtMs,
          cleanup: {
            kind: 'windows_restricted_token',
            resourceId: transport.request.invocationName,
            recoveryPayload: {
              path: transport.runtimeRoot,
              transport: serialized,
            },
          },
        }),
      };
    } catch (error) {
      if (runtimeRoot) cleanupWindowsSandboxRuntimeDirNoSpawn(runtimeRoot);
      return failure('preparation_failed', message(error));
    }
  }
}

function commandFromArgv(argv: readonly string[]): string {
  if (
    argv.length < 3 ||
    (argv.at(-2) !== '-c' && argv.at(-2) !== '-lc') ||
    typeof argv.at(-1) !== 'string'
  ) {
    throw new Error('Approved shell argv must end in an exact shell command.');
  }
  return argv.at(-1)!;
}

function resourceLimits(input: SandboxPreparation['resourceLimits']): Partial<ResourceLimits> {
  return {
    cpuTime: input.cpuTime,
    virtualMemory: input.virtualMemory,
    fileSize: input.fileSize,
    fileDescriptors: input.fileDescriptors,
    processes: input.processes,
  };
}

function failure(
  code: SandboxExecutionProviderFailureCode,
  text: string,
): SandboxExecutionProviderResult<never> {
  return { ok: false, failure: Object.freeze({ code, message: text }) };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (Array.isArray(value)) {
    for (const child of value) deepFreeze(child);
    return Object.freeze(value);
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    return Object.freeze(value);
  }
  return value;
}
