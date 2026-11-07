import { constants, Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ExecutionRecord, RunRecord, Store } from '@kite-ai/agent/storage';
import type { ModelEvent, ModelRequest } from '@kite-ai/ai';
import type { AgentClient } from '@kite-ai/client';
import {
  decodeShellProcessEvidence,
  shellProcessEvidenceEnded,
} from '../../../../packages/agent/src/jobs/shell-process-evidence';
import { canonicalJson } from '../../../../packages/agent/src/json';
import { dispatchScopeLeaves } from '../../../../packages/agent/src/permissions/dispatch-scope';
import { originalShellJobHandle } from '../../../fixtures/unified-agent/shell-model-feedback';

export const extendedToolGroups: Record<string, readonly string[]> = {
  'files-conflict': ['read_file', 'edit_file', 'shell_execute'],
  'shell-isolation': ['shell_execute', 'shell_read', 'shell_wait', 'shell_stop', 'write_file'],
  'permission-switch-workdir': ['shell_execute', 'read_file'],
  'worktree-mutation-observe': ['git_worktree'],
  'execution-timeout': ['shell_execute'],
  'agents-parallel-mail': ['spawn_agent', 'send_agent_message', 'wait_agent_events', 'list_agents'],
  'agent-interrupt-reuse': [
    'spawn_agent',
    'interrupt_agent',
    'follow_up_agent',
    'list_agents',
    'wait_agent_events',
  ],
  'approval-deny': [],
  'approval-external': ['shell_execute', 'read_file'],
  'active-guidance': ['shell_execute'],
  'client-reconnect': ['shell_execute'],
  'mcp-child-followup': ['spawn_agent', 'follow_up_agent'],
  'mcp-parent-boundary': ['spawn_agent'],
};
export interface ToolScenarioOptions {
  mode?: 'full' | 'accept_edits' | 'auto';
  approval?: 'approve' | 'deny';
  expectedStatus?: RunRecord['status'];
  expectedFailure?(execution: ExecutionRecord): boolean;
  beforeApproval?(): void | Promise<void>;
  onTick?(run: RunRecord): Promise<void>;
  verify?(
    executions: readonly ExecutionRecord[],
    run: RunRecord,
  ): Promise<Record<string, boolean | number>>;
}
interface Context {
  root: string;
  workspace: string;
  marker: string;
  store: Store;
  storeId: string;
  client(): AgentClient;
  reconnect(): Promise<void>;
  waitForRun(id: string, commandId: string, options?: ToolScenarioOptions): Promise<RunRecord>;
  run(id: string, prompt: string, plan?: boolean, options?: ToolScenarioOptions): Promise<void>;
  requests: readonly { request: ModelRequest; events: ModelEvent[] }[];
  interactions: readonly { sessionId: string; kind: string; decision: string }[];
  transport: readonly { method: string; path: string; cut?: boolean }[];
  rpc: readonly string[];
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function check(value: unknown, point: string): asserts value {
  if (!value) throw Error(`extended_tools_${point}`);
}
const resultDetails = (execution: ExecutionRecord) => object(object(execution.result).details);
const jobs = (executions: readonly ExecutionRecord[]) =>
  executions.filter((entry) => entry.definitionId === 'shell.command');
const carriers = (executions: readonly ExecutionRecord[]) =>
  executions.filter((entry) => entry.kind === 'job' && entry.childSessionId);

/** A freshness barrier is settled only by a new decision that actually completes the exact request. */
export function recoveredContextRefresh(
  tool: ExecutionRecord,
  executions: readonly ExecutionRecord[],
): boolean {
  const details = resultDetails(tool);
  const decision = object(tool.decisionSource);
  if (
    tool.kind !== 'tool' ||
    tool.status !== 'failed' ||
    tool.authorization?.dispatched !== false ||
    details.code !== 'context_refresh_required' ||
    details.adapterAttempted !== false ||
    details.dispatchCommitted !== false ||
    decision.kind !== 'model_decision' ||
    typeof decision.modelExecutionId !== 'string' ||
    executions.some((row) => row.parentExecutionId === tool.id)
  )
    return false;
  const index = executions.findIndex((row) => row.id === tool.id);
  return (
    index >= 0 &&
    executions.slice(index + 1).some((row) => {
      const nextDecision = object(row.decisionSource);
      return (
        row.kind === 'tool' &&
        row.status === 'succeeded' &&
        row.authorization?.dispatched === true &&
        row.originStoreId === tool.originStoreId &&
        row.sessionId === tool.sessionId &&
        row.runId === tool.runId &&
        row.rootWorkCommandId === tool.rootWorkCommandId &&
        row.rootWorkSeq === tool.rootWorkSeq &&
        row.definitionId === tool.definitionId &&
        row.definitionVersion === tool.definitionVersion &&
        row.stepId !== tool.stepId &&
        nextDecision.kind === 'model_decision' &&
        typeof nextDecision.modelExecutionId === 'string' &&
        nextDecision.modelExecutionId !== decision.modelExecutionId &&
        isDeepStrictEqual(row.input, tool.input)
      );
    })
  );
}

export async function runExtendedToolCases(c: Context) {
  const worktreeTarget = join(c.root, 'model-worktree-target');
  await c.run(
    'worktree-mutation-observe',
    `Use git_worktree to create exactly one worktree at ${JSON.stringify(worktreeTarget)} with new_branch:"model-worktree" and filesystem:"full_access". The user explicitly authorizes this synthetic target and the repository metadata change. Use only git_worktree, never Shell. After creation, observe it using action:"observe" and the exact returned operation_ref. Observation must not create another worktree or Job. Then use action:"remove", the exact target path and filesystem:"full_access" to remove that clean fixture worktree while retaining its branch. Do not edit files, change cwd or create another worktree. Report the actual three outcomes.`,
    false,
    {
      async verify(executions) {
        const tools = executions.filter((row) => row.definitionId === 'git.worktree');
        const created = tools.filter((row) => object(row.input).action === 'create');
        const removed = tools.filter((row) => object(row.input).action === 'remove');
        const observations = tools.filter((row) => object(row.input).action === 'observe');
        check(
          created.length === 1 &&
            removed.length === 1 &&
            observations.length >= 1 &&
            tools.every((row) => row.status === 'succeeded'),
          'worktree_original_operations',
        );
        const source = created[0]!;
        check(
          typeof resultDetails(source).operation_ref === 'string' &&
            String(resultDetails(source).operation_ref).length === 26,
          'worktree_short_reference',
        );
        check(
          observations.every(
            (row) =>
              resultDetails(row).original_execution_id === source.id &&
              resultDetails(row).phase === 'completed',
          ),
          'worktree_observes_original_owner',
        );
        check(
          !executions.some(
            (row) =>
              row.kind === 'job' &&
              observations.some((observer) => row.parentExecutionId === observer.id),
          ),
          'worktree_observation_zero_jobs',
        );
        check(
          executions.filter(
            (row) =>
              row.kind === 'job' &&
              [source.id, removed[0]!.id].includes(row.parentExecutionId ?? ''),
          ).length === 4,
          'worktree_mutations_once',
        );
        check(!existsSync(worktreeTarget), 'worktree_removed_original_target');
        check(
          tools.every((row) => resultDetails(row).cwdChanged === false),
          'worktree_cwd_preserved',
        );
        return { createCount: 1, removeCount: 1, observationJobs: 0, cwdPreserved: true };
      },
    },
  );
  const original = Array.from(
    { length: 250 },
    (_, index) => `第${String(index + 1).padStart(3, '0')}行:value=before\n`,
  ).join('');
  const paged = join(c.workspace, 'docs/分页 中文.txt');
  writeFileSync(paged, original);
  writeFileSync(join(c.workspace, 'docs/agent-a.txt'), `A-${c.marker}\n`);
  writeFileSync(join(c.workspace, 'docs/agent-b.txt'), `B-${c.marker}\n`);
  const lastReply = async (sessionId: string) =>
    (await c.store.listMessages(sessionId, { limit: 1000 }))
      .filter((message) => message.role === 'assistant' && message.content.trim())
      .at(-1)?.content ?? '';
  const saveChild = async (sessionId: string, label: string) => {
    const executions = await c.store.listExecutions(sessionId, 1000);
    const messages = await c.store.listMessages(sessionId, { limit: 1000 });
    const mail = await c.store.listAgentMessages({
      expectedStoreId: c.storeId,
      sessionId,
      subjectId: 'owner',
      limit: 100,
    });
    writeFileSync(
      join(c.root, `${label}-${sessionId}.json`),
      JSON.stringify({ executions, messages, mail }, null, 2),
    );
    return { executions, messages, mail };
  };

  let modeSwitches = 0;
  await c.run(
    'permission-switch-workdir',
    'Execute exactly one foreground shell_execute with workdir:"docs", filesystem:"workspace_write",network:"none" and command "pwd > switch-cwd; printf READY > switch-ready; while [ ! -f switch-release ]; do sleep 0.1; done; printf ONCE >> switch-count". The fixture will switch permission modes while this command is running and then release it. Do not create switch-release or relaunch the command. After it finishes, read docs/switch-count and docs/switch-cwd using read_file. Finally execute one separate shell_execute with command "pwd" and OMIT workdir, to show that the Session default directory was not changed. Report the actual directories and count.',
    false,
    {
      async onTick() {
        if (modeSwitches || !existsSync(join(c.workspace, 'docs/switch-ready'))) return;
        const initial = await c
          .client()
          .getPermissionMode('permission-switch-workdir', { storeId: c.storeId });
        const modes = ['accept_edits', 'auto', 'full'] as const;
        for (const mode of [...modes.filter((mode) => mode !== initial.mode), initial.mode]) {
          const state = await c
            .client()
            .getPermissionMode('permission-switch-workdir', { storeId: c.storeId });
          const changed = await c.client().setPermissionMode('permission-switch-workdir', {
            expectedStoreId: c.storeId,
            commandId: `switch-running-${++modeSwitches}`,
            mode,
            makeDefault: false,
            ifRevision: state.revision,
            ifDefaultRevision: state.defaultRevision,
          });
          check(changed.state === 'applied', 'running_mode_switch_applied');
        }
        writeFileSync(join(c.workspace, 'docs/switch-release'), 'release');
      },
      async verify(executions) {
        check(modeSwitches === 3, 'all_running_mode_transitions_observed');
        check(
          readFileSync(join(c.workspace, 'docs/switch-count'), 'utf8') === 'ONCE',
          'running_effect_exactly_once',
        );
        check(
          readFileSync(join(c.workspace, 'docs/switch-cwd'), 'utf8').trim() ===
            join(c.workspace, 'docs'),
          'actual_workdir',
        );
        const jobs = executions.filter(
          (row) => row.kind === 'job' && row.definitionId === 'shell.command',
        );
        check(
          jobs.length === 2 &&
            object(jobs[0]!.input).workdir === 'docs' &&
            object(jobs[1]!.input).workdir === undefined,
          'default_cwd_not_mutated',
        );
        return {
          modeSwitches,
          effectCount: 1,
          actualWorkdir: true,
          defaultDirectoryPreserved: true,
        };
      },
    },
  );

  await c.run(
    'files-conflict',
    "Synthetic conflict test with explicit authorization to induce one stale baseline failure. Read docs/分页 中文.txt using start_line:17,max_lines:3 and preserve its base_ref. Then shell_execute exactly: printf 'external-change\\n' >> 'docs/分页 中文.txt' with workspace_write/no-network. Now intentionally call edit_file ONCE using the OLD base_ref to replace 第017行:value=before with 第017行:value=after. It must return file_baseline_conflict. Read the same three-line window again, use its fresh base_ref for the separately authorized edit, and report the conflict and successful repair. Preserve every other line and the external-change suffix. Do not silently skip the deliberate conflict or repeat the rejected baseline.",
    false,
    {
      expectedFailure: (entry) =>
        entry.definitionId === 'files.edit' &&
        entry.status === 'failed' &&
        resultDetails(entry).code === 'file_baseline_conflict',
      async verify(executions) {
        const edits = executions.filter((entry) => entry.definitionId === 'files.edit');
        check(
          edits.length === 2 && edits[0]!.status === 'failed' && edits[1]!.status === 'succeeded',
          'conflict_then_fresh_edit',
        );
        check(resultDetails(edits[0]!).code === 'file_baseline_conflict', 'conflict_exact_code');
        check(
          readFileSync(paged, 'utf8') ===
            `${original.replace('第017行:value=before', '第017行:value=after')}external-change\n`,
          'conflict_preserved_complete_file',
        );
        const reads = executions.filter((entry) => entry.definitionId === 'files.read');
        check(
          reads.length >= 2 &&
            object(reads[0]!.input).offset === 17 &&
            object(reads[0]!.input).limit === 3,
          'paged_baseline_window',
        );
        return { staleRejected: true, freshEditSucceeded: true, completeFilePreserved: true };
      },
    },
  );

  await c.run(
    'shell-isolation',
    "Launch exactly TWO distinct background Shells using shell_execute with background:true, and keep the returned shell_id of A and B. Use shell_execute/read/wait/stop and write_file only. Never invent a placeholder command to represent a wait; zero observation means shell_wait with B's returned shell_id and wait_ms:0. Each uses workspace_write/no-network. A command: printf A_READY; while [ ! -f release-a ]; do sleep 0.1; done; printf A_DONE . B command: printf B_READY; while [ ! -f release-b ]; do sleep 0.1; done; printf B_DONE . Use shell_read to confirm both READY outputs, and shell_wait with wait_ms:0 for B to confirm that this observation does not stop it. Stop ONLY A with shell_stop with only A's returned shell_id. Wait for A's actual cancelled terminal. Then shell_read B again and confirm it is still running. Create release-b with write_file omitting base_ref for create-only, then wait for B to complete naturally and read B_DONE. Do not stop or relaunch B, or create release-a. Report each distinct terminal and whether stopping A affected B.",
    false,
    {
      async verify(executions) {
        const native = jobs(executions);
        check(native.length === 2, 'two_exact_shells');
        const a = native.find((entry) => String(object(entry.input).command).includes('A_READY'))!;
        const b = native.find((entry) => String(object(entry.input).command).includes('B_READY'))!;
        check(
          a?.status === 'cancelled' && b?.status === 'succeeded',
          'independent_shell_terminals',
        );
        check(
          originalShellJobStopped(
            executions.find((row) => row.id === a.parentExecutionId),
            a,
          ) &&
            originalShellJobStopped(
              executions.find((row) => row.id === b.parentExecutionId),
              b,
            ),
          'both_shell_trees_closed',
        );
        const reads = executions.filter((entry) => entry.definitionId === 'shell.read');
        const bTool = executions.find((entry) => entry.id === b.parentExecutionId);
        const bHandle = originalShellJobHandle(bTool, b);
        check(bHandle, 'original_B_runtime_handle');
        const bRunning = reads.filter(
          (entry) =>
            object(entry.input).shellId === bHandle &&
            object(resultDetails(entry).ref).executionId === b.id &&
            object(resultDetails(entry).execution).id === b.id &&
            object(resultDetails(entry).execution).status === 'running',
        );
        check(bRunning.length >= 2 && b.cancelRequestedAt === null, 'sibling_survived_stop');
        check(
          executions.filter((entry) => entry.definitionId === 'shell.stop').length === 1,
          'one_exact_stop_intent',
        );
        return { independentShells: 2, siblingNotCancelled: true, cleanupConfirmed: true };
      },
    },
  );

  await c.run(
    'execution-timeout',
    'Use shell_execute with command "printf TIMEOUT_STARTED; sleep 120", execution_timeout_ms:1500, workspace_write/no-network. This deliberately tests an execution deadline. Inspect the actual failed timeout result and original cancelled Job cleanup, do not retry it. Then issue a separate shell_execute with command "printf AFTER_TIMEOUT" and the same narrow permissions. Report the confirmed timeout and the later successful command.',
    false,
    {
      expectedFailure: (entry) =>
        entry.definitionId === 'shell.execute' &&
        entry.status === 'failed' &&
        resultDetails(entry).timedOut === true,
      async verify(executions) {
        const native = jobs(executions);
        check(
          native.length === 2 &&
            native[0]!.status === 'cancelled' &&
            native[1]!.status === 'succeeded',
          'deadline_cancel_then_continue',
        );
        check(
          originalShellJobStopped(
            executions.find((row) => row.id === native[0]!.parentExecutionId),
            native[0]!,
          ),
          'deadline_tree_stopped',
        );
        check(
          executions.some(
            (entry) =>
              entry.definitionId === 'shell.execute' && resultDetails(entry).timedOut === true,
          ),
          'deadline_fact_not_wait_timeout',
        );
        return {
          executionDeadlineObserved: true,
          cleanupConfirmed: true,
          laterCommandSucceeded: true,
        };
      },
    },
  );

  await c.run(
    'agents-parallel-mail',
    'Start exactly TWO default collaborators A and B before waiting for either to finish. Omit the preset field entirely: general is the default role. A reads docs/agent-a.txt; B reads docs/agent-b.txt. In each child prompt, require shell_execute with command "printf CHILD_READY; while [ ! -f release-agents ]; do sleep 0.1; done" using workspace_write/no-network, and wait for that exact Shell to finish before replying. They must use any received parent messages for the final color, then report exactly their own file token plus \':\' plus the final color. Tell both not to create release-agents themselves. Once both children are accepted and running, send_agent_message to A saying "Final color is BLUE" and to B saying "Final color is GREEN". Then use write_file omitting base_ref for create-only to create release-agents. Keep each returned work_ref. Wait for BOTH exact current child results using wait_agent_events with work_refs and list_agents and report both actual tokens/colors. Do not send their tokens to each other, invent results or start a third collaborator.',
    false,
    {
      async verify(executions) {
        const children = carriers(executions);
        check(
          children.length === 2 && children.every((entry) => entry.status === 'succeeded'),
          'parallel_children_succeeded',
        );
        const runs = await Promise.all(
          children.map(async (entry) => (await c.store.getView(entry.childSessionId!)).runs[0]!),
        );
        check(
          Math.max(...runs.map((run) => run.createdAt)) <
            Math.min(...runs.map((run) => run.finishedAt!)),
          'child_runs_overlap',
        );
        for (const child of children) {
          const saved = await saveChild(child.childSessionId!, 'parallel');
          check(
            saved.executions
              .filter((entry) => entry.kind === 'tool')
              .every((entry) => entry.status === 'succeeded'),
            'parallel_child_tools_succeeded',
          );
          const reply = await lastReply(child.childSessionId!);
          const a = reply.includes(`A-${c.marker}`);
          check(reply.includes(a ? ':BLUE' : `B-${c.marker}:GREEN`), 'child_actual_color');
          check(
            !reply.includes(a ? `B-${c.marker}` : `A-${c.marker}`),
            'child_results_not_crossed',
          );
          const mail = saved.mail.items.filter((item) => item.kind === 'message');
          check(
            mail.length === 1 &&
              mail[0]!.state === 'received' &&
              mail[0]!.receivedRunId ===
                runs.find((run) => run.sessionId === child.childSessionId)!.id,
            'active_mail_exact_run',
          );
        }
        return { concurrentChildren: 2, activeMessagesReceived: 2, isolatedResults: true };
      },
    },
  );

  await c.run(
    'agent-interrupt-reuse',
    'Spawn one default collaborator whose first instruction is to run shell_execute command "printf started > interrupt-ready; sleep 120" with workspace_write/no-network, then honestly report the outcome. Parent: use a separate shell_execute command "while [ ! -f interrupt-ready ]; do sleep 0.1; done; printf OBSERVED_READY" to observe actual child start. Then interrupt_agent for that exact child using its returned work_ref. Wait until list_agents confirms the interrupted work is terminal/idle. Reuse the SAME agent_id with follow_up_agent asking it to read docs/agent-a.txt and reply exactly REUSED: followed by that file\'s token; this new turn must not repeat the old Shell. Keep the new work_ref returned by follow_up_agent and wait for exactly that work using wait_agent_events with work_refs, then inspect the second turn\'s current successful result and report the interruption and actual reused answer. Do not spawn another agent or follow up before the interruption has settled.',
    false,
    {
      async verify(executions) {
        const children = carriers(executions);
        check(
          children.length === 2 && children[0]!.childSessionId === children[1]!.childSessionId,
          'interrupted_agent_reused',
        );
        check(
          children[0]!.status === 'cancelled' && children[1]!.status === 'succeeded',
          'interruption_before_successor',
        );
        const saved = await saveChild(children[0]!.childSessionId!, 'interrupt-reuse');
        const shell = jobs(saved.executions);
        check(
          shell.length === 1 &&
            shell[0]!.status === 'cancelled' &&
            originalShellJobStopped(
              saved.executions.find((row) => row.id === shell[0]!.parentExecutionId),
              shell[0]!,
            ),
          'interrupted_child_shell_stopped_once',
        );
        check(
          reusedAgentReplyMatches(await lastReply(children[0]!.childSessionId!), `A-${c.marker}`),
          'reused_child_actual_answer',
        );
        return { stableChildIdentity: true, oldShellNotReplayed: true, originalTreeStopped: true };
      },
    },
  );

  const denied = join(c.root, 'denied-external.txt');
  await c.run(
    'approval-deny',
    `Request exactly one shell_execute with command ${JSON.stringify(`printf denied > '${denied.replaceAll('\\', '/')}'`)} and filesystem:full_access,network:none. The fixture will deny its real approval. Do not retry, widen or substitute the command.`,
    false,
    {
      mode: 'accept_edits',
      approval: 'deny',
      expectedStatus: 'completed',
      beforeApproval() {
        check(!existsSync(denied), 'denial_before_effect');
      },
      expectedFailure: (entry) =>
        entry.definitionId === 'shell.execute' &&
        entry.status === 'failed' &&
        object(entry.result).content === 'approval_denied',
      async verify(executions) {
        check(!existsSync(denied) && jobs(executions).length === 0, 'denial_zero_native_dispatch');
        check(
          executions.filter((entry) => entry.definitionId === 'shell.execute').length === 1,
          'denied_command_not_retried',
        );
        check(
          c.interactions.filter(
            (item) => item.sessionId === 'approval-deny' && item.decision === 'deny',
          ).length === 1,
          'real_denial_answered_once',
        );
        return { approvalDenied: true, nativeDispatches: 0, externalEffects: 0 };
      },
    },
  );

  const approved = join(c.root, 'approved-external.txt');
  await c.run(
    'approval-external',
    `Use shell_execute with command ${JSON.stringify(`printf 'approved-${c.marker}' >> '${approved.replaceAll('\\', '/')}'`)} and explicit filesystem:full_access,network:none. Wait for the real Tool and Job approval cards; do not retry or change the operation. After execution read that absolute file using read_file and report its actual token.`,
    false,
    {
      mode: 'accept_edits',
      beforeApproval() {
        check(!existsSync(approved), 'approval_zero_effect_before_grant');
      },
      async verify(executions) {
        check(readFileSync(approved, 'utf8') === `approved-${c.marker}`, 'approved_effect_once');
        check(
          jobs(executions).length === 1 && jobs(executions)[0]!.status === 'succeeded',
          'approved_one_native_dispatch',
        );
        const job = jobs(executions)[0]!;
        const starter = executions.find((row) => row.id === job.parentExecutionId);
        const db = new Database(
          join(c.root, 'data', 'live-all-tools', 'core.db'),
          constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW,
        );
        try {
          const original = db
            .query<ShellDispatchRecord, [string]>(
              'SELECT id,session_id,origin_store_id,parent_execution_id,intent_json,dispatch_authorization_json,reference_json FROM execution WHERE id=?',
            )
            .get(job.id);
          check(
            original && originalExternalShellScope(starter, job, original),
            'approved_scope_preserved',
          );
        } finally {
          db.close(true);
        }
        check(
          c.interactions.filter(
            (item) => item.sessionId === 'approval-external' && item.decision === 'approve',
          ).length === 2,
          'tool_and_job_approved',
        );
        return { originalApprovals: 2, externalEffectCount: 1, requestedScopePreserved: true };
      },
    },
  );

  let guided = false;
  const guidanceIds = ['guide-first', 'guide-correction'];
  await c.run(
    'active-guidance',
    'First execute shell_execute command "printf ready > guidance-ready; while [ ! -f guidance-release ]; do sleep 0.1; done; printf GUIDANCE_RELEASED" with workspace_write/no-network. The fixture will send two real user guidance messages during that operation. After it finishes, follow the latest user guidance and report both check codes and the final color. Do not create guidance-release, guess the codes or finish before the command completes.',
    false,
    {
      async onTick(run) {
        if (guided || !existsSync(join(c.workspace, 'guidance-ready'))) return;
        guided = true;
        const inputs = [
          `First code FIRST-${c.marker}; color RED.`,
          `Correction: final color BLUE; second code SECOND-${c.marker}. Preserve both check codes.`,
        ];
        for (let index = 0; index < inputs.length; index++)
          await c.client().steer('active-guidance', {
            expectedStoreId: c.storeId,
            commandId: guidanceIds[index]!,
            kind: 'input.steer',
            targetRunId: run.id,
            contextSelectionId: run.contextSelectionId,
            content: inputs[index]!,
          });
        writeFileSync(join(c.workspace, 'guidance-release'), 'release');
      },
      async verify(_executions, run) {
        check(guided, 'guidance_active_window_reached');
        const messages = await c.store.listMessages('active-guidance', { limit: 1000 });
        const guides = messages.filter((message) =>
          guidanceIds.includes(message.originCommandId ?? ''),
        );
        check(
          guides.length === 2 &&
            guides[0]!.originCommandId === guidanceIds[0] &&
            guides[1]!.originCommandId === guidanceIds[1],
          'guidance_exact_order_once',
        );
        const input = c.requests.find((trace) =>
          trace.request.messages.some((message) => message.sourceIds?.includes(guidanceIds[1]!)),
        );
        check(
          input &&
            guidanceIds.every((id) =>
              input.request.messages.some((message) => message.sourceIds?.includes(id)),
            ),
          'guidance_original_sources_in_model',
        );
        const reply = await lastReply('active-guidance');
        check(
          reply.includes(`FIRST-${c.marker}`) &&
            reply.includes(`SECOND-${c.marker}`) &&
            reply.includes('BLUE'),
          'guidance_actual_final_answer',
        );
        check(
          (await c.store.getView('active-guidance')).runs.length === 1 &&
            run.originCommandId === 'run-active-guidance',
          'guidance_did_not_start_new_run',
        );
        return { activeGuidanceMessages: 2, originalSourceOrderPreserved: true, sameRun: true };
      },
    },
  );

  await c.run(
    'client-reconnect',
    `Remember the exact token RECONNECT-${c.marker}. Use shell_execute with command "printf once >> reconnect-effect.txt" and workspace_write/no-network, then reply with the token. The initial HTTP response will be lost; do not repeat the command.`,
    false,
    {
      async verify(_executions, first) {
        check(c.transport.filter((event) => event.cut).length === 1, 'physical_response_loss');
        const before = c.requests.length;
        const original = await c.client().getCommand('run-client-reconnect');
        const oldView = await c.client().getView('client-reconnect');
        await c.reconnect();
        check(
          JSON.stringify(await c.client().getCommand('run-client-reconnect')) ===
            JSON.stringify(original),
          'reconnect_original_command',
        );
        check(
          JSON.stringify((await c.client().getView('client-reconnect')).messages) ===
            JSON.stringify(oldView.messages),
          'reconnect_original_history',
        );
        check(c.requests.length === before, 'reconnect_reads_zero_model');
        await c.client().followUp('client-reconnect', {
          expectedStoreId: c.storeId,
          commandId: 'reconnect-new-input',
          kind: 'input.follow_up',
          afterRunId: first.id,
          contextSelectionId: first.contextSelectionId,
          content:
            'Using the original conversation, repeat the exact remembered RECONNECT token and then give 31 * 37. Do not run any tools or repeat the earlier file operation.',
        });
        const second = await c.waitForRun('client-reconnect', 'reconnect-new-input');
        check(
          second.status === 'completed' && second.id !== first.id,
          'reconnect_followup_completed',
        );
        const reply = await lastReply('client-reconnect');
        check(
          reconnectReplyMatches(reply, `RECONNECT-${c.marker}`),
          'reconnect_remembered_actual_context',
        );
        check(
          readFileSync(join(c.workspace, 'reconnect-effect.txt'), 'utf8') === 'once',
          'lost_reply_zero_effect_replay',
        );
        check(
          c.transport.filter(
            (event) =>
              event.method === 'POST' && event.path === '/v1/sessions/client-reconnect/commands',
          ).length === 2,
          'lost_reply_one_original_post_one_followup',
        );
        writeFileSync(
          join(c.root, 'reconnect-final-history.json'),
          JSON.stringify(await c.store.getView('client-reconnect'), null, 2),
        );
        return {
          physicalResponseCut: true,
          originalCommandRequeried: true,
          readReconnectZeroModel: true,
          fileEffectCount: 1,
        };
      },
    },
  );

  await c.run(
    'mcp-child-followup',
    'First, the PARENT must use list_mcp_sources and connect_mcp_server to synthetic, and search_mcp_tools for Echo so the actual remote schema is inside the parent tool ceiling. Do not call Echo in the parent. Only then spawn exactly one DEFAULT collaborator with NO preset field. Its first prompt: "Use list_mcp_sources and connect_mcp_server to connect to synthetic. Search for Echo with search_mcp_tools and call its actual dynamic echo_probe with value verified; report its exact token. Use the actual complete binding and tool schema; do not fabricate tokens." Wait for its actual successful current result. Then follow_up_agent on the SAME agent_id with this exact instruction: Use your inherited MCP source and the existing connection when valid. Call list_mcp_resources with its exact connection_ref, then read_mcp_resource with the returned resource_ref for synthetic://coverage/note. Do not reconstruct connection fields or hashes, invent values or replace references with names. Read the resource and report its actual token. Wait for the second actual successful result. Report both tokens. Do not spawn a second child or have the parent fetch the tokens itself.',
    false,
    {
      async verify(executions) {
        const children = carriers(executions);
        check(
          children.length === 2 &&
            children.every((entry) => entry.status === 'succeeded') &&
            children[0]!.childSessionId === children[1]!.childSessionId,
          'mcp_followup_same_child',
        );
        const saved = await saveChild(children[0]!.childSessionId!, 'mcp-followup');
        check(
          saved.executions
            .filter((entry) => entry.kind === 'tool')
            .every((entry) => entry.status === 'succeeded'),
          'mcp_child_tools_succeeded',
        );
        check(
          saved.executions.some(
            (entry) => entry.definitionId === 'mcp.resources.read' && entry.status === 'succeeded',
          ),
          'mcp_resource_in_followup',
        );
        const replies = saved.messages
          .filter((message) => message.role === 'assistant')
          .map((message) => message.content)
          .join('\n');
        check(
          replies.includes(`mcp-call-${c.marker}`) && replies.includes(`resource-${c.marker}`),
          'mcp_both_actual_child_tokens',
        );
        check(
          c.rpc.includes('tools/call') && c.rpc.includes('resources/read'),
          'mcp_actual_server_effects',
        );
        return { stableChild: true, sourceInheritedAcrossFollowup: true, actualMcpTokens: 2 };
      },
    },
  );

  const priorRemoteCalls = c.rpc.filter(
    (method) => method === 'tools/call' || method === 'resources/read',
  ).length;
  await c.run(
    'mcp-parent-boundary',
    'This is an explicit negative authorization-boundary test. The parent must NOT connect to MCP or discover its schema. Call spawn_agent with ONLY prompt and task_name properties; omit preset entirely. An empty preset string is invalid and is not omission. Spawn exactly one default collaborator asking it to connect to synthetic with list_mcp_sources/connect_mcp_server and call Echo. Wait for the actual current terminal using list_agents/wait_agent_events. The current parent tool ceiling does not contain a connected remote schema, so report the actual child_tool_scope_exceeds_parent failure honestly. Distinguish the unconnected PARENT from any CHILD metadata connection already recorded in its original Tool evidence. A terminal failure does not prove zero prior operations; explain what the evidence actually establishes and leave unobserved business effects unverified. Do not reconnect, follow up, retry, call a remote tool yourself or fabricate a token.',
    false,
    {
      async verify(executions) {
        const children = carriers(executions);
        check(
          children.length === 1 &&
            children[0]!.status === 'failed' &&
            object(children[0]!.result).content === 'child_tool_scope_exceeds_parent',
          'unconnected_parent_scope_rejected',
        );
        check(
          !executions.some((entry) => entry.definitionId === 'mcp.connect'),
          'negative_parent_never_connected',
        );
        check(
          c.rpc.filter((method) => method === 'tools/call' || method === 'resources/read')
            .length === priorRemoteCalls,
          'scope_failure_zero_remote_effects',
        );
        await saveChild(children[0]!.childSessionId!, 'mcp-parent-boundary');
        const evidence = object(object(object(children[0]!.result).details).evidence);
        check(
          Array.isArray(evidence.tools) &&
            evidence.tools.some(
              (tool) =>
                object(tool).tool === 'mcp.connect' &&
                object(object(tool).outcomes).succeeded === 1,
            ),
          'failed_child_keeps_metadata_receipt',
        );
        check(
          c.requests.some((trace) =>
            trace.request.messages.some(
              (message) =>
                message.role === 'user' &&
                message.content.includes(children[0]!.id) &&
                message.content.includes('"tool":"mcp.connect"') &&
                message.content.includes('"succeeded":1'),
            ),
          ),
          'failed_child_receipt_reaches_parent_model',
        );
        const reply = await lastReply('mcp-parent-boundary');
        check(
          reply.includes('child_tool_scope_exceeds_parent') && /connect|metadata/i.test(reply),
          'failed_child_report_distinguishes_metadata',
        );
        check(
          !/no MCP connection or schema discovery occurred/i.test(reply),
          'failed_child_does_not_invent_zero_metadata',
        );
        return { inheritedToolCeilingEnforced: true, unauthorizedRemoteEffects: 0 };
      },
    },
  );
}

export function parseAllToolMode(args: readonly string[]): 'accept_edits' | 'auto' | 'full' {
  const values = args.filter((arg) => arg.startsWith('--mode='));
  if (values.length > 1) throw Error('all_tools_mode_invalid');
  const mode = values[0]?.slice(7) ?? 'full';
  if (mode !== 'accept_edits' && mode !== 'auto' && mode !== 'full')
    throw Error('all_tools_mode_invalid');
  return mode;
}
/** Original Job identity and complete native ownership proof, never a cleanup boolean. */
export function originalShellJobStopped(
  starter: ExecutionRecord | undefined,
  job: ExecutionRecord,
): boolean {
  if (
    starter?.kind !== 'tool' ||
    starter.definitionId !== 'shell.execute' ||
    starter.definitionVersion !== '1' ||
    starter.authorization?.dispatched !== true ||
    job.kind !== 'job' ||
    job.definitionId !== 'shell.command' ||
    job.definitionVersion !== '1' ||
    !['succeeded', 'failed', 'cancelled'].includes(job.status) ||
    job.parentExecutionId !== starter.id ||
    job.sessionId !== starter.sessionId ||
    job.originStoreId !== starter.originStoreId ||
    job.rootWorkCommandId !== starter.rootWorkCommandId ||
    job.rootWorkSeq !== starter.rootWorkSeq ||
    !job.cancelWithParent ||
    object(job.input).command !== object(starter.input).command
  )
    return false;
  const reference = object(job.reference),
    details = resultDetails(job);
  if (
    reference.executionId !== job.id ||
    typeof reference.nonce !== 'string' ||
    !reference.nonce ||
    details.processTreeStopped !== true
  )
    return false;
  const data = object(details.ownedProcesses);
  if (data.coverage === 'windows-job-members') {
    // Current Windows owner has a closed Job and waited root; its cleanup field is not a macOS fallback.
    const root = object(data.root),
      group = object(data.job);
    return (
      data.version === 1 &&
      root.pid === reference.supervisorPid &&
      Number.isSafeInteger(root.pid) &&
      Number(root.pid) > 0 &&
      typeof root.creationTime === 'string' &&
      /^[1-9][0-9]{0,19}$/.test(root.creationTime) &&
      root.waitConfirmed === true &&
      Number.isInteger(root.exitCode) &&
      group.activeProcesses === 0 &&
      group.treeStopped === true &&
      data.closed === true &&
      data.closeUnknown === false &&
      details.cleanupConfirmed === true
    );
  }
  const binding = { sessionId: job.sessionId, executionId: job.id, nonce: reference.nonce };
  const ready = decodeShellProcessEvidence(reference.ownedProcesses, binding);
  const ended = decodeShellProcessEvidence(details.ownedProcesses, binding);
  if (!ready || !ended || ready.version !== ended.version || !shellProcessEvidenceEnded(ended))
    return false;
  if (ready.version === 1 && ended.version === 1)
    return (
      details.groupStopped === true &&
      reference.supervisorPid === ready.broker.pid &&
      reference.launchdGuardianPid === ready.guardian.pid &&
      reference.coalitionId === ready.coalition.id &&
      ready.ownerPid === ended.ownerPid &&
      ready.broker.pid === ended.broker.pid &&
      isDeepStrictEqual(ready.broker.birth, ended.broker.birth) &&
      ready.guardian.pid === ended.guardian.pid &&
      isDeepStrictEqual(ready.guardian.birth, ended.guardian.birth) &&
      isDeepStrictEqual(ready.root.identity, ended.root.identity) &&
      ready.coalition.id === ended.coalition.id &&
      ready.coalition.label === ended.coalition.label &&
      ready.coalition.domain === ended.coalition.domain
    );
  return (
    ready.version === 2 &&
    ended.version === 2 &&
    ready.owner.wrapper.pid === reference.supervisorPid &&
    ready.owner.ownerPid === ended.owner.ownerPid &&
    ready.owner.wrapper.pid === ended.owner.wrapper.pid &&
    ready.owner.wrapper.birth === ended.owner.wrapper.birth
  );
}

export function stoppedOriginalBackgroundShell(executions: readonly ExecutionRecord[]): boolean {
  const starters = executions.filter(
    (row) =>
      row.kind === 'tool' &&
      row.definitionId === 'shell.execute' &&
      object(row.input).background === true,
  );
  if (starters.length !== 1) return false;
  return executions.some(
    (job) =>
      originalShellJobHandle(starters[0], job) !== undefined &&
      job.status === 'cancelled' &&
      originalShellJobStopped(starters[0], job),
  );
}

export interface ShellDispatchRecord {
  id: string;
  session_id: string;
  origin_store_id: string;
  parent_execution_id: string;
  intent_json: string;
  dispatch_authorization_json: string;
  reference_json: string;
}

/** Sealed permission scope plus the original controlled native profile binding, not a Seatbelt-text reconstruction. */
export function originalExternalShellScope(
  starter: ExecutionRecord | undefined,
  job: ExecutionRecord,
  original: ShellDispatchRecord,
): boolean {
  try {
    if (
      !originalShellJobStopped(starter, job) ||
      original.id !== job.id ||
      original.session_id !== job.sessionId ||
      original.origin_store_id !== job.originStoreId ||
      original.parent_execution_id !== starter!.id ||
      !isDeepStrictEqual(JSON.parse(original.intent_json), job.input) ||
      !isDeepStrictEqual(JSON.parse(original.reference_json), job.reference)
    )
      return false;
    const authorization = JSON.parse(original.dispatch_authorization_json);
    if (
      authorization.allowed !== true ||
      authorization.definitionVersion !== job.definitionVersion ||
      authorization.inputDigest !==
        createHash('sha256').update(canonicalJson(job.input)).digest('hex')
    )
      return false;
    const expected = { filesystem: 'full_access', network: 'none' };
    if (
      object(starter!.input).filesystem !== expected.filesystem ||
      object(starter!.input).network !== expected.network ||
      !isDeepStrictEqual(object(job.input).permissions, expected)
    )
      return false;
    const leaves = [
      ...dispatchScopeLeaves(authorization.snapshot, 'original_dispatch_scope_unavailable'),
    ];
    if (
      !leaves.length ||
      leaves.some((leaf) => {
        const capability = object(leaf.data.capability);
        return (
          leaf.namespace !== 'builtin.permissions' ||
          capability.kind !== 'job' ||
          capability.definitionId !== job.definitionId ||
          capability.definitionVersion !== job.definitionVersion ||
          capability.hardAllowed !== true ||
          !isDeepStrictEqual(capability.executionScope, expected)
        );
      })
    )
      return false;
    const confinement = object(object(job.reference).confinement);
    return confinement.backend === 'macos-seatbelt'
      ? typeof confinement.profileDigest === 'string' &&
          /^[a-f0-9]{64}$/.test(confinement.profileDigest) &&
          confinement.subprocesses === 'coalition_owned'
      : confinement.backend === 'windows-full-job' &&
          confinement.filesystem === expected.filesystem &&
          confinement.network === expected.network;
  } catch {
    return false;
  }
}

export function reusedAgentReplyMatches(reply: string, token: string): boolean {
  const match = /^REUSED:\s*(.+)$/u.exec(reply.trim());
  return match?.[1] === token;
}

export function reconnectReplyMatches(reply: string, token: string): boolean {
  const exactTokens = reply.match(/RECONNECT-[a-f0-9-]{36}/g) ?? [];
  return (
    exactTokens.length > 0 &&
    exactTokens.every((value) => value === token) &&
    /(?<![\p{L}\p{N}_,-])(?:1147|1,147)(?![\p{L}\p{N}_,-]|[.,]\d)/u.test(reply)
  );
}
