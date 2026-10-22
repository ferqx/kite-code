import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createRuntime, type RunConfiguration } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { Extension, Json, ToolDefinition } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { createDefaultProcessConfiguration } from '../../../../apps/service/src/configuration';
import { saveLiveCanonicalModelEvidence } from './live-canonical-evidence';

const id = 'F02-default-policy-external-exact-approval-partial-conflict' as const;
export type LiveFilesPartialDefaultCaseId = typeof id;
interface Options {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests(): readonly ModelRequest[];
  caseIds?: readonly string[];
  evidenceRoot?: string;
}
interface Result {
  id: LiveFilesPartialDefaultCaseId;
  status: 'passed' | 'failed' | 'inconclusive';
  checks: Record<string, boolean | number>;
  coverage: string[];
  reason?: 'branch_not_reached' | 'oracle_violation' | 'execution_unavailable' | 'cleanup_failed';
  failurePoint?: string;
  adapterAttempts: number;
  canonicalEvidenceRetained: boolean;
  semanticReviewRequired: true;
}
const object = (value: unknown): Record<string, Json> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(JSON.stringify(value));
const canonical = (value: Json): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value !== null && typeof value === 'object'
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
          .join(',')}}`
      : JSON.stringify(value);
/** Read only the two existing permission intersection envelopes and exact default leaves. */
function defaultExternalApproval(policy: Json): boolean {
  const pending: Json[] = [policy];
  let leaves = 0,
    visited = 0;
  while (pending.length) {
    if (++visited > 8192) return false;
    const value = pending.pop()!;
    if (value === null) continue;
    if (typeof value !== 'object' || Array.isArray(value)) return false;
    if (value.mode !== undefined) {
      if (
        value.mode !== 'accept_edits' ||
        value.reason !== 'approval_required' ||
        !isDeepStrictEqual(value.effects, ['external']) ||
        Object.keys(value).some((key) => !['mode', 'reason', 'effects'].includes(key))
      )
        return false;
      leaves++;
      continue;
    }
    if (!Array.isArray(value.policies) || !value.policies.length) return false;
    if (value.kind === 'parent_child_permission_intersection') {
      if (Object.keys(value).some((key) => !['kind', 'policies'].includes(key))) return false;
      for (const item of value.policies) {
        const scope = object(item);
        if (
          !['parent', 'child'].includes(String(scope.scope)) ||
          typeof scope.revision !== 'string' ||
          !Object.hasOwn(scope, 'request') ||
          Object.keys(scope).some((key) => !['scope', 'revision', 'request'].includes(key))
        )
          return false;
        pending.push(scope.request!);
      }
    } else {
      if (Object.keys(value).some((key) => key !== 'policies')) return false;
      pending.push(...value.policies);
    }
  }
  return leaves > 0;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function wait(promise: Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(Error('live_files_partial_aborted'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
class Boundary extends Error {
  readonly reason: 'branch_not_reached' | 'oracle_violation';
  readonly point: string;
  constructor(reason: 'branch_not_reached' | 'oracle_violation', point: string) {
    super(point);
    this.reason = reason;
    this.point = point;
  }
}
/** Real default policy and external Files; caller retains 40 physical HTTP / 600s cap. */
export async function runLiveFilesPartialDefault(options: Options): Promise<{ cases: Result[] }> {
  if (options.caseIds && !options.caseIds.includes(id)) return { cases: [] };
  if (
    options.evidenceRoot &&
    (!isAbsolute(options.evidenceRoot) || existsSync(options.evidenceRoot))
  )
    throw Error('live_files_partial_evidence_root_invalid');
  options.signal.throwIfAborted();
  if (options.evidenceRoot) mkdirSync(options.evidenceRoot, { mode: 0o700 });
  const root = realpathSync(
    options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-files-partial-')),
  );
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const external = join(root, 'external-files');
  mkdirSync(external, { mode: 0o700 });
  const xPath = join(external, 'X.ini');
  const yPath = join(external, 'Y.ini');
  const keep = `keep-${randomUUID()}-🪁`;
  const initialX = `A=0\r\nkeep=${keep}\r\n`;
  const initialY = `A=0\r\nB=0\r\nkeep=${keep}\r\n`;
  const xPublished = initialX.replace('A=0', 'A=1');
  const yBPublished = initialY.replace('B=0', 'B=1');
  const yRecovered = yBPublished.replace('A=0', 'A=1');
  writeFileSync(xPath, initialX, { mode: 0o600 });
  writeFileSync(yPath, initialY, { mode: 0o600 });
  const aMarker = `A_ROLE_${randomUUID()}`;
  const bMarker = `B_ROLE_${randomUUID()}`;
  const allowB = gate(),
    bPublished = gate();
  const branchSignal = AbortSignal.any([options.signal, AbortSignal.timeout(90_000)]);
  const checks: Result['checks'] = {};
  const stages: Record<string, unknown> = {};
  const firstRequest = options.requests().length;
  let status: Result['status'] = 'inconclusive',
    reason: Result['reason'],
    failurePoint: string | undefined;
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let locks: ReturnType<typeof createWorkspaceSerialLocks> | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  let storeClosed = false,
    auxiliariesClosed = false;
  let phase: 'initial' | 'explicit-followup' = 'initial';
  const roles = new Map<string, 'A' | 'B'>();
  const reads: {
    role: 'A' | 'B';
    sessionId: string;
    runId: string;
    executionId: string;
    path: string;
    input: Json;
    result: Json;
    baseline: Json;
    completeContentMatchesBeforeBytes: boolean;
    ordinal: number;
    phase: 'initial' | 'explicit-followup';
  }[] = [];
  const writes: {
    role: 'A' | 'B';
    sessionId: string;
    runId: string;
    executionId: string;
    path: string;
    input: Json;
    result: Json;
    success: boolean;
    conflict: boolean;
    before: string;
    after: string;
    ordinal: number;
    phase: 'initial' | 'explicit-followup';
  }[] = [];
  let ordinal = 0;
  let approvePending: (() => Promise<void>) | undefined;
  const approved = new Map<string, { executionId: string; original: unknown; answered: unknown }>();
  const taskApprovals: unknown[] = [];
  const preAuthorization: { executionId: string; role: string; path: string; phase: string }[] = [];
  const assert = (value: unknown, point: string) => {
    checks[point] = Boolean(value);
    if (!value) throw new Boundary('oracle_violation', point);
  };
  const branch = (value: unknown, point: string) => {
    if (!value) throw new Boundary('branch_not_reached', point);
  };
  async function until<T>(read: () => Promise<T | undefined>, point: string) {
    const end = Date.now() + 90_000;
    for (;;) {
      options.signal.throwIfAborted();
      await approvePending?.();
      const value = await read();
      if (value !== undefined) return value;
      if (Date.now() >= end) throw new Boundary('branch_not_reached', point);
      await wait(new Promise<void>((resolve) => setTimeout(resolve, 20)), options.signal);
    }
  }
  const closeAuxiliaries = async () => {
    if (auxiliariesClosed) return;
    const results = await Promise.allSettled([locks?.close()]);
    if (results.some((result) => result.status === 'rejected'))
      throw Error('live_files_partial_aux_close_failed');
    auxiliariesClosed = true;
  };
  try {
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'live' });
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
    const owned = store;
    const expectedStoreId = (await owned.getMetadata()).storeId;
    locks = createWorkspaceSerialLocks(profile);
    const configPath = join(profile.profilePath, 'config.jsonc');
    writeFileSync(
      configPath,
      JSON.stringify({
        modelId: options.modelId,
        models: [
          {
            id: options.modelId,
            provider: 'compatible',
            model: 'injected-live',
            baseURL: 'http://127.0.0.1:1/v1',
          },
        ],
        tools: [
          'files.read_path',
          'files.edit_path',
          'task.spawn',
          'task.events',
          'task.list',
          'task.follow_up',
        ].map((id) => ({ id })),
      }),
      { mode: 0o600 },
    );
    const host = createDefaultProcessConfiguration({
      profile,
      userConfigurationPath: configPath,
      authorizationCheck: {
        id: 'live.review',
        version: '1',
        modelId: options.modelId,
        model: options.model,
      },
    });
    const pathExtension = host.extensions!.find(
      (extension) => extension.id === 'builtin.files.path',
    );
    const originals =
      pathExtension?.tools?.filter((tool) =>
        ['files.read_path', 'files.edit_path'].includes(tool.id),
      ) ?? [];
    assert(
      originals.length === 2 &&
        originals.find((tool) => tool.id === 'files.edit_path')?.resources?.serial?.key ===
          'files.path.mutation',
      'real_default_path_definitions_and_shared_mutation_resource_retained',
    );
    const tools: ToolDefinition[] = originals.map((tool) => ({
      ...tool,
      async execute(input, context) {
        const args = object(input);
        const role = roles.get(context.sessionId);
        branch(
          role && context.runId && context.sessionId !== 'root',
          'real_child_file_actor_not_identified',
        );
        const path = args.path === xPath ? 'X.ini' : args.path === yPath ? 'Y.ini' : '';
        branch(path === 'X.ini' || path === 'Y.ini', 'model_file_path_outside_assignment');
        const currentRole = role!;
        const before = readFileSync(join(external, path));
        const result = await tool.execute(input, context);
        const after = readFileSync(join(external, path));
        if (tool.id === 'files.read_path' && result.outcome === 'succeeded') {
          let body: Record<string, Json> = {};
          try {
            body = object(JSON.parse(result.content));
          } catch {
            /* No baseline means this branch stays unqualified. */
          }
          if (body.baseline)
            reads.push({
              role: currentRole,
              sessionId: context.sessionId,
              runId: context.runId!,
              executionId: context.executionId,
              path,
              input: structuredClone(input),
              result: structuredClone(result) as unknown as Json,
              baseline: structuredClone(body.baseline),
              completeContentMatchesBeforeBytes:
                body.content === before.toString('utf8') &&
                object(body.baseline).hash === hash(before) &&
                object(body.baseline).size === before.byteLength,
              ordinal: ++ordinal,
              phase,
            });
        } else if (tool.id === 'files.edit_path') {
          writes.push({
            role: currentRole,
            sessionId: context.sessionId,
            runId: context.runId!,
            executionId: context.executionId,
            path,
            input: structuredClone(input),
            result: structuredClone(result) as unknown as Json,
            success: result.outcome === 'succeeded',
            conflict:
              result.outcome === 'failed' &&
              object(result.details).code === 'file_baseline_conflict',
            before: hash(before),
            after: hash(after),
            ordinal: ++ordinal,
            phase,
          });
        }

        return result;
      },
    }));
    const model: ModelAdapter = {
      ...(options.model.describeRequest
        ? { describeRequest: options.model.describeRequest.bind(options.model) }
        : {}),
      stream(request, context) {
        return (async function* () {
          const execution = await owned.getExecution(request.requestId);
          if (execution && execution.sessionId !== 'root' && !roles.has(execution.sessionId)) {
            const text = request.messages.map((message) => message.content).join('\n');
            if (text.includes(aMarker)) roles.set(execution.sessionId, 'A');
            else if (text.includes(bMarker)) roles.set(execution.sessionId, 'B');
          }
          yield* options.model.stream(request, {
            signal: AbortSignal.any([context.signal, options.signal]),
          });
        })();
      },
    };
    const wrapExtensions = (extensions: readonly Extension[]) =>
      extensions.map((extension) =>
        extension.id === 'builtin.files.path'
          ? {
              ...extension,
              tools: extension.tools!.map(
                (tool) => tools.find((wrapped) => wrapped.id === tool.id) ?? tool,
              ),
            }
          : extension,
      );
    const inject = (binding: RunConfiguration): RunConfiguration => ({
      ...binding,
      model,
      ...(binding.extensions ? { extensions: wrapExtensions(binding.extensions) } : {}),
      ...(binding.readStepCapabilities
        ? {
            readStepCapabilities: async (input) => {
              const step = await binding.readStepCapabilities!(input);
              return {
                ...step,
                ...(step.extensions ? { extensions: wrapExtensions(step.extensions) } : {}),
              };
            },
          }
        : {}),
      permissions: {
        ...binding.permissions!,
        async authorize(request) {
          if (request.kind === 'tool' && request.definitionId.startsWith('files.')) {
            const args = object(request.input);
            const path = args.path === xPath ? 'X.ini' : args.path === yPath ? 'Y.ini' : '';
            const role = roles.get(request.sessionId);
            // This ceiling can only deny. Original default decisions and their read sets remain authoritative.
            if (
              !role ||
              !path ||
              !['files.read_path', 'files.edit_path'].includes(request.definitionId)
            )
              return {
                allowed: false,
                revision: 'F02-default-target-ceiling-1',
                reason: 'live_target_out_of_scope',
              };
            if (request.definitionId === 'files.edit_path' && phase === 'initial') {
              preAuthorization.push({ executionId: request.executionId, role, path, phase });
              // Absolute edits own a shared mutation resource. Never wait inside execute.
              if (role === 'B')
                await wait(allowB.promise, AbortSignal.any([branchSignal, request.signal]));
              if (role === 'A' && path === 'Y.ini')
                await wait(bPublished.promise, AbortSignal.any([branchSignal, request.signal]));
            }
          }
          return binding.permissions!.authorize(request);
        },
      },
    });
    runtime = createRuntime({
      ...host,
      store: owned,
      permissions: host.permissions!,
      modelConcurrency: 4,
      artifacts: createArtifactStore({ profile, store: owned }),
      workspaceSerialLocks: locks,
      extensions: host.extensions!.map((extension) =>
        extension.id === 'builtin.files.path'
          ? {
              ...extension,
              tools: extension.tools!.map(
                (tool) => tools.find((wrapped) => wrapped.id === tool.id) ?? tool,
              ),
            }
          : extension,
      ),
      resolveRunConfiguration: async (input) => inject(await host.resolveRunConfiguration!(input)),
      resolveChildRunConfiguration: async (input) =>
        inject(await host.resolveChildRunConfiguration!(input)),
      resolveRecoveryRunConfiguration: async (input) =>
        inject(await host.resolveRecoveryRunConfiguration!(input)),
    });
    const controls = host.permissionManagement!(runtime);
    service = await startService({
      runtime,
      beforeResourceClose: closeAuxiliaries,
      permissionManagement: controls,
      subjectId: 'live-files-partial-owner',
      buildId: 'live-files-partial',
      profile: {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: profile.profileAccessKey,
      },
    });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: {
        profile: service.bootstrap.profile,
        apiMajor: 1,
        requiredCapabilities: ['commands', 'sessions', 'interactions'],
      },
    });
    const live = client;
    await live.connect();
    await live.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'Default-policy external partial Files',
      rootUri: pathToFileURL(workspace).href,
    });
    await live.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 'root',
      workspaceId: 'w',
      title: 'Files individual partial outcomes',
    });
    const scope = { expectedStoreId, subjectId: 'live-files-partial-owner' };
    const previousMode = await controls.readMode({ ...scope, sessionId: 'root' });
    assert(
      (
        await controls.setMode({
          ...scope,
          sessionId: 'root',
          commandId: 'mode-initial',
          mode: 'accept_edits',
          makeDefault: false,
          ifRevision: previousMode.revision,
          ifDefaultRevision: previousMode.defaultRevision,
        })
      ).state === 'applied',
      'real_default_accept_edits_mode_applied',
    );
    const trust = await controls.readTrust({ ...scope, workspaceId: 'w' });
    assert(
      (
        await controls.setTrust({
          ...scope,
          workspaceId: 'w',
          commandId: 'trust',
          trusted: true,
          ifRevision: trust.revision,
          canonicalIdentity: trust.canonicalIdentity,
          externalReadScopeDigest: trust.externalReadScopeDigest,
        })
      ).state === 'applied',
      'real_default_workspace_trust_applied',
    );
    const aAssignment = `${aMarker}: Read ${xPath} and ${yPath} completely with read_user_file and retain each exact complete baseline. Then use edit_user_file on ${xPath} with find="A=0", replace="A=1", occurrences=1 and its actual complete base from the read. Then use edit_user_file on ${yPath} with find="A=0", replace="A=1", occurrences=1 and base from your ORIGINAL Y read. Both find/replace fields are exactly those single-line strings with no line endings or other keys included. Preserve every other byte, CRLF and keep data. These are separate real operations. If Y actually conflicts, do not reread, retry, compensate, roll back X, or change any further file in this turn. Report the separate actual X and Y outcomes, the actual error code, and complete keep marker. Finish. Use no other tool, delegate, messages, cancellation or Shell.`;
    const bAssignment = `${bMarker}: Read ${yPath} completely using read_user_file, then use edit_user_file on ${yPath} with find="B=0", replace="B=1", occurrences=1 and that exact complete base. The find/replace fields are exactly those single-line strings; do not include A=0, any line ending or another key in either field. Preserve every other byte, CRLF and keep data. Report your actual edit outcome and complete keep marker. Do not touch X.ini, delegate, send messages, cancel, retry or use Shell. Finish.`;
    let freshAssignmentForApproval: string | undefined;
    approvePending = async () => {
      const cards = [
        ...new Map(
          (
            await Promise.all(
              ['root', ...roles.keys()].map((sessionId) =>
                live.listInteractions(
                  sessionId,
                  { storeId: expectedStoreId, state: 'pending' },
                  { signal: options.signal },
                ),
              ),
            )
          )
            .flatMap((page) => page.interactions)
            .map((card) => [card.id, card]),
        ).values(),
      ];
      for (const card of cards) {
        if (
          approved.has(card.id) ||
          taskApprovals.some((entry) => object(entry).executionId === card.executionId)
        )
          continue;
        const execution = await owned.getExecution(card.executionId);
        branch(
          execution?.kind === 'tool' &&
            card.kind === 'approval' &&
            execution.sessionId === card.sessionId &&
            execution.runId === card.runId &&
            execution.originStoreId === expectedStoreId &&
            execution.definitionId === card.definitionId &&
            execution.definitionVersion === card.definitionVersion,
          'exact_pending_approval_original_execution_scope_missing',
        );
        const args = object(execution!.input);
        const request = object(card.request);
        const rawCard = await owned.getInteraction({
          expectedStoreId,
          sessionId: card.sessionId,
          interactionId: card.id,
        });
        branch(
          rawCard?.subjectId === scope.subjectId &&
            rawCard.inputDigest === card.inputDigest &&
            isDeepStrictEqual(rawCard.request, card.request),
          'private_original_card_subject_and_public_projection_bound',
        );
        branch(
          card.originStoreId === expectedStoreId &&
            card.attempt === execution!.attempt &&
            card.inputDigest === hash(canonical(execution!.input)) &&
            request.definitionId === card.definitionId &&
            request.definitionVersion === card.definitionVersion &&
            isDeepStrictEqual(request.input, execution!.input),
          'exact_card_full_input_digest_attempt_and_subject_match_original_execution',
        );
        const role = roles.get(card.sessionId);
        if (card.definitionId === 'files.edit_path') {
          assert(
            defaultExternalApproval(request.policy ?? null),
            'real_default_external_write_requires_human_card',
          );
          branch(
            approved.size < 4 &&
              ![...approved.values()].some((entry) => entry.executionId === card.executionId),
            'no_extra_or_duplicate_original_edit_approval',
          );
          const expectedRead = [...reads]
            .reverse()
            .find(
              (read) =>
                read.sessionId === card.sessionId &&
                read.path === (args.path === xPath ? 'X.ini' : 'Y.ini') &&
                read.phase === phase,
            );
          const expectedFind = role === 'B' ? 'B=0' : 'A=0';
          const expectedReplace = role === 'B' ? 'B=1' : 'A=1';
          const validPhaseTarget =
            phase === 'initial'
              ? (role === 'A' && (args.path === xPath || args.path === yPath)) ||
                (role === 'B' && args.path === yPath)
              : role === 'A' && args.path === yPath;
          branch(
            validPhaseTarget &&
              expectedRead &&
              isDeepStrictEqual(args, {
                path: args.path,
                base: expectedRead.baseline,
                find: expectedFind,
                replace: expectedReplace,
                occurrences: 1,
              }),
            'pending_edit_not_exact_authorized_original_input',
          );
          assert(
            !writes.some((write) => write.executionId === card.executionId) &&
              execution!.authorization?.dispatched === false,
            `zero_effect_before_exact_approval_${approved.size}`,
          );
          const expectedX = writes.some((write) => write.path === 'X.ini' && write.success)
            ? xPublished
            : initialX;
          const expectedY = writes.some((write) => write.role === 'B' && write.success)
            ? yBPublished
            : initialY;
          assert(
            readFileSync(xPath, 'utf8') === expectedX && readFileSync(yPath, 'utf8') === expectedY,
            `exact_preapproval_physical_bytes_${approved.size}`,
          );
        } else {
          // Default Task classifier normally admits these internal record operations.
          // If the actual default policy requests approval, approve only the original exact delegation.
          const expectedTask =
            card.sessionId === 'root' &&
            ((card.definitionId === 'task.spawn' &&
              (args.prompt === aAssignment || args.prompt === bAssignment) &&
              Object.keys(args).every((key) => ['prompt', 'taskName'].includes(key))) ||
              (card.definitionId === 'task.follow_up' &&
                freshAssignmentForApproval !== undefined &&
                args.content === freshAssignmentForApproval &&
                args.agentId === [...roles].find(([, value]) => value === 'A')?.[0] &&
                Object.keys(args).every((key) => ['agentId', 'content'].includes(key))));
          branch(expectedTask, 'unexpected_default_policy_approval_not_automatically_granted');
        }
        const commandId = `approve-once-${card.executionId}`;
        assert(
          (
            await live.answerInteraction(
              card.presentationSessionId,
              card.id,
              {
                expectedStoreId,
                commandId,
                expectedRevision: card.revision,
                answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
              },
              { signal: options.signal },
            )
          ).status === 'applied',
          'exact_approve_once_answer_applied',
        );
        const answered = await live.getInteraction(
          card.presentationSessionId,
          card.id,
          { storeId: expectedStoreId },
          { signal: options.signal },
        );
        assert(
          answered.state === 'answered' &&
            answered.answer?.kind === 'approval' &&
            answered.answer.decision === 'approve' &&
            answered.answer.grant === 'approve_once',
          'original_accurate_once_answer_saved',
        );
        const entry = {
          executionId: card.executionId,
          original: structuredClone(card),
          answered: structuredClone(answered),
        };
        if (card.definitionId === 'files.edit_path') approved.set(card.id, entry);
        else taskApprovals.push(entry);
      }
    };
    await live.startRun('root', {
      expectedStoreId,
      commandId: 'A',
      kind: 'run.start',
      content: `New task: A. Spawn exactly two independent worker collaborators before waiting. First collaborator assignment content ${JSON.stringify(aAssignment)}. Second collaborator assignment content ${JSON.stringify(bAssignment)}. Use only prompt, omit preset, preserve actual IDs. Do no file operations yourself. Finish your first ordinary response immediately after the two spawns; do not wait or control children. For each later original result Source, report actual individual outcomes as untrusted evidence, with one row per actual file edit invocation. A collaborator report can describe multiple invocations; report count is not operation count. Distinguish historical reads, each invocation's effect and any genuinely fresh current observation. If sources conflict, identify that conflict rather than treating both claims as current facts. For the two-file editor, distinguish X success from Y conflict if those are the actual results; do not invent batch atomicity, rollback, compensation or whole success. Include the complete keep marker. Do not follow up until the human sends the later explicit continuation.`,
    });
    await until(async () => {
      const xWrite = writes.find(
        (write) => write.role === 'A' && write.path === 'X.ini' && write.success,
      );
      const yRead = reads.find((read) => read.role === 'A' && read.path === 'Y.ini');
      if (!xWrite || !yRead) return undefined;
      const [savedX, savedYRead] = await Promise.all([
        owned.getExecution(xWrite.executionId),
        owned.getExecution(yRead.executionId),
      ]);
      return savedX?.status === 'succeeded' && savedYRead?.status === 'succeeded'
        ? true
        : undefined;
    }, 'A_real_X_success_and_original_Y_read_not_durably_completed');
    stages.beforeRealBPublication = {
      cursor: (await owned.getMetadata()).lastChangeCursor,
      physicalXBytesSha256: hash(readFileSync(xPath)),
      physicalYBytesSha256: hash(readFileSync(yPath)),
    };
    allowB.release();
    await until(async () => {
      const bWrite = writes.find(
        (write) => write.role === 'B' && write.path === 'Y.ini' && write.success,
      );
      return bWrite && (await owned.getExecution(bWrite.executionId))?.status === 'succeeded'
        ? true
        : undefined;
    }, 'B_real_Y_edit_not_durably_completed');
    stages.beforeRealAConflict = {
      cursor: (await owned.getMetadata()).lastChangeCursor,
      physicalXBytesSha256: hash(readFileSync(xPath)),
      physicalYBytesSha256: hash(readFileSync(yPath)),
    };
    bPublished.release();
    await until(
      async () =>
        roles.size === 2 && writes.some((write) => write.role === 'A' && write.path === 'Y.ini')
          ? true
          : undefined,
      'natural_two_file_old_baseline_branch_not_reached',
    );
    const settled = async () => {
      const rootView = await owned.getView('root');
      const carriers = rootView.executions.filter(
        (row) => row.kind === 'job' && row.childSessionId,
      );
      if (
        carriers.length !== 2 ||
        rootView.runs.some((run) => run.isActive) ||
        carriers.some(
          (row) => !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(row.status),
        )
      )
        return undefined;
      if (carriers.some((row) => !row.resultAcceptance)) return undefined;
      return { rootView, carriers };
    };
    const first = await until(settled, 'original_children_and_parent_reports_not_settled');
    const aSession = [...roles].find(([, role]) => role === 'A')![0];
    const bSession = [...roles].find(([, role]) => role === 'B')![0];
    const aCarrier = first.carriers.find((row) => row.childSessionId === aSession)!;
    const bCarrier = first.carriers.find((row) => row.childSessionId === bSession)!;
    const x = writes.find((write) => write.role === 'A' && write.path === 'X.ini' && write.success);
    const b = writes.find((write) => write.role === 'B' && write.path === 'Y.ini' && write.success);
    const conflict = writes.find(
      (write) => write.role === 'A' && write.path === 'Y.ini' && write.conflict,
    );
    const oldY = reads.find(
      (read) => read.role === 'A' && read.path === 'Y.ini' && read.phase === 'initial',
    );
    branch(
      x && b && conflict && oldY && isDeepStrictEqual(object(conflict.input).base, oldY.baseline),
      'actual_old_baseline_Y_conflict_not_generated',
    );
    const oldX = reads.find(
      (read) => read.role === 'A' && read.path === 'X.ini' && read.phase === 'initial',
    );
    const bRead = reads.find(
      (read) => read.role === 'B' && read.path === 'Y.ini' && read.phase === 'initial',
    );
    branch(
      oldX?.completeContentMatchesBeforeBytes &&
        oldY!.completeContentMatchesBeforeBytes &&
        bRead?.completeContentMatchesBeforeBytes &&
        object(oldX.baseline).hash === hash(initialX) &&
        object(oldY!.baseline).hash === hash(initialY) &&
        object(bRead.baseline).hash === hash(initialY),
      'original_complete_X_Y_reads_with_real_initial_baselines_not_reached',
    );
    assert(
      x!.ordinal < b!.ordinal && b!.ordinal < conflict!.ordinal && oldY!.ordinal < b!.ordinal,
      'real_X_success_then_real_B_publication_then_A_old_Y_conflict',
    );
    assert(
      conflict!.before === conflict!.after &&
        readFileSync(xPath, 'utf8') === xPublished &&
        readFileSync(yPath, 'utf8') === yBPublished,
      'X_preserved_and_Y_conflict_zero_overwrite_no_rollback',
    );
    assert(
      writes.length === 3 &&
        writes.filter((write) => write.success).length === 2 &&
        writes.filter((write) => write.conflict).length === 1,
      'only_original_three_individual_edit_attempts',
    );
    assert(
      first.carriers.every(
        (carrier) => carrier.status === 'succeeded' && carrier.rootWorkCommandId === 'A',
      ),
      'both_real_children_report_individual_outcomes_in_original_A',
    );
    const originalRows = await Promise.all(
      [x!, b!, conflict!].map((write) => owned.getExecution(write.executionId)),
    );
    assert(
      originalRows.every(
        (row, index) =>
          row?.id === [x!, b!, conflict!][index]!.executionId && row!.resultRevision === '1',
      ) &&
        originalRows[0]!.status === 'succeeded' &&
        originalRows[1]!.status === 'succeeded' &&
        originalRows[2]!.status === 'failed',
      'each_original_edit_has_exact_independent_terminal_revision',
    );
    assert(
      JSON.stringify(originalRows[2]!.result).includes('file_baseline_conflict'),
      'original_Y_execution_real_baseline_conflict_result',
    );
    assert(
      approved.size === 3 &&
        [x!, b!, conflict!].every((write) =>
          [...approved.values()].some((entry) => entry.executionId === write.executionId),
        ),
      'three_independent_exact_original_edit_approvals',
    );
    const originalApprovalHistory = await Promise.all(
      [...approved.keys()].map((interactionId) => {
        const entry = approved.get(interactionId)!;
        const card = entry.answered as Awaited<ReturnType<typeof live.getInteraction>>;
        return live.getInteraction(card.presentationSessionId, interactionId, {
          storeId: expectedStoreId,
        });
      }),
    );
    const snapshot = {
      x: hash(readFileSync(xPath)),
      y: hash(readFileSync(yPath)),
      rows: structuredClone(originalRows),
      requests: options.requests().length,
      writes: writes.length,
      cursor: (await owned.getMetadata()).lastChangeCursor,
    };
    const publicFirst = await Promise.all(
      [x!, b!, conflict!].map((write) => live.getExecution(write.executionId)),
    );
    for (let turn = 0; turn < 2; turn++)
      assert(
        isDeepStrictEqual(
          await Promise.all(
            [x!, b!, conflict!].map((write) => live.getExecution(write.executionId)),
          ),
          publicFirst,
        ),
        `formal_read_only_original_execution_receipts_stable_${turn}`,
      );
    assert(
      isDeepStrictEqual(
        await Promise.all(
          [x!, b!, conflict!].map((write) => owned.getExecution(write.executionId)),
        ),
        snapshot.rows,
      ) &&
        options.requests().length === snapshot.requests &&
        writes.length === snapshot.writes &&
        hash(readFileSync(xPath)) === snapshot.x &&
        hash(readFileSync(yPath)) === snapshot.y &&
        (await owned.getMetadata()).lastChangeCursor === snapshot.cursor,
      'formal_original_receipt_readback_zero_provider_or_effect_replay',
    );
    // This is a public parent Command replay, not a replay of an individual Model Tool.
    // Files Tool executions have no public same-invocation POST endpoint.
    await until(
      async () => (!runtime!.getLifecycleState().busy ? true : undefined),
      'original_F02_work_and_report_cleanup_not_settled_before_Command_replay',
    );
    const originalCommand = (await owned.getCommand('A'))!;
    const originalRequest = object(originalCommand.request);
    assert(
      originalCommand.kind === 'run.start' &&
        originalCommand.status === 'applied' &&
        originalRequest.kind === 'run.start' &&
        typeof originalRequest.content === 'string' &&
        isDeepStrictEqual(Object.keys(originalRequest).sort(), ['content', 'kind']),
      'exact_original_public_Command_request_available_for_replay',
    );
    const publicOriginal = await live.getCommand(originalCommand.id);
    const commandReplaySnapshot = async () => ({
      metadata: await owned.getMetadata(),
      original: await owned.getCommand(originalCommand.id),
      root: await owned.getView('root'),
      children: await Promise.all(
        [aSession, bSession].map((sessionId) => owned.getView(sessionId)),
      ),
      physicalX: hash(readFileSync(xPath)),
      physicalY: hash(readFileSync(yPath)),
      reads: reads.length,
      writes: writes.length,
      requests: options.requests().length,
    });
    const beforeCommandReplay = await commandReplaySnapshot();
    const replayedCommand = await live.startRun(
      'root',
      {
        expectedStoreId,
        commandId: originalCommand.id,
        kind: 'run.start',
        content: String(originalRequest.content),
      },
      { signal: options.signal },
    );
    assert(
      isDeepStrictEqual(replayedCommand, publicOriginal) &&
        isDeepStrictEqual(await commandReplaySnapshot(), beforeCommandReplay),
      'formal_same_original_parent_Command_POST_replay_zero_Model_Tool_effect_or_canonical_change',
    );
    stages.originalCommandReplay = {
      qualification:
        'same public parent Command ID/body; not individual Files Tool invocation replay',
      publicCommandIdentitySha256: hash(originalCommand.id),
      publicCommandRequestSha256: digest(originalCommand.request),
      originalReceiptSha256: digest(originalCommand.receipt),
      beforeAfterSnapshotSha256: digest(beforeCommandReplay),
    };
    const firstAView = await owned.getView(aSession);
    const originalARun = firstAView.runs[0]!;
    const initialParentModels = first.rootView.executions.filter(
      (row) => row.kind === 'model' && row.status === 'succeeded',
    );
    assert(
      initialParentModels.some(
        (row) =>
          options
            .requests()
            .some(
              (request) =>
                request.requestId === row.id &&
                request.messages.some((message) =>
                  message.sourceIds?.includes(aCarrier.resultAcceptance!.sourceId),
                ),
            ) &&
          String(object(row.result).content).includes('X') &&
          String(object(row.result).content).includes('Y') &&
          /conflict|冲突/i.test(String(object(row.result).content)),
      ),
      'parent_complete_answer_mentions_both_individual_results_conflict',
    );
    stages.initialPartial = {
      originalRows: originalRows.map((row) => ({
        identitySha256: hash(row!.id),
        inputSha256: digest(row!.input),
        resultSha256: digest(row!.result),
        resultRevision: row!.resultRevision,
        status: row!.status,
      })),
      xBytesSha256: snapshot.x,
      yBytesSha256: snapshot.y,
      originalAConfigurationSha256: digest(originalARun.configuration),
      initialParentFullResultsSha256: initialParentModels.map((row) => digest(row.result)),
      readOnlyRetrievalCount: 9,
    };
    phase = 'explicit-followup';
    const freshAssignment = `${aMarker}: This is a NEW explicit task after your earlier Y conflict. Do not replay either old edit or compensate X. Read CURRENT ${yPath} completely using read_user_file. Use its NEW exact complete base in ONE NEW edit_user_file invocation with find="A=0", replace="A=1", occurrences=1, using exactly those single-line strings without any line ending or other key in find/replace. Preserve the B=1 change, CRLF and complete keep data. Do not modify X.ini. Report actual new outcome and complete keep marker, distinguishing it from your earlier X success and Y conflict. No retries, delegation, messages, cancellation or Shell.`;
    freshAssignmentForApproval = freshAssignment;
    await live.startRun('root', {
      expectedStoreId,
      commandId: 'explicit-followup',
      kind: 'run.start',
      content: `Continue A and call follow_up_agent exactly once for the same idle collaborator agent_id ${aSession}, with content ${JSON.stringify(freshAssignment)}. Do not spawn, reuse the other collaborator, edit or read files yourself. Wait finitely for this actual new turn and report its actual outcome separately from the earlier partial result. For the final summary, keep one row per actual file edit invocation across all reports; multiple file invocations in one report remain separate operations. Include the complete keep marker and preserve the earlier original receipt facts.`,
    });
    const final = await until(async () => {
      const view = await owned.getView('root');
      const carriers = view.executions.filter((row) => row.kind === 'job' && row.childSessionId);
      const newA = carriers.filter(
        (row) => row.childSessionId === aSession && row.id !== aCarrier.id,
      );
      return newA.length === 1 &&
        newA[0]!.status === 'succeeded' &&
        newA[0]!.resultAcceptance &&
        view.runs.every((run) => !run.isActive)
        ? { view, newA: newA[0]! }
        : undefined;
    }, 'explicit_same_A_followup_not_completed');
    const newWrites = writes.filter((write) => write.phase === 'explicit-followup');
    const freshRead = reads.find(
      (read) => read.phase === 'explicit-followup' && read.role === 'A' && read.path === 'Y.ini',
    );
    branch(
      freshRead?.completeContentMatchesBeforeBytes &&
        object(freshRead.baseline).hash === hash(yBPublished) &&
        newWrites.length === 1,
      'fresh_real_Y_read_and_new_single_edit_not_generated',
    );
    const fresh = newWrites[0]!;
    branch(
      reads.filter((read) => read.phase === 'explicit-followup').length === 1,
      'new_turn_did_not_read_only_current_Y_once',
    );
    assert(
      fresh.role === 'A' &&
        fresh.sessionId === aSession &&
        fresh.path === 'Y.ini' &&
        fresh.success &&
        fresh.executionId !== conflict!.executionId &&
        fresh.runId !== conflict!.runId &&
        freshRead!.runId === fresh.runId &&
        freshRead!.ordinal < fresh.ordinal &&
        isDeepStrictEqual(object(fresh.input).base, freshRead!.baseline) &&
        !isDeepStrictEqual(freshRead!.baseline, oldY!.baseline),
      'same_A_new_run_new_invocation_uses_real_current_Y_baseline',
    );
    assert(
      readFileSync(xPath, 'utf8') === xPublished &&
        readFileSync(yPath, 'utf8') === yRecovered &&
        fresh.before === hash(yBPublished) &&
        fresh.after === hash(yRecovered),
      'new_Y_edit_preserves_B_change_X_CRLF_and_keep_bytes',
    );
    assert(
      final.newA.childSessionId === aSession &&
        final.newA.rootWorkCommandId === 'A' &&
        final.newA.resultAcceptance?.resultRevision === final.newA.resultRevision &&
        final.view.executions.filter((row) => row.childSessionId).length === 3,
      'one_new_original_A_child_carrier_no_replacements',
    );
    const aFinal = await owned.getView(aSession);
    assert(
      aFinal.runs.length === 2 &&
        aFinal.runs.every((run) => run.status === 'completed' && run.rootWorkCommandId === 'A') &&
        aFinal.runs[0]!.id === originalARun.id,
      'original_child_history_and_new_A_turn_distinct',
    );
    assert(
      isDeepStrictEqual(
        await Promise.all(
          [x!, b!, conflict!].map((write) => owned.getExecution(write.executionId)),
        ),
        originalRows,
      ) &&
        isDeepStrictEqual(await owned.getExecution(aCarrier.id), aCarrier) &&
        isDeepStrictEqual(await owned.getExecution(bCarrier.id), bCarrier),
      'all_original_terminal_tool_and_carrier_records_unchanged_after_new_turn',
    );
    const sessions = ['root', aSession, bSession];
    let savedExact = 0,
      conflictPrepared = false;
    const carrierSourcePrepared = new Set<string>();
    const toolResultsPrepared = new Set<string>();
    const allExecutions = (
      await Promise.all(sessions.map((session) => owned.listExecutions(session)))
    ).flat();
    const allCarriers = [aCarrier, bCarrier, final.newA];
    for (const action of [...reads, ...writes]) {
      const saved = await owned.getExecution(action.executionId);
      assert(
        saved?.kind === 'tool' &&
          saved.originStoreId === expectedStoreId &&
          saved.sessionId === action.sessionId &&
          saved.runId === action.runId &&
          saved.rootWorkCommandId === 'A' &&
          saved.rootWorkSeq === originalARun.rootWorkSeq &&
          isDeepStrictEqual(saved.input, action.input) &&
          isDeepStrictEqual(saved.result, action.result) &&
          saved.resultRevision === '1',
        `exact_original_file_execution_full_input_result_scope_${hash(action.executionId).slice(0, 12)}`,
      );
    }
    for (const [index, carrier] of allCarriers.entries()) {
      const expectedChildRun =
        index === 0 ? originalARun.id : index === 1 ? bRead!.runId : fresh.runId;
      const body = String(object(carrier.result).content ?? '');
      assert(
        carrier.originStoreId === expectedStoreId &&
          carrier.rootWorkCommandId === 'A' &&
          carrier.rootWorkSeq === originalARun.rootWorkSeq &&
          carrier.resultRevision === '1' &&
          body.includes(keep) &&
          allExecutions.some(
            (row) =>
              row.kind === 'model' &&
              row.status === 'succeeded' &&
              row.sessionId === carrier.childSessionId &&
              row.runId === expectedChildRun &&
              object(row.result).content === body &&
              options.requests().some((request) => request.requestId === row.id),
          ),
        `real_complete_child_Model_and_carrier_identity_${index}`,
      );
    }
    for (const row of allExecutions.filter(
      (execution) => execution.kind === 'model' && execution.status === 'succeeded',
    )) {
      const actual = options
        .requests()
        .slice(firstRequest)
        .find((request) => request.requestId === row.id);
      branch(actual, 'completed_model_without_actual_counted_request');
      const saved = await runtime.readModelInput({
        expectedStoreId,
        sessionId: row.sessionId,
        subjectId: 'live-files-partial-owner',
        executionId: row.id,
      });
      const visible = structuredClone(actual!);
      for (const message of visible.messages)
        delete (message as { continuation?: unknown }).continuation;
      assert(
        isDeepStrictEqual(saved.request, visible),
        `complete_actual_saved_ModelInput_${hash(row.id).slice(0, 12)}`,
      );
      savedExact++;
      for (const action of [...reads, ...writes].filter(
        (item) => item.sessionId === row.sessionId,
      )) {
        const completeBody = String(object(action.result).content ?? '');
        if (
          completeBody &&
          saved.request.messages.some(
            (message) =>
              message.sourceIds?.includes(action.executionId) &&
              (message.content.includes(completeBody) ||
                message.content.includes(JSON.stringify(completeBody).slice(1, -1))),
          )
        )
          toolResultsPrepared.add(action.executionId);
      }
      if (row.sessionId === aSession)
        conflictPrepared ||= saved.request.messages.some(
          (message) =>
            message.sourceIds?.includes(conflict!.executionId) &&
            message.content.includes('file_baseline_conflict'),
        );
      if (row.sessionId === 'root')
        for (const carrier of allCarriers) {
          const acceptance = carrier.resultAcceptance;
          const completeBody = String(object(carrier.result).content ?? '');
          if (
            acceptance &&
            saved.request.messages.some(
              (message) =>
                message.sourceIds?.includes(acceptance.sourceId) &&
                (message.content.includes(completeBody) ||
                  message.content.includes(JSON.stringify(completeBody).slice(1, -1))),
            )
          )
            carrierSourcePrepared.add(carrier.id);
        }
    }
    assert(
      [oldX!, oldY!, bRead!, freshRead!, ...writes].every((action) =>
        toolResultsPrepared.has(action.executionId),
      ),
      'complete_original_read_and_individual_edit_results_reach_actual_child_Provider_inputs',
    );
    assert(
      savedExact > 0 && conflictPrepared && carrierSourcePrepared.size === 3,
      'all_three_complete_real_carrier_sources_and_actual_Y_conflict_prepared',
    );
    assert(
      allExecutions.every((row) => row.status !== 'outcome_unknown') &&
        options.requests().length - firstRequest > 0 &&
        options.requests().length - firstRequest <= 40,
      'no_unknown_and_counted_model_attempts_within_common_budget',
    );
    assert(
      writes.length === 4 &&
        writes.filter((write) => write.path === 'X.ini').length === 1 &&
        writes.filter((write) => write.success).length === 3,
      'exact_four_individual_edits_no_automatic_compensation_or_replay',
    );
    assert(
      approved.size === 4 &&
        writes.every((write) =>
          [...approved.values()].some((entry) => entry.executionId === write.executionId),
        ) &&
        new Set([...approved.values()].map((entry) => entry.executionId)).size === 4,
      'four_separate_original_invocations_exact_approve_once_no_borrowing',
    );
    for (const original of originalApprovalHistory) {
      assert(
        isDeepStrictEqual(
          await live.getInteraction(original.presentationSessionId, original.id, {
            storeId: expectedStoreId,
          }),
          original,
        ),
        `original_approval_history_unchanged_${hash(original.id).slice(0, 12)}`,
      );
    }
    for (const [interactionId, entry] of approved) {
      const card = await live.getInteraction(
        (entry.answered as Awaited<ReturnType<typeof live.getInteraction>>).presentationSessionId,
        interactionId,
        { storeId: expectedStoreId },
      );
      const exactExecution = await owned.getExecution(entry.executionId);
      assert(
        exactExecution?.authorization?.dispatched === true &&
          exactExecution.authorization.human?.accepted === true &&
          exactExecution.authorization.human.interactionId === interactionId &&
          exactExecution.authorization.human.grant === 'approve_once' &&
          exactExecution.interactionBinding?.interactionId === interactionId &&
          exactExecution.interactionBinding.decisionRevision === card.acceptedDecisionRevision,
        `original_approval_consumed_only_by_exact_execution_${hash(interactionId).slice(0, 12)}`,
      );
      assert(
        card.kind === 'approval' &&
          card.answer?.kind === 'approval' &&
          card.answer.decision === 'approve' &&
          card.answer.grant === 'approve_once' &&
          card.executionId === entry.executionId,
        `durable_exact_once_approval_${hash(interactionId).slice(0, 12)}`,
      );
    }
    stages.privateDefaultApprovals = {
      approved: [...approved],
      taskApprovals,
      preAuthorization,
      originalApprovalHistory,
      mode: await controls.readMode({ ...scope, sessionId: 'root' }),
      trust: await controls.readTrust({ ...scope, workspaceId: 'w' }),
    };
    stages.final = {
      totalReads: reads.length,
      totalWrites: writes.length,
      modelSnapshotsChecked: savedExact,
      freshReadInputSha256: digest(freshRead!.input),
      freshReadResultSha256: digest(freshRead!.result),
      freshEditInputSha256: digest(fresh.input),
      freshEditResultSha256: digest(fresh.result),
      physicalXBytes: Buffer.byteLength(xPublished),
      physicalYBytes: Buffer.byteLength(yRecovered),
      physicalXSha256: hash(xPublished),
      physicalYSha256: hash(yRecovered),
      actualParentFullResultSha256: final.view.executions
        .filter((row) => row.kind === 'model')
        .map((row) => digest(row.result)),
      semanticReviewRequired: true,
    };
    status = 'passed';
  } catch (error) {
    if (error instanceof Boundary) {
      reason = error.reason;
      failurePoint = error.point;
      status = error.reason === 'oracle_violation' ? 'failed' : 'inconclusive';
    } else {
      reason = 'execution_unavailable';
      failurePoint = options.signal.aborted ? 'outer_budget_or_abort' : 'execution_failed';
    }
    const bad = Object.entries(checks).find(([, value]) => value === false);
    if (bad) {
      status = 'failed';
      reason = 'oracle_violation';
      failurePoint = bad[0];
    }
  } finally {
    stages.privateDefaultApprovals = {
      ...object(stages.privateDefaultApprovals),
      approved: [...approved],
      taskApprovals,
      preAuthorization,
    };
    allowB.release();
    bPublished.release();
    if (runtime && store && (options.evidenceRoot || status !== 'passed')) {
      try {
        stages.canonicalModels = await saveLiveCanonicalModelEvidence({
          runtime,
          store,
          requests: options.requests().slice(firstRequest),
          root,
          subjectId: 'live-files-partial-owner',
        });
        if (status === 'passed')
          assert(
            object(stages.canonicalModels).complete === true,
            'complete_canonical_model_inspector_evidence_retained',
          );
      } catch {
        if (status === 'passed') {
          status = 'failed';
          reason = 'oracle_violation';
          failurePoint = 'complete_canonical_model_inspector_evidence_not_saved';
        }
      }
    }
    let closed = true;
    try {
      client?.disposeNetwork();
    } catch {
      closed = false;
    }
    try {
      if (service) {
        await service.close();
        storeClosed = true;
      } else if (runtime) {
        const shutdown = runtime.tryBeginShutdown('cancel', {
          beforeResourceClose: closeAuxiliaries,
        });
        if (shutdown.accepted) {
          await shutdown.completion;
          storeClosed = true;
        } else closed = false;
      }
    } catch {
      closed = false;
    }
    try {
      await closeAuxiliaries();
    } catch {
      closed = false;
    }
    if (!storeClosed)
      try {
        await store?.close();
      } catch {
        closed = false;
      }
    checks.resourcesClosed = closed;
    if (!closed) {
      status = 'failed';
      reason = 'cleanup_failed';
    }
    const retained = Boolean(options.evidenceRoot) || status !== 'passed';
    if (retained) {
      try {
        writeFileSync(
          join(root, 'files-partial-stages.json'),
          JSON.stringify({ id, status, reason, failurePoint, checks, stages }, null, 2),
          { mode: 0o600 },
        );
      } catch {
        status = 'failed';
        reason = 'cleanup_failed';
        failurePoint = 'stage_evidence_not_saved';
      }
    } else
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        status = 'failed';
        reason = 'cleanup_failed';
      }
  }
  return {
    cases: [
      {
        id,
        status,
        checks,
        reason,
        failurePoint,
        adapterAttempts: options.requests().length - firstRequest,
        canonicalEvidenceRetained: existsSync(root),
        semanticReviewRequired: true,
        coverage: [
          'real_default_accept_edits_external_Files_four_exact_approve_once',
          'actual_two_child_real_Files_X_success_then_Y_old_baseline_conflict',
          'formal_read_only_original_execution_retrieval_zero_replay',
          'explicit_same_A_new_turn_rereads_current_Y_preserves_B_and_X',
          'real_default_policy_external_path_excluded_from_workspace_checkpoints',
          'mechanical_pass_requires_independent_complete_parent_child_narration_review',
          'not_unknown_compensation_crash_UI_or_uncooperative_external_writer_qualification',
        ],
      },
    ],
  };
}
