import { randomUUID } from 'node:crypto';
import {
  canonicalSerialize,
  knownTrajectoryKindSchema,
  type TrajectoryScope,
  trajectorySnapshotSchema,
} from '@kite-ai/trajectory';
import { z } from 'zod';
import { otelIntegrationConfigSchema } from '../trace-integrations/opentelemetry/configuration';
import type { TrajectorySource } from '../trajectory';
import {
  type TraceConsumer,
  type TraceConsumerInspection,
  type TrustedTraceConsumerFactory,
  type TrustedTraceConsumerInspector,
  traceConsumerInspectionSchema,
} from './consumer';
import type { TraceConsumerStore } from './consumer-store';
import type { TraceCredentialBroker } from './credentials';
import {
  createTraceEngine,
  type EngineJson,
  type TraceEngineAssets,
  type TraceEngineBudgets,
  type TraceEngineBundle,
} from './engine';
import { engineDigest } from './engine/assets';
import { copyEngineJson } from './engine/protocol';
import { TraceEvidenceBroker } from './evidence';
import { resolveTraceTarget, TraceHttpBroker } from './network';
import {
  sameScope,
  type TraceGrantState,
  type TraceHistoryRequest,
  TraceHostError,
  traceHistoryRequestSchema,
} from './types';

const brokerHistorySchema = z.strictObject({
  storeRef: z.string().min(1).max(512),
  sessionRef: z.string().min(1).max(512),
  runRef: z.string().max(512).optional(),
  executionRef: z.string().max(512).optional(),
  fromSequence: traceHistoryRequestSchema.shape.fromSequence,
  toSequence: traceHistoryRequestSchema.shape.toSequence,
  eventKinds: traceHistoryRequestSchema.shape.eventKinds,
  contentMode: traceHistoryRequestSchema.shape.contentMode,
});
export interface TraceHostOptions {
  store: TraceConsumerStore;
  source: TrajectorySource;
  subjectId: string;
  assets: TraceEngineAssets;
  engineBudgets?: Partial<TraceEngineBudgets>;
  credentials?: TraceCredentialBroker;
  trustedConsumerFactory?: TrustedTraceConsumerFactory;
  trustedConsumerInspect?: TrustedTraceConsumerInspector;
}
/** Service-owned consumer; source only reads authority. Management calls do not run Runtime actions. */
export class TraceHost {
  private readonly options: TraceHostOptions;
  private readonly engines = new Map<string, TraceConsumer>();
  private readonly startingEngines = new Map<string, Promise<TraceConsumer>>();
  private readonly evidence: TraceEvidenceBroker;
  private readonly network: TraceHttpBroker;
  private readonly work = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private nextInstallation = 0;
  private closePromise: Promise<void> | undefined;
  constructor(options: TraceHostOptions) {
    this.options = options;
    this.evidence = new TraceEvidenceBroker(
      options.store,
      options.source.evidence,
      options.subjectId,
    );
    this.network = new TraceHttpBroker(options.store, options.credentials);
  }
  listInstallations() {
    return this.options.store.listInstallations().map(({ id }) => {
      const installation = this.options.store.inspectInstallation(id);
      return {
        installationId: id,
        kind: installation.kind,
        name: installation.manifest.name,
        digest: installation.digest,
        status: installation.status,
      };
    });
  }
  inspectInstallation(id: string) {
    const installation = this.options.store.inspectInstallation(id);
    let grant: TraceGrantState | null = null;
    try {
      grant = this.options.store.grant(id);
    } catch {}
    return {
      installationId: id,
      kind: installation.kind,
      name: installation.manifest.name,
      digest: installation.digest,
      status: installation.status,
      manifest: installation.manifest,
      settings: installation.settings,
      grant,
      partitions: this.options.store.listPartitions(id),
      credentials: this.options.store.credentialHandles(id),
    };
  }
  partition(id: string, partitionId: string) {
    const partition = this.options.store.inspectPartition(partitionId);
    if (partition.installationId !== id) throw new TraceHostError('trace_scope_denied');
    return partition;
  }
  retryDeadLetter(id: string, partitionId: string): void {
    this.partition(id, partitionId);
    this.options.store.retryDeadLetter(partitionId);
  }
  deadLetters(id: string, partitionId: string) {
    this.partition(id, partitionId);
    return this.options.store.deadLetters(partitionId);
  }
  async deliveryStatus(id: string, signal?: AbortSignal) {
    const installation = this.options.store.inspectInstallation(id);
    signal?.throwIfAborted();
    if (installation.kind === 'third_party')
      return { kind: 'third_party' as const, status: 'not_applicable' as const };
    const consumer = this.engines.get(id);
    if (!consumer?.inspect && !this.options.trustedConsumerInspect)
      return {
        kind: 'opentelemetry' as const,
        status: 'unavailable' as const,
        inspection: null,
        code: 'inspection_unavailable' as const,
      };
    let inspection: TraceConsumerInspection | null;
    try {
      inspection = consumer?.inspect
        ? await consumer.inspect()
        : await this.options.trustedConsumerInspect!({
            installationId: id,
            kind: installation.kind,
            digest: installation.digest,
            settings: installation.settings,
          });
    } catch {
      signal?.throwIfAborted();
      return {
        kind: 'opentelemetry' as const,
        status: 'unavailable' as const,
        inspection: null,
        code: 'inspection_unavailable' as const,
      };
    }
    signal?.throwIfAborted();
    if (!inspection)
      return { kind: 'opentelemetry' as const, status: 'not_started' as const, inspection: null };
    inspection = traceConsumerInspectionSchema.parse(inspection);
    return { kind: 'opentelemetry' as const, status: 'available' as const, inspection };
  }
  bindCredential(id: string, origin: string, secret: string) {
    if (!this.options.credentials) throw new TraceHostError('trace_credential_unavailable');
    return this.options.credentials.bind(id, origin, secret);
  }
  revokeCredential(id: string, handle: string) {
    if (!this.options.credentials) throw new TraceHostError('trace_credential_unavailable');
    return this.options.credentials.revoke(id, handle);
  }
  install(manifest: unknown, bundle: TraceEngineBundle): string {
    return this.options.store.install(manifest, bundle);
  }
  /** Trusted Service composition only. Generic HTTP bundle installation always remains third_party. */
  installTrusted(kind: 'opentelemetry', manifest: unknown, bundle: TraceEngineBundle): string {
    return this.options.store.installTrusted(kind, manifest, bundle);
  }
  installOtelIntegration(value: unknown): string {
    const config = otelIntegrationConfigSchema.omit({ credentialHandle: true }).parse(value);
    const source = canonicalSerialize({
      implementation: 'kite.opentelemetry',
      apiVersion: 1,
      mappingVersion: 1,
    });
    return this.options.store.installTrustedConfigured(
      'opentelemetry',
      {
        apiVersion: 1,
        name: 'opentelemetry',
        history: true,
        eventKinds: [...knownTrajectoryKindSchema.options],
        evidenceKinds: [],
        origins: [new URL(config.endpoint).origin],
        settings: { endpoint: 'string', sampleRate: 'number', credentialHandle: 'string' },
      },
      { apiVersion: 1, source, sha256: engineDigest(source) },
      config,
    );
  }
  configure(id: string, settings: Record<string, string | number | boolean>): void {
    const installation = this.options.store.inspectInstallation(id);
    if (installation.kind !== 'third_party' && Object.keys(installation.settings).length) {
      const previous = otelIntegrationConfigSchema.parse(installation.settings),
        next = otelIntegrationConfigSchema.parse(settings);
      if (previous.endpoint !== next.endpoint || previous.sampleRate !== next.sampleRate)
        throw new TraceHostError('trace_trusted_configuration_requires_new_installation');
      if (
        installation.status === 'enabled' &&
        canonicalSerialize(previous) !== canonicalSerialize(next)
      )
        throw new TraceHostError('trace_trusted_configuration_requires_disable');
      settings = next;
    }
    this.options.store.configure(id, settings);
  }
  async authorize(id: string, grant: unknown): Promise<TraceGrantState> {
    const state = this.options.store.authorize(id, grant);
    await this.retire(id);
    return state;
  }
  async revoke(id: string): Promise<void> {
    this.options.store.revoke(id);
    await this.retire(id);
  }
  async disable(id: string): Promise<void> {
    this.options.store.disable(id);
    await this.retire(id);
  }
  async update(id: string, manifest: unknown, bundle: TraceEngineBundle): Promise<void> {
    if (this.options.store.inspectInstallation(id).kind !== 'third_party')
      throw new TraceHostError('trace_trusted_update_required');
    this.options.store.revoke(id);
    await this.retire(id);
    this.options.store.update(id, manifest, bundle);
  }
  async uninstall(id: string): Promise<void> {
    this.options.store.revoke(id);
    await this.retire(id);
    const handles = this.options.store.credentialHandles(id);
    if (handles.length && !this.options.credentials)
      throw new TraceHostError('trace_credential_unavailable');
    const removed = await Promise.allSettled(
      handles.map((binding) => this.options.credentials!.revoke(id, binding.handle)),
    );
    if (removed.some((result) => result.status === 'rejected'))
      throw new TraceHostError('trace_credential_cleanup_unknown');
    this.options.store.uninstall(id);
  }
  async pauseHistoryExport(id: string, partitionId: string): Promise<void> {
    this.partition(id, partitionId);
    this.options.store.pauseExport(partitionId);
    await this.retire(id);
  }
  resumeHistoryExport(id: string, partitionId: string): void {
    this.partition(id, partitionId);
    this.options.store.resumeExport(partitionId);
  }
  private current(id: string, state: TraceGrantState): void {
    const now = this.options.store.grant(id);
    if (!now.active || now.revision !== state.revision || now.epoch !== state.epoch)
      throw new TraceHostError('trace_permission_revoked');
  }
  async enable(id: string): Promise<void> {
    if (this.closed) throw new TraceHostError('trace_host_closed');
    const { store, source, subjectId } = this.options;
    const grant = store.grant(id);
    if (!grant.active) throw new TraceHostError('trace_permission_revoked');
    const existing = store
      .listPartitions(id)
      .filter((item) => item.epoch === grant.epoch && item.lane === 'live');
    const snapshots: { scope: TrajectoryScope; upper: string }[] = [];
    for (const scope of grant.grant.scopes) {
      if (existing.some((item) => canonicalSerialize(item.scope) === canonicalSerialize(scope)))
        continue;
      const snapshot = trajectorySnapshotSchema.parse(
        await source.open({ ...scope, subjectId }, {}),
      );
      this.current(id, grant);
      if (
        snapshot.storeId !== scope.storeId ||
        snapshot.sessionId !== scope.sessionId ||
        snapshot.runId !== scope.runId ||
        snapshot.executionId !== scope.executionId
      )
        throw new TraceHostError('trace_source_scope_invalid');
      snapshots.push({ scope, upper: snapshot.upperCursor });
    }
    this.current(id, grant);
    if (this.closed) throw new TraceHostError('trace_host_closed');
    store.enablePartitions(id, snapshots);
    try {
      await this.engine(id);
    } catch (error) {
      store.disable(id);
      await this.retire(id);
      throw error;
    }
  }
  async startHistoryExport(
    id: string,
    value: TraceHistoryRequest,
    signal?: AbortSignal,
  ): Promise<string> {
    const input = traceHistoryRequestSchema.parse(value),
      { store, source, subjectId } = this.options;
    const grant = store.grant(id);
    store.assertAuthorization(id, grant.revision, grant.epoch);
    if (
      !grant.grant.allowHistory ||
      !sameScope(grant.grant, input.scope) ||
      (input.contentMode === 'authorized_evidence' && !grant.grant.evidenceKinds.length) ||
      input.eventKinds?.some((kind) => !grant.grant.eventKinds.includes(kind))
    )
      throw new TraceHostError('trace_history_permission_denied');
    const snapshot = trajectorySnapshotSchema.parse(
      await source.open({ ...input.scope, subjectId }, { signal }),
    );
    store.assertAuthorization(id, grant.revision, grant.epoch);
    if (
      snapshot.storeId !== input.scope.storeId ||
      snapshot.sessionId !== input.scope.sessionId ||
      snapshot.runId !== input.scope.runId ||
      snapshot.executionId !== input.scope.executionId
    )
      throw new TraceHostError('trace_source_scope_invalid');
    const upper = input.toSequence ?? snapshot.upperCursor;
    if (BigInt(upper) > BigInt(snapshot.upperCursor))
      throw new TraceHostError('trace_history_upper_invalid');
    // History ranges include both bounds. Reader.afterCursor remains exclusive.
    const fromCursor =
      input.fromSequence && BigInt(input.fromSequence) > 0n
        ? String(BigInt(input.fromSequence) - 1n)
        : '0';
    return store.createPartition(
      id,
      input.scope,
      input.eventKinds ?? grant.grant.eventKinds,
      upper,
      { exportId: randomUUID(), fromCursor, contentMode: input.contentMode },
    );
  }
  async cancelHistoryExport(id: string, partitionId: string): Promise<void> {
    if (this.options.store.inspectPartition(partitionId).installationId !== id)
      throw new TraceHostError('trace_scope_denied');
    this.options.store.cancelExport(partitionId);
    // Stop material delivery before waiting on the engine's asynchronous cancellation.
    this.evidence.revoke(id);
    const taskId = this.options.store.inspectPartition(partitionId).exportId!;
    await this.engines.get(id)?.cancelTask?.(taskId);
    await this.retire(id);
  }
  private async retire(id: string): Promise<{ confirmed: boolean } | undefined> {
    this.controllers.get(id)?.abort();
    this.evidence.revoke(id);
    if (!this.engines.has(id)) await this.startingEngines.get(id)?.catch(() => {});
    const engine = this.engines.get(id);
    if (!engine) return undefined;
    let notification: Promise<void> | undefined;
    if (engine.setGrant) {
      try {
        const grant = this.options.store.grant(id);
        notification = engine
          .setGrant({ revision: grant.revision, epoch: grant.epoch, active: grant.active })
          .catch(() => {});
      } catch {}
    }
    const result = await engine.retire();
    await notification;
    if (!result.confirmed) throw new TraceHostError('trace_engine_exit_unconfirmed');
    if (this.engines.get(id) === engine) this.engines.delete(id);
    return result;
  }
  private async broker(
    id: string,
    state: TraceGrantState,
    generation: string,
    signal: AbortSignal,
    method: string,
    input: EngineJson,
  ): Promise<EngineJson> {
    const store = this.options.store;
    store.assertAuthorization(id, state.revision, state.epoch, generation);
    switch (method) {
      case 'settings.get':
        z.null().parse(input);
        return store.inspectInstallation(id).settings;
      case 'history.request': {
        const request = brokerHistorySchema.parse(input);
        const scope = store.resolveGrantedScope(id, request);
        const partitionId = await this.startHistoryExport(id, {
          scope,
          ...(request.fromSequence === undefined ? {} : { fromSequence: request.fromSequence }),
          ...(request.toSequence === undefined ? {} : { toSequence: request.toSequence }),
          ...(request.eventKinds === undefined ? {} : { eventKinds: request.eventKinds }),
          contentMode: request.contentMode,
        });
        store.assertAuthorization(id, state.revision, state.epoch, generation);
        return { partitionId };
      }
      case 'log.emit':
        z.strictObject({
          code: z.enum(['delivery_started', 'delivery_complete', 'delivery_failed']),
        }).parse(input);
        return { accepted: true };
      case 'http.request':
        return this.network.request(input, {
          installationId: id,
          revision: state.revision,
          epoch: state.epoch,
          generation,
          signal,
        });
      case 'evidence.open':
        return copyEngineJson(
          await this.evidence.open(input, {
            installationId: id,
            revision: state.revision,
            epoch: state.epoch,
            generation,
            signal,
          }),
          768 * 1024,
        );
      case 'evidence.read':
        return copyEngineJson(
          await this.evidence.read(input, {
            installationId: id,
            revision: state.revision,
            epoch: state.epoch,
            generation,
            signal,
          }),
          768 * 1024,
        );
      case 'evidence.close':
        this.evidence.close(input, {
          installationId: id,
          revision: state.revision,
          epoch: state.epoch,
          generation,
          signal,
        });
        return null;
      default:
        throw new TraceHostError('trace_broker_method_denied');
    }
  }
  private engine(id: string): Promise<TraceConsumer> {
    const existing = this.engines.get(id);
    if (existing) return Promise.resolve(existing);
    const starting = this.startingEngines.get(id);
    if (starting) return starting;
    const task = this.startEngine(id).finally(() => {
      if (this.startingEngines.get(id) === task) this.startingEngines.delete(id);
    });
    this.startingEngines.set(id, task);
    return task;
  }
  private async startEngine(id: string): Promise<TraceConsumer> {
    if (this.closed) throw new TraceHostError('trace_host_closed');
    const store = this.options.store,
      installation = store.inspectInstallation(id),
      grant = store.grant(id);
    const generation = store.nextGeneration(id);
    store.assertAuthorization(id, grant.revision, grant.epoch, generation);
    const engine =
      installation.kind === 'opentelemetry'
        ? await (() => {
            const factory = this.options.trustedConsumerFactory;
            if (!factory) throw new TraceHostError('trace_trusted_consumer_unavailable');
            return factory({
              installationId: id,
              kind: installation.kind,
              digest: installation.digest,
              generation,
              grant,
              settings: installation.settings,
              authorizeSend: async (taskId, endpoint, signal, credentialHandle) => {
                const check = () => {
                  signal.throwIfAborted();
                  const current = store.assertAuthorization(
                    id,
                    grant.revision,
                    grant.epoch,
                    generation,
                  );
                  store.assertTaskActive(id, grant.epoch, taskId);
                  return current;
                };
                const current = check(),
                  url = new URL(endpoint);
                if (
                  !['http:', 'https:'].includes(url.protocol) ||
                  url.username ||
                  url.password ||
                  url.hash ||
                  !current.grant.origins.includes(url.origin)
                )
                  throw new TraceHostError('trace_origin_denied');
                const target = await resolveTraceTarget(
                  url,
                  current.grant.allowPrivateNetwork === true,
                  AbortSignal.any([signal, AbortSignal.timeout(5000)]),
                );
                check();
                let headers: Record<string, string> = {};
                if (credentialHandle) {
                  if (!this.options.credentials)
                    throw new TraceHostError('trace_credential_unavailable');
                  headers = await this.options.credentials.headers({
                    installationId: id,
                    origin: url.origin,
                    handle: credentialHandle,
                    revision: grant.revision,
                    epoch: grant.epoch,
                    generation,
                  });
                }
                check();
                store.audit(id, 'http_send', 'allowed');
                return { headers, target };
              },
            });
          })()
        : await createTraceEngine({
            installationId: id,
            generation,
            assets: this.options.assets,
            bundle: installation.bundle,
            budgets: this.options.engineBudgets,
            broker: (method, input, context) =>
              this.broker(id, grant, generation, context.signal, method, input),
          });
    this.engines.set(id, engine);
    try {
      if (this.closed) throw new TraceHostError('trace_host_closed');
      store.assertAuthorization(id, grant.revision, grant.epoch, generation);
      await engine.initialize({ installationId: id, apiVersion: 1 });
      store.assertAuthorization(id, grant.revision, grant.epoch, generation);
      return engine;
    } catch (error) {
      await this.retire(id);
      throw error;
    }
  }
  /** One bounded pass. Source notifications may wake this; periodic passes also repair lost wakes. */
  pump(id: string): Promise<void> {
    const running = this.work.get(id);
    if (running) return running;
    if (this.work.size >= 4) return Promise.reject(new TraceHostError('trace_host_busy'));
    if (this.closed) return Promise.reject(new TraceHostError('trace_host_closed'));
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const task = this.pumpOnce(id, controller.signal).finally(() => {
      if (this.work.get(id) === task) this.work.delete(id);
      if (this.controllers.get(id) === controller) this.controllers.delete(id);
    });
    this.work.set(id, task);
    return task;
  }
  private async pumpOnce(id: string, signal: AbortSignal): Promise<void> {
    const { store, source, subjectId } = this.options;
    const engine = await this.engine(id);
    for (const item of store.listPartitions(id)) {
      signal.throwIfAborted();
      if (!['active', 'unavailable'].includes(item.status)) continue;
      if (item.status === 'active' && !item.deadLetter) {
        try {
          if (item.lane === 'live' && item.sourceScanPosition === item.upperCursor) {
            const snapshot = trajectorySnapshotSchema.parse(
              await source.open({ ...item.scope, subjectId }, { signal }),
            );
            if (
              snapshot.storeId !== item.scope.storeId ||
              snapshot.sessionId !== item.scope.sessionId ||
              snapshot.runId !== item.scope.runId ||
              snapshot.executionId !== item.scope.executionId
            )
              throw new TraceHostError('trace_source_scope_invalid');
            store.extendLiveWindow(item.id, snapshot.upperCursor);
          }
          const request = store.requestFor(item.id);
          if (request.afterCursor !== request.upperCursor)
            store.enqueuePage(
              item.id,
              await source.readEvents({ ...request, subjectId }, { signal }),
            );
        } catch (error) {
          if (signal.aborted) throw error;
          if (
            error instanceof Error &&
            [
              'history_unavailable',
              'trajectory_history_unavailable',
              'session_not_found',
              'store_mismatch',
              'store_identity_mismatch',
            ].includes('code' in error ? String(error.code) : error.message)
          )
            store.markSourceUnavailable(item.id);
          else throw error;
        }
      }
      const batch = store.lease(item.id, engine.generation);
      if (!batch) continue;
      try {
        store.acknowledge(item.id, await engine.onEvents(batch, signal));
      } catch (error) {
        try {
          store.deliveryFailed(item.id);
        } catch {
          /* Revocation/cancel/retirement already invalidated this exact lease. */
        }
        await this.retire(id);
        throw error;
      }
    }
    // Adapter durable acceptance/Host ACK and remote outbound confirmation are separate owners.
    await engine.pump?.();
  }
  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => {
      // Independent installations remain independent when one callback fails or is slow.
      const enabled = this.options.store
        .listInstallations()
        .filter((item) => item.status === 'enabled');
      for (let offset = 0; offset < enabled.length && this.work.size < 4; offset++) {
        const item = enabled[(this.nextInstallation + offset) % enabled.length]!;
        if (!this.work.has(item.id)) void this.pump(item.id).catch(() => {});
      }
      if (enabled.length) this.nextInstallation = (this.nextInstallation + 4) % enabled.length;
    }, 1000);
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.closed = true;
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      for (const controller of this.controllers.values()) controller.abort();
      const results = await Promise.allSettled(
        [...new Set([...this.engines.keys(), ...this.startingEngines.keys()])].map((id) =>
          this.retire(id),
        ),
      );
      await Promise.allSettled([...this.work.values()]);
      if (results.some((result) => result.status === 'rejected'))
        throw new TraceHostError('trace_engine_exit_unconfirmed');
    })();
    return this.closePromise;
  }
}
