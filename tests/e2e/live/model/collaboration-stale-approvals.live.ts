import { randomUUID } from 'node:crypto';
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
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { ClientError, createClient } from '@kite-ai/client';
import { startService } from '../../../../apps/service/src';
import { createDefaultProcessConfiguration } from '../../../../apps/service/src/configuration';

const ids = ['P03-old-answered', 'P03-old-denied', 'P03-old-cancelled'] as const;
export type LiveStaleApprovalCaseId = (typeof ids)[number];
interface Options {
  model: ModelAdapter;
  modelId: string;
  signal: AbortSignal;
  requests(): readonly ModelRequest[];
  caseIds?: readonly string[];
  evidenceRoot?: string;
}
interface Result {
  id: LiveStaleApprovalCaseId;
  status: 'passed' | 'failed' | 'inconclusive';
  checks: Record<string, boolean | number>;
  coverage: string[];
  canonicalEvidenceRetained: boolean;
  adapterAttempts: number;
  reason?: 'branch_not_reached' | 'oracle_violation' | 'execution_unavailable' | 'cleanup_failed';
  failurePoint?: string;
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
class Boundary extends Error {
  readonly reason: 'branch_not_reached' | 'oracle_violation';
  readonly point: string;
  constructor(reason: 'branch_not_reached' | 'oracle_violation', point: string) {
    super(point);
    this.reason = reason;
    this.point = point;
  }
}

/** Formal default policy. Private observation never creates an approval or substitutes a model. */
export async function runLiveStaleApprovals(options: Options): Promise<{ cases: Result[] }> {
  const selected = ids.filter((id) => !options.caseIds || options.caseIds.includes(id));
  if (
    options.evidenceRoot &&
    (!isAbsolute(options.evidenceRoot) || selected.length !== 1 || existsSync(options.evidenceRoot))
  )
    throw Error('live_stale_approval_evidence_invalid');
  const cases: Result[] = [];
  for (const id of selected) {
    options.signal.throwIfAborted();
    if (options.evidenceRoot) mkdirSync(options.evidenceRoot, { mode: 0o700 });
    const root = realpathSync(
      options.evidenceRoot ?? mkdtempSync(join(tmpdir(), 'kite-live-stale-approval-')),
    );
    const checks: Result['checks'] = {};
    const firstRequest = options.requests().length;
    let status: Result['status'] = 'inconclusive';
    let reason: Result['reason'];
    let failurePoint: string | undefined;
    let retained = false;
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let service: Awaited<ReturnType<typeof startService>> | undefined;
    let client: ReturnType<typeof createClient> | undefined;
    let locks: ReturnType<typeof createWorkspaceSerialLocks> | undefined;
    let locksClose: Promise<void> | undefined;
    const closeLocks = () => {
      if (!locks) return Promise.resolve();
      locksClose ??= locks.close();
      return locksClose;
    };
    const assert = (value: unknown, point: string) => {
      checks[point] = Boolean(value);
      if (!value) throw new Boundary('oracle_violation', point);
    };
    const branch = (value: unknown, point: string) => {
      if (!value) throw new Boundary('branch_not_reached', point);
    };
    async function until<T>(read: () => Promise<T | undefined>, point: string): Promise<T> {
      const end = Date.now() + 90_000;
      for (;;) {
        options.signal.throwIfAborted();
        const result = await read();
        if (result !== undefined) return result;
        if (Date.now() >= end) throw new Boundary('branch_not_reached', point);
        await Bun.sleep(20);
      }
    }
    try {
      const workspace = join(root, 'workspace');
      mkdirSync(workspace, { mode: 0o700 });
      const targets = [join(root, 'external-first.txt'), join(root, 'external-next.txt')];
      const contents = targets.map(() => `verified-stale-approval-${randomUUID()}`);
      const assignment = (index: number) =>
        `Use write_user_file exactly once to create ${JSON.stringify(targets[index])} with content ${JSON.stringify(contents[index])} and base null. Report its actual Tool result and include the complete exact content you actually wrote. Do not delegate. Do not retry denied work. Do not write any other path.`;
      const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'live' });
      mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
      const configurationPath = join(profile.profilePath, 'config.jsonc');
      writeFileSync(
        configurationPath,
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
            'files.write_path',
            'task.spawn',
            'task.follow_up',
            'task.message',
            'task.interrupt',
            'task.events',
            'task.list',
          ].map((id) => ({ id })),
        }),
        { mode: 0o600 },
      );
      const host = createDefaultProcessConfiguration({
        profile,
        userConfigurationPath: configurationPath,
        authorizationReview: {
          id: 'live.review',
          version: '1',
          modelId: options.modelId,
          model: options.model,
        },
      });
      store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
      const owned = store;
      const expectedStoreId = (await owned.getMetadata()).storeId;
      const dispatchCounts = new Map<string, number>();
      const dispatchProofs = new Map<
        string,
        Parameters<typeof owned.markDispatching>[0]['authorization']
      >();
      const originalMarkDispatching = owned.markDispatching.bind(owned);
      owned.markDispatching = async (input) => {
        const result = await originalMarkDispatching(input);
        dispatchCounts.set(input.executionId, (dispatchCounts.get(input.executionId) ?? 0) + 1);
        dispatchProofs.set(input.executionId, structuredClone(input.authorization));
        return result;
      };
      locks = createWorkspaceSerialLocks(profile);
      const inject = (binding: RunConfiguration): RunConfiguration => ({
        ...binding,
        model: options.model,
        permissions: {
          ...binding.permissions!,
          async authorize(request) {
            if (
              request.kind === 'tool' &&
              request.definitionId === 'files.write_path' &&
              !targets.includes(String(object(request.input).path))
            )
              return {
                allowed: false,
                revision: 'owned-stale-target-only-1',
                reason: 'live_target_out_of_scope',
              };
            return binding.permissions!.authorize(request);
          },
        },
      });
      runtime = createRuntime({
        ...host,
        store: owned,
        artifacts: createArtifactStore({ profile, store: owned }),
        permissions: host.permissions!,
        workspaceSerialLocks: locks,
        resolveRunConfiguration: async (input) =>
          inject(await host.resolveRunConfiguration!(input)),
        resolveChildRunConfiguration: async (input) =>
          inject(await host.resolveChildRunConfiguration!(input)),
        resolveRecoveryRunConfiguration: async (input) =>
          inject(await host.resolveRecoveryRunConfiguration!(input)),
      });
      const controls = host.permissionManagement!(runtime);
      const scope = { expectedStoreId, subjectId: 'live-owner' };
      service = await startService({
        runtime,
        subjectId: scope.subjectId,
        buildId: 'live-stale-approval',
        profile: {
          dataRoot: profile.dataRoot,
          name: profile.profile,
          accessKey: profile.profileAccessKey,
        },
        beforeResourceClose: closeLocks,
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
        name: 'synthetic',
        rootUri: pathToFileURL(workspace).href,
      });
      await live.createSession({
        expectedStoreId,
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        title: 'Explicit stale approval test',
      });
      const mode = await controls.readMode({ ...scope, sessionId: 's' });
      branch(
        (
          await controls.setMode({
            ...scope,
            sessionId: 's',
            commandId: 'mode',
            mode: 'accept_edits',
            makeDefault: false,
            ifRevision: mode.revision,
            ifDefaultRevision: mode.defaultRevision,
          })
        ).state === 'applied',
        'default_mode_not_applied',
      );
      const trust = await controls.readTrust({ ...scope, workspaceId: 'w' });
      branch(
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
        'default_trust_not_applied',
      );
      type Card = Awaited<ReturnType<typeof live.getInteraction>>;
      async function getCard(card: Card) {
        return live.getInteraction(card.presentationSessionId, card.id, {
          storeId: expectedStoreId,
        });
      }
      async function pendingWrite(index: number): Promise<Card> {
        return until(
          async () => {
            const cards = (
              await live.listInteractions('s', { storeId: expectedStoreId, state: 'pending' })
            ).interactions;
            for (const card of cards) {
              if (card.kind !== 'approval' || card.definitionId !== 'files.write_path') continue;
              const execution = await owned.getExecution(card.executionId!);
              if (object(execution?.input).path === targets[index]) return card;
            }
            return undefined;
          },
          index === 0
            ? 'first_actual_child_approval_not_reached'
            : 'second_actual_child_approval_not_reached',
        );
      }
      const approve = {
        kind: 'approval' as const,
        decision: 'approve' as const,
        grant: 'approve_once' as const,
      };
      const deny = { kind: 'approval' as const, decision: 'deny' as const };
      async function answer(card: Card, commandId: string, value: typeof approve | typeof deny) {
        const result = await live.answerInteraction(
          card.presentationSessionId,
          card.id,
          { expectedStoreId, commandId, expectedRevision: card.revision, answer: value },
          { signal: options.signal },
        );
        const command = await live.getCommand(commandId);
        const durable = await owned.getCommand(commandId);
        assert(
          command.kind === 'interaction.answer' &&
            command.status === 'applied' &&
            object(durable?.request).interactionId === card.id &&
            durable?.id === command.id &&
            isDeepStrictEqual(result, command),
          'answer_command_saved_to_exact_original_interaction',
        );
        return command;
      }
      await live.startRun('s', {
        expectedStoreId,
        commandId: 'work',
        kind: 'run.start',
        content: `New task: Create exactly one collaborator using spawn_agent with only prompt and no preset. Its complete task is ${JSON.stringify(assignment(0))}. You must not write files yourself. After spawn returns, finish your response with its accurate stable agent_id and delegation status. Do not wait, interrupt, send messages, replace, retry, follow up, or claim its write completed.`,
      });
      const first = await pendingWrite(0);
      const originalExecution = await owned.getExecution(first.executionId!);
      const carriers = (await owned.listExecutions('s')).filter((row) => row.childSessionId);
      branch(
        carriers.length === 1 &&
          originalExecution?.sessionId !== 's' &&
          first.sessionId === carriers[0]!.childSessionId,
        'first_exact_child_relation_not_reached',
      );
      const originalCarrier = carriers[0]!;
      const childId = originalCarrier.childSessionId!;
      const originalRun = await owned.getRun(first.runId!);
      assert(
        originalRun?.sessionId === childId &&
          originalRun.rootWorkCommandId === originalCarrier.rootWorkCommandId &&
          originalExecution?.runId === first.runId &&
          originalExecution.definitionId === 'files.write_path' &&
          originalExecution.authorization?.dispatched !== true &&
          first.answer === null &&
          first.acceptedDecisionRevision === null &&
          targets.every((path) => !existsSync(path)),
        'original_pending_default_approval_has_exact_lineage_and_zero_effect',
      );
      let firstAnswerCommand: Awaited<ReturnType<typeof answer>> | undefined;
      if (id === 'P03-old-cancelled') {
        await live.cancelExecution(
          's',
          {
            expectedStoreId,
            commandId: 'cancel-first',
            kind: 'execution.cancel',
            executionId: originalCarrier.id,
          },
          { signal: options.signal },
        );
      } else
        firstAnswerCommand = await answer(
          first,
          'original-answer',
          id === 'P03-old-answered' ? approve : deny,
        );
      await until(async () => {
        const execution = await owned.getExecution(originalCarrier.id);
        const view = await owned.getView(childId);
        const parent = await owned.getView('s');
        return execution &&
          ['succeeded', 'cancelled'].includes(execution.status) &&
          view.runs.length === 1 &&
          view.runs.every((run) => !run.isActive) &&
          parent.runs.length > 0 &&
          parent.runs.every((run) => !run.isActive) &&
          !parent.executions.some((row) =>
            ['planned', 'dispatching', 'running', 'queued'].includes(row.status),
          )
          ? true
          : undefined;
      }, 'original_round_and_parent_not_settled');
      const oldBefore = await getCard(first);
      const oldToolBefore = await owned.getExecution(first.executionId!);
      assert(
        oldBefore.state === (id === 'P03-old-answered' ? 'answered' : 'cancelled') &&
          (id === 'P03-old-cancelled'
            ? oldBefore.answer === null
            : object(oldBefore.answer).decision ===
              (id === 'P03-old-answered' ? 'approve' : 'deny')) &&
          (id === 'P03-old-answered'
            ? oldToolBefore?.status === 'succeeded' &&
              oldToolBefore.authorization?.dispatched === true &&
              existsSync(targets[0]!) &&
              readFileSync(targets[0]!, 'utf8') === contents[0]
            : oldToolBefore?.authorization?.dispatched !== true && !existsSync(targets[0]!)),
        'first_round_accurate_answered_denied_or_cancelled_history',
      );
      const firstParent = (await owned.getView('s')).runs.find(
        (run) => run.rootWorkCommandId === originalRun!.rootWorkCommandId,
      );
      branch(firstParent, 'original_parent_work_missing');
      await live.startRun('s', {
        expectedStoreId,
        commandId: 'continue-work',
        kind: 'run.start',
        content: `Continue ${firstParent!.rootWorkCommandId}.\nAsk the same collaborator ${childId} with follow_up_agent exactly once. Use this complete content exactly: ${JSON.stringify(assignment(1))}. Do not spawn a collaborator. Do not write files yourself. After follow_up_agent returns, finish your response with its actual acceptance status. Do not wait. Do not retry.`,
      });
      // task.follow_up has its own formal permission card under the current default strategy.
      await until(async () => {
        const current = (
          await live.listInteractions('s', { storeId: expectedStoreId, state: 'pending' })
        ).interactions;
        const second = current.find(
          (card) =>
            card.definitionId === 'files.write_path' &&
            card.sessionId === childId &&
            card.id !== first.id,
        );
        if (second) return true;
        for (const card of current) {
          if (card.kind !== 'approval' || card.definitionId !== 'task.follow_up') continue;
          const tool = await owned.getExecution(card.executionId!);
          assert(
            object(tool?.input).agentId === childId &&
              object(tool?.input).content === assignment(1),
            'second_parent_follow_up_approval_pins_same_child_and_actual_new_assignment',
          );
          await answer(card, 'approve-follow-up', approve);
        }
        return undefined;
      }, 'second_default_follow_up_not_admitted');
      const second = await pendingWrite(1);
      const secondExecution = await owned.getExecution(second.executionId!);
      const nextCarrier = (await owned.listExecutions('s')).find(
        (row) => row.childSessionId === childId && row.id !== originalCarrier.id,
      );
      const nextRun = await owned.getRun(second.runId!);
      const continueCommand = await owned.getCommand('continue-work');
      const continueReceipt = object(continueCommand?.receipt);
      const businessId = Object.hasOwn(continueReceipt, 'businessCommandId')
        ? continueReceipt.businessCommandId
        : continueCommand?.id;
      const continuedRuns = (await owned.getView('s')).runs.filter(
        (run) => run.originCommandId === businessId,
      );
      assert(
        typeof businessId === 'string' &&
          continuedRuns.length === 1 &&
          continuedRuns[0]?.id === continueReceipt.runId &&
          continuedRuns[0]?.rootWorkCommandId === originalRun!.rootWorkCommandId &&
          continuedRuns[0]?.rootWorkSeq === originalRun!.rootWorkSeq,
        'formal_continue_receipt_identifies_one_business_run_in_original_work',
      );
      assert(
        second.id !== first.id &&
          second.sessionId === childId &&
          second.runId !== first.runId &&
          second.executionId !== first.executionId &&
          nextCarrier &&
          nextCarrier.id !== originalCarrier.id &&
          nextRun?.sessionId === childId &&
          nextRun.id !== originalRun!.id &&
          nextRun.rootWorkCommandId === originalRun!.rootWorkCommandId &&
          nextRun.rootWorkSeq === originalRun!.rootWorkSeq &&
          nextCarrier.rootWorkCommandId === originalRun!.rootWorkCommandId &&
          nextCarrier.rootWorkSeq === originalRun!.rootWorkSeq &&
          secondExecution?.runId === nextRun.id &&
          secondExecution.authorization?.dispatched !== true &&
          second.state === 'pending' &&
          !existsSync(targets[1]!),
        'new_round_has_independent_exact_pending_approval_and_no_effect',
      );
      await until(async () => {
        const parent = await owned.getView('s');
        return parent.runs.every((run) => !run.isActive) &&
          !parent.executions.some(
            (row) =>
              row.kind !== 'job' && ['planned', 'dispatching', 'running'].includes(row.status),
          )
          ? true
          : undefined;
      }, 'second_parent_not_idle_before_history_replay');
      const baselineParentRunIds = new Set((await owned.getView('s')).runs.map((run) => run.id));
      const requestsBeforeStale = options.requests().length;
      const oldDispatch = oldToolBefore?.authorization?.dispatched;
      if (id === 'P03-old-cancelled') {
        const saved = await answer(first, 'late-cancelled-approve', approve);
        assert(
          object(saved.receipt).cancelled === true,
          'late_cancelled_answer_is_history_not_a_grant',
        );
      } else {
        const value = id === 'P03-old-answered' ? approve : deny;
        const replayed = await answer(first, 'original-answer', value);
        assert(
          isDeepStrictEqual(replayed, firstAnswerCommand),
          'original_answer_invocation_returns_original_command',
        );
        await answer(first, 'new-command-same-old-answer', value);
        let conflict = false;
        try {
          await live.answerInteraction(
            first.presentationSessionId,
            first.id,
            {
              expectedStoreId,
              commandId: 'new-command-opposite-old-answer',
              expectedRevision: first.revision,
              answer: id === 'P03-old-answered' ? deny : approve,
            },
            { signal: options.signal },
          );
        } catch (error) {
          if (error instanceof ClientError && error.code === 'interaction_answer_conflict')
            conflict = true;
          else throw error;
        }
        assert(
          conflict && (await owned.getCommand('new-command-opposite-old-answer')) === null,
          'opposite_old_answer_conflicts_without_new_command',
        );
      }
      const staleAfter = await getCard(first);
      const freshAfter = await getCard(second);
      const toolAfterStale = await owned.getExecution(first.executionId!);
      const newToolAfterStale = await owned.getExecution(second.executionId!);
      assert(
        staleAfter.sessionId === first.sessionId &&
          staleAfter.runId === first.runId &&
          staleAfter.executionId === first.executionId &&
          toolAfterStale?.rootWorkCommandId === originalExecution!.rootWorkCommandId &&
          toolAfterStale?.authorization?.dispatched === oldDispatch &&
          toolAfterStale?.status === oldToolBefore?.status &&
          freshAfter.state === 'pending' &&
          freshAfter.answer === null &&
          freshAfter.acceptedDecisionRevision === null &&
          newToolAfterStale?.authorization?.dispatched !== true &&
          newToolAfterStale?.cancelRequestedAt === null &&
          (await owned.getRun(second.runId!))?.status !== 'cancelling' &&
          !existsSync(targets[1]!),
        'all_settled_stale_answers_preserve_old_binding_and_leave_new_approval_pending',
      );
      if (id !== 'P03-old-answered')
        assert(
          staleAfter.state === 'cancelled' &&
            staleAfter.acceptedDecisionRevision === null &&
            !existsSync(targets[0]!),
          'denied_or_cancelled_history_never_dispatches',
        );
      else
        assert(
          staleAfter.acceptedDecisionRevision === oldBefore.acceptedDecisionRevision &&
            readFileSync(targets[0]!, 'utf8') === contents[0],
          'approved_old_effect_and_accepted_revision_remain_exact',
        );
      assert(
        options.requests().length === requestsBeforeStale,
        'history_answers_do_not_request_new_model',
      );
      await answer(second, 'approve-exact-new-round', approve);
      await until(async () => {
        const tool = await owned.getExecution(second.executionId!);
        const carrier = await owned.getExecution(nextCarrier!.id);
        const child = await owned.getView(childId);
        const parent = await owned.getView('s');
        return tool?.status === 'succeeded' &&
          carrier?.status === 'succeeded' &&
          carrier.resultAcceptance?.runId &&
          child.runs.every((run) => !run.isActive) &&
          parent.runs.every((run) => !run.isActive) &&
          !parent.executions.some((row) =>
            ['planned', 'dispatching', 'running', 'queued'].includes(row.status),
          )
          ? true
          : undefined;
      }, 'new_round_positive_control_not_completed');
      const acceptedCarrier = await owned.getExecution(nextCarrier!.id);
      const acceptance = acceptedCarrier?.resultAcceptance;
      branch(acceptance?.runId, 'new_result_not_accepted_to_parent');
      const acceptedParent = await owned.getRun(acceptance!.runId!);
      assert(
        acceptance!.resultRevision === acceptedCarrier!.resultRevision &&
          acceptance!.selectionId === acceptedParent?.contextSelectionId &&
          acceptedParent?.rootWorkCommandId === originalRun!.rootWorkCommandId &&
          acceptedParent?.rootWorkSeq === originalRun!.rootWorkSeq,
        'new_result_acceptance_pins_exact_revision_and_parent_selection',
      );
      const prepared = [];
      for (const request of options.requests().slice(firstRequest)) {
        const model = await owned.getExecution(request.requestId);
        if (model?.sessionId !== 's' || model.runId !== acceptance!.runId) continue;
        const sourceMessages = request.messages.filter((message) =>
          message.sourceIds?.includes(acceptance!.sourceId),
        );
        if (sourceMessages.length)
          prepared.push({
            sourceCount: sourceMessages.reduce(
              (n, message) =>
                n +
                (message.sourceIds?.filter((value) => value === acceptance!.sourceId).length ?? 0),
              0,
            ),
            content: sourceMessages.some((message) => message.content.includes(contents[1]!)),
          });
      }
      assert(
        prepared.length > 0 &&
          prepared.every((entry) => entry.sourceCount === 1) &&
          prepared.some((entry) => entry.content),
        'new_exact_source_and_actual_written_fact_enter_real_parent_model_once',
      );
      const exactNewApproval = await getCard(second);
      const finalNewTool = await owned.getExecution(second.executionId!);
      const finalOldTool = await owned.getExecution(first.executionId!);
      const finalOldCard = await getCard(first);
      assert(
        exactNewApproval.acceptedDecisionRevision !== null &&
          finalNewTool?.authorization?.dispatched === true &&
          dispatchProofs.get(second.executionId!)?.interactionId === second.id &&
          dispatchProofs.get(second.executionId!)?.decisionRevision ===
            exactNewApproval.acceptedDecisionRevision &&
          object(exactNewApproval.answer).decision === 'approve',
        'only_exact_new_human_answer_authorizes_new_dispatch',
      );
      assert(
        finalOldTool?.status === oldToolBefore?.status &&
          finalOldTool?.authorization?.dispatched === oldDispatch &&
          finalOldCard.acceptedDecisionRevision === oldBefore.acceptedDecisionRevision &&
          (dispatchCounts.get(first.executionId!) ?? 0) === (id === 'P03-old-answered' ? 1 : 0) &&
          dispatchCounts.get(second.executionId!) === 1,
        'history_replays_never_reenter_old_dispatch_after_positive_control',
      );
      const newParentRuns = (await owned.getView('s')).runs.filter(
        (run) => !baselineParentRunIds.has(run.id),
      );
      assert(
        newParentRuns.length === 1 && newParentRuns[0]?.id === acceptance!.runId,
        'only_new_result_acceptance_can_create_post_history_parent_run',
      );
      const childView = await owned.getView(childId);
      const allCarriers = (await owned.listExecutions('s')).filter((row) => row.childSessionId);
      const writes = childView.executions.filter((row) => row.definitionId === 'files.write_path');
      assert(
        allCarriers.length === 2 &&
          allCarriers.every((row) => row.childSessionId === childId) &&
          childView.runs.length === 2 &&
          writes.length === 2 &&
          writes.filter((row) => row.authorization?.dispatched).length ===
            (id === 'P03-old-answered' ? 2 : 1) &&
          writes.find((row) => row.id === second.executionId)?.status === 'succeeded' &&
          targets.every((path, index) =>
            index === 0 && id !== 'P03-old-answered'
              ? !existsSync(path)
              : existsSync(path) && readFileSync(path, 'utf8') === contents[index],
          ),
        'only_two_original_rounds_and_exact_independent_physical_effects',
      );
      assert(
        isDeepStrictEqual(
          (await owned.getExecution(first.executionId!))?.input,
          originalExecution!.input,
        ) &&
          isDeepStrictEqual(
            (await owned.getRun(first.runId!))?.configuration,
            originalRun!.configuration,
          ),
        'original_tool_and_run_configuration_immutable',
      );
      checks.staleAnswerCommandsSaved = id === 'P03-old-cancelled' ? 1 : 2;
      checks.realChildRounds = childView.runs.length;
      assert(
        options.requests().length - firstRequest <= 40,
        'adapter_attempts_within_original_case_budget',
      );
      status = 'passed';
    } catch (error) {
      if (error instanceof Boundary) {
        reason = error.reason;
        failurePoint = error.point;
        status = error.reason === 'oracle_violation' ? 'failed' : 'inconclusive';
      } else {
        reason = 'execution_unavailable';
        failurePoint = 'actual_default_service_or_provider_unavailable';
      }
    } finally {
      let failed = false;
      try {
        client?.disposeNetwork();
      } catch {
        failed = true;
      }
      let runtimeClosed = false;
      if (service) {
        try {
          await service.close();
          runtimeClosed = true;
        } catch {
          failed = true;
        }
      }
      if (!runtimeClosed && runtime) {
        try {
          await runtime.close();
          runtimeClosed = true;
        } catch {
          failed = true;
        }
      }
      if (!runtimeClosed && store) {
        try {
          await store.close();
        } catch {
          failed = true;
        }
      }
      try {
        await closeLocks();
      } catch {
        failed = true;
      }
      checks.resourcesClosed = !failed;
      if (failed) {
        status = 'failed';
        reason = 'cleanup_failed';
      }
      retained = Boolean(options.evidenceRoot) || status !== 'passed';
      if (!retained) {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          status = 'failed';
          reason = 'cleanup_failed';
          checks.resourcesClosed = false;
          retained = existsSync(root);
        }
      }
    }
    cases.push({
      id,
      status,
      checks,
      adapterAttempts: options.requests().length - firstRequest,
      canonicalEvidenceRetained: retained,
      coverage: [
        'formal_default_policy_same_child_two_rounds',
        'actual_client_historical_answer_replays_and_conflict',
        'new_pending_approval_unaffected_then_exact_positive_control',
        'exact_original_result_source_in_real_parent_model',
        'not_ordinary_window_late_click_or_missing_job_report_lineage',
      ],
      ...(reason ? { reason } : {}),
      ...(failurePoint ? { failurePoint } : {}),
    });
  }
  return { cases };
}
