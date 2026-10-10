import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { createServiceLifecycleClient, type ServiceLifecycle } from '@kite-ai/client';
import type {
  DaemonBootstrap,
  DaemonEndpoint,
  DaemonProfile,
  DaemonReservation,
} from '@kite-ai/service/daemon';
import type { CLIArguments } from '../src/arguments';
import {
  CLIHostError,
  type CLIServiceArtifact,
  parseCLIServiceArtifact,
  verifyArtifact,
} from './index';

type DaemonArguments = Extract<CLIArguments, { kind: 'server' | 'web' }>;
interface Selected {
  profile: DaemonProfile;
  endpoint: DaemonEndpoint;
}
type Observation =
  | { state: 'absent' }
  | { state: 'dead'; record: DaemonReservation }
  | {
      state: 'present';
      record: DaemonReservation;
      bootstrap: DaemonBootstrap;
      lifecycle: ServiceLifecycle;
      compatible: boolean;
    };
const requiredCapabilities = ['sessions', 'history'];
function sameProfile(a: DaemonProfile, b: DaemonProfile) {
  return a.dataRoot === b.dataRoot && a.name === b.name && a.accessKey === b.accessKey;
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function lifecycleClient(bootstrap: DaemonBootstrap) {
  return createServiceLifecycleClient({
    endpoint: bootstrap.httpEndpoint,
    token: bootstrap.token,
    expected: { profile: bootstrap.profile, instanceId: bootstrap.instanceId },
  });
}
async function observe(selected: Selected): Promise<Observation> {
  const { readDaemonReservation, inspectProcess, requestDaemonBootstrap } = await import(
    '@kite-ai/service/daemon'
  );
  const record = readDaemonReservation(selected.endpoint);
  if (!record) return { state: 'absent' };
  if (!sameProfile(record.profile, selected.profile))
    throw new CLIHostError('daemon_identity_mismatch');
  const processState = inspectProcess(record.pid, record.processStartIdentity);
  if (processState === 'dead') return { state: 'dead', record };
  if (processState !== 'alive') throw new CLIHostError('daemon_identity_uncertain');
  const bootstrap = await requestDaemonBootstrap(selected.endpoint, selected.profile);
  if (
    bootstrap.instanceId !== record.instanceId ||
    bootstrap.buildId !== record.buildId ||
    bootstrap.pid !== record.pid ||
    bootstrap.processStartIdentity !== record.processStartIdentity ||
    bootstrap.workspace !== record.workspace ||
    !sameProfile(bootstrap.profile, record.profile)
  )
    throw new CLIHostError('daemon_identity_mismatch');
  const client = lifecycleClient(bootstrap);
  try {
    const lifecycle = await client.getStatus({ signal: AbortSignal.timeout(5000) });
    return {
      state: 'present',
      record,
      bootstrap,
      lifecycle,
      compatible:
        lifecycle.apiMajor === 1 &&
        requiredCapabilities.every((x) => lifecycle.capabilities.includes(x)),
    };
  } finally {
    client.disposeNetwork();
  }
}
function canonicalWorkspace(value: string, cwd: string) {
  const path = realpathSync(resolve(cwd, value));
  if (!lstatSync(path).isDirectory()) throw new CLIHostError('workspace_unavailable');
  return path;
}
async function validateArtifact(input: CLIServiceArtifact) {
  const { loadDaemonWebAssets } = await import('@kite-ai/service/daemon');
  const artifact = parseCLIServiceArtifact(input);
  if (!artifact.daemon) throw new CLIHostError('daemon_artifact_unavailable');
  verifyArtifact(artifact.executable, artifact.executableSha256, true);
  verifyArtifact(artifact.daemon.entrypoint, artifact.daemon.entrypointSha256, false);
  loadDaemonWebAssets(artifact.daemon.web);
  return artifact as CLIServiceArtifact & { daemon: NonNullable<CLIServiceArtifact['daemon']> };
}
async function launch(
  selected: Selected,
  artifact: Awaited<ReturnType<typeof validateArtifact>>,
  workspace: string,
  operation: 'start' | 'preflight',
  signal?: AbortSignal,
): Promise<DaemonBootstrap | undefined> {
  const {
    daemonStartupSchema,
    daemonPreflightSchema,
    bootstrapSchema,
    inspectProcess,
    requestDaemonBootstrap,
    retainWindowsDaemonArtifact,
  } = await import('@kite-ai/service/daemon');
  signal?.throwIfAborted();
  const instanceId = crypto.randomUUID(),
    token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const input = daemonStartupSchema.parse({
    operation,
    workspace,
    ...(selected.endpoint.defaultParent ? {} : { socket: selected.endpoint.socket }),
    web: artifact.daemon.web,
    startup: {
      profile: {
        dataRoot: selected.profile.dataRoot,
        profile: selected.profile.name,
        profileAccessKey: selected.profile.accessKey,
      },
      instanceId,
      buildId: artifact.buildId,
      token,
      ...(artifact.runtimeProtection ? { runtimeProtection: artifact.runtimeProtection } : {}),
    },
  });
  if (process.platform === 'win32' && !artifact.runtimeProtection)
    throw new CLIHostError('daemon_artifact_unqualified');
  const artifactAccess =
    process.platform === 'win32' && artifact.runtimeProtection
      ? retainWindowsDaemonArtifact(artifact.runtimeProtection, {
          entrypoint: artifact.daemon.entrypoint,
          executable: artifact.executable,
          buildId: artifact.buildId,
        })
      : undefined;
  let child: ReturnType<typeof spawn> & {
    stdin: NonNullable<ReturnType<typeof spawn>['stdin']>;
    stdout: NonNullable<ReturnType<typeof spawn>['stdout']>;
    stderr: NonNullable<ReturnType<typeof spawn>['stderr']>;
  };
  try {
    child = spawn(
      artifact.executable,
      [...(artifactAccess?.arguments ?? []), artifact.daemon.entrypoint],
      {
        detached: operation === 'start',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8' },
      },
    );
  } catch (error) {
    artifactAccess?.release();
    throw error;
  }
  const exited = new Promise<number | null>((done, reject) => {
    child.once('exit', done);
    child.once('error', reject);
  });
  void exited.catch(() => {});
  let bytes = Buffer.alloc(0),
    timer: ReturnType<typeof setTimeout> | undefined;
  const frame = new Promise<unknown>((done, reject) => {
    timer = setTimeout(() => reject(new CLIHostError('daemon_startup_unknown')), 15000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (bytes.length > 16384) return;
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 16384) {
        reject(new CLIHostError('daemon_startup_invalid'));
        return;
      }
      const end = bytes.indexOf(10);
      if (end < 0) return;
      try {
        if (end !== bytes.length - 1) throw Error();
        done(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end))));
      } catch {
        reject(new CLIHostError('daemon_startup_invalid'));
      }
    });
    child.once('error', reject);
    child.stdout.once('end', () => {
      if (bytes.indexOf(10) < 0) reject(new CLIHostError('daemon_startup_failed'));
    });
  });
  child.stderr.resume();
  child.stdin.on('error', () => {});
  child.stdin.end(`${JSON.stringify(input)}\n`);
  let handedOff = false;
  try {
    const value = await frame;
    if (operation === 'preflight') {
      const parsed = daemonPreflightSchema.safeParse(value);
      if (!parsed.success) throw new CLIHostError('daemon_preflight_invalid');
      const response = parsed.data;
      if (
        response.operation !== 'preflight' ||
        response.instanceId !== instanceId ||
        response.buildId !== artifact.buildId ||
        !response.profile ||
        !sameProfile(response.profile, selected.profile)
      )
        throw new CLIHostError('daemon_preflight_invalid');
      clearTimeout(timer);
      const exitCode = await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new CLIHostError('daemon_preflight_unknown')), 5000);
        }),
      ]);
      if (exitCode !== 0) throw new CLIHostError('daemon_preflight_failed');
      handedOff = true;
      return;
    }
    const bootstrap = bootstrapSchema.parse(value);
    if (
      bootstrap.requestId !== instanceId ||
      bootstrap.instanceId !== instanceId ||
      bootstrap.buildId !== artifact.buildId ||
      bootstrap.token !== token ||
      bootstrap.pid !== child.pid ||
      bootstrap.workspace !== workspace ||
      !sameProfile(bootstrap.profile, selected.profile) ||
      inspectProcess(bootstrap.pid, bootstrap.processStartIdentity) !== 'alive'
    )
      throw new CLIHostError('daemon_startup_identity_mismatch');
    const actual = await requestDaemonBootstrap(selected.endpoint, selected.profile);
    if (
      actual.instanceId !== instanceId ||
      actual.token !== token ||
      actual.httpEndpoint !== bootstrap.httpEndpoint
    )
      throw new CLIHostError('daemon_startup_identity_mismatch');
    handedOff = true;
    return bootstrap;
  } finally {
    clearTimeout(timer);
    // No daemon stop/kill on uncertain handoff. Its original reservation is the next observation target.
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    if (handedOff || child.exitCode !== null) artifactAccess?.release();
    else if (artifactAccess)
      void exited
        .then(() => artifactAccess.release())
        .catch(() => {
          // The original holder remains strong in the native admission module on failed close.
          process.stderr.write(`${JSON.stringify({ code: 'daemon_artifact_close_unknown' })}\n`);
        });
  }
}
async function stopOriginal(
  observed: Extract<Observation, { state: 'present' }>,
  mode: 'if_idle' | 'cancel',
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const { retainProcessObservation } = await import('@kite-ai/service/daemon');
  const original = retainProcessObservation(
    observed.record.pid,
    observed.record.processStartIdentity,
  );
  const client = lifecycleClient(observed.bootstrap);
  try {
    try {
      await client.shutdown(mode, { signal: AbortSignal.timeout(5000) });
    } catch (error) {
      if (
        !(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'network_outcome_unknown'
        )
      )
        throw error;
    }
    const end = Date.now() + 15000;
    for (;;) {
      const state = original.inspect();
      if (state === 'dead') return;
      const status = await client
        .getStatus({ signal: AbortSignal.timeout(1000) })
        .catch(() => undefined);
      if (status?.state === 'drain_failed') throw new CLIHostError('shutdown_cleanup_unconfirmed');
      if (Date.now() >= end)
        throw new CLIHostError(
          state === 'uncertain' ? 'daemon_identity_uncertain' : 'daemon_stop_timeout',
        );
      await delay(50);
    }
  } finally {
    client.disposeNetwork();
    original.close();
  }
}
function report(observation: Observation, selected: Selected, targetBuildId: string | null) {
  const base = { profile: selected.profile, endpoint: selected.endpoint.socket, targetBuildId };
  if (observation.state === 'absent') return { ...base, state: 'absent' };
  if (observation.state === 'dead')
    return {
      ...base,
      state: 'dead',
      instanceId: observation.record.instanceId,
      runningBuildId: observation.record.buildId,
    };
  return {
    ...base,
    state: observation.lifecycle.state,
    compatible: observation.compatible,
    instanceId: observation.lifecycle.instanceId,
    runningBuildId: observation.lifecycle.buildId,
    apiMajor: observation.lifecycle.apiMajor,
    capabilities: observation.lifecycle.capabilities,
    dataAvailability: observation.lifecycle.dataAvailability,
    busy: observation.lifecycle.busy,
    reasons: observation.lifecycle.reasons,
    workspace: observation.bootstrap.workspace,
    webOrigin: observation.bootstrap.webOrigin,
  };
}
/** Explicit daemon orchestration only; observing/disconnecting never stops or creates work. */
export async function runSelectedDaemon(options: {
  arguments: DaemonArguments;
  dataRoot: string;
  profile?: string;
  cwd?: string;
  artifact?: CLIServiceArtifact;
  resolveArtifact?: () => CLIServiceArtifact;
  write: (line: string) => void;
  signal?: AbortSignal;
}): Promise<number> {
  const { selectDaemonEndpoint, clearDeadDaemonEndpoint, readDaemonReservation } = await import(
    '@kite-ai/service/daemon'
  );
  const args = options.arguments;
  const profile = selectProfile({
    dataRoot: args.dataRoot ?? options.dataRoot,
    profile: options.profile ?? 'default',
  });
  const selected: Selected = {
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
    endpoint: selectDaemonEndpoint({
      profileAccessKey: profile.profileAccessKey,
      ...(args.server ? { explicitSocket: args.server } : {}),
    }),
  };
  const observed = await observe(selected);
  const target = options.artifact?.buildId ?? null;
  if (args.kind === 'web') {
    if (
      observed.state !== 'present' ||
      !observed.compatible ||
      observed.lifecycle.state !== 'accepting'
    )
      throw new CLIHostError('daemon_web_unavailable');
    options.write(
      args.json
        ? JSON.stringify({
            url: observed.bootstrap.webOrigin,
            ...report(observed, selected, target),
          })
        : observed.bootstrap.webOrigin,
    );
    return 0;
  }
  if (args.action === 'status') {
    options.write(JSON.stringify(report(observed, selected, target)));
    return 0;
  }
  if (args.action === 'stop') {
    if (observed.state === 'present') await stopOriginal(observed, 'cancel', options.signal);
    else if (observed.state === 'dead') {
      const result = clearDeadDaemonEndpoint(selected.endpoint, observed.record);
      if (result.outcome === 'blocked') throw new CLIHostError('daemon_cleanup_blocked');
    }
    options.write('daemon stopped');
    return 0;
  }
  const explicitWorkspace =
    args.workspace === undefined
      ? undefined
      : canonicalWorkspace(args.workspace, options.cwd ?? process.cwd());
  if (
    observed.state !== 'absent' &&
    explicitWorkspace !== undefined &&
    explicitWorkspace !== observed.record.workspace
  )
    throw new CLIHostError('workspace_identity_mismatch');
  if (args.action === 'start' && observed.state === 'present') {
    if (!observed.compatible) throw new CLIHostError('daemon_incompatible');
    if (observed.lifecycle.state !== 'accepting') throw new CLIHostError('daemon_not_accepting');
    options.write(
      JSON.stringify({
        ...report(observed, selected, target),
        reused: true,
        restartCommand: 'server restart',
      }),
    );
    return 0;
  }
  if (args.action === 'start' && observed.state === 'dead')
    throw new CLIHostError('daemon_dead_endpoint');
  const selectedArtifact = options.artifact ?? options.resolveArtifact?.();
  if (!selectedArtifact) throw new CLIHostError('daemon_artifact_unavailable');
  const artifact = await validateArtifact(selectedArtifact);
  const workspace =
    explicitWorkspace ??
    (observed.state !== 'absent'
      ? observed.record.workspace
      : canonicalWorkspace('.', options.cwd ?? process.cwd()));
  if (args.action === 'restart')
    await launch(selected, artifact, workspace, 'preflight', options.signal);
  if (observed.state === 'present')
    await stopOriginal(observed, args.cancel ? 'cancel' : 'if_idle', options.signal);
  if (observed.state !== 'absent') {
    const remaining = readDaemonReservation(selected.endpoint);
    if (remaining) {
      const result = clearDeadDaemonEndpoint(selected.endpoint, observed.record);
      if (result.outcome === 'blocked') throw new CLIHostError('daemon_cleanup_blocked');
    }
  }
  const launched = await launch(selected, artifact, workspace, 'start', options.signal);
  const current = await observe(selected);
  if (
    !launched ||
    current.state !== 'present' ||
    current.bootstrap.instanceId !== launched.instanceId ||
    current.bootstrap.pid !== launched.pid ||
    current.bootstrap.processStartIdentity !== launched.processStartIdentity ||
    !current.compatible ||
    current.bootstrap.workspace !== workspace ||
    current.bootstrap.buildId !== artifact.buildId
  )
    throw new CLIHostError('daemon_startup_unknown');
  options.write(JSON.stringify({ ...report(current, selected, artifact.buildId), reused: false }));
  return 0;
}
