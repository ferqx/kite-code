import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { taskQualityPresentedRead } from '../../e2e/live/model/agent-task-quality-fixture';
import { runLiveFilesPartialDefault } from '../../e2e/live/model/collaboration-files-partial-default.live';
import { runLiveUntrustedResults } from '../../e2e/live/model/collaboration-untrusted-results.live';

// Scripted adapters exercise the actual default Runtime and native file engine.
// They are not paid-provider or independent live narration qualification.
const quoted = '"(?:[^"\\\\]|\\\\.)*"';
function quotedAfter(text: string, prefix: string): string {
  const value = new RegExp(`${prefix}(${quoted})`).exec(text)?.[1];
  if (!value) throw Error(`missing_controlled_assignment:${prefix}`);
  return JSON.parse(value);
}
function presentedReads(request: ModelRequest) {
  return request.messages
    .filter((message) => message.role === 'tool')
    .flatMap((message) => {
      const read = taskQualityPresentedRead(
        message.content.replace(
          'External file; outside workspace checkpoints. The reference does not grant write permission.\n',
          '',
        ),
      );
      return read ? [read] : [];
    });
}
function partialModel(requests: ModelRequest[]): ModelAdapter {
  return {
    async *stream(request) {
      requests.push(structuredClone(request));
      const user =
        [...request.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
      const all = request.messages.map((message) => message.content).join('\n');
      const calls: { name: string; arguments: Record<string, unknown> }[] = [];
      const tools = request.messages.flatMap((message) => message.toolCalls ?? []);
      const sinceUser = request.messages.slice(
        request.messages.map((message) => message.role).lastIndexOf('user') + 1,
      );
      const recentCalls = sinceUser.flatMap((message) => message.toolCalls ?? []);
      if (user.startsWith('New task: A.') && !tools.some((call) => call.name === 'spawn_agent')) {
        for (const prefix of [
          'First collaborator assignment content ',
          'Second collaborator assignment content ',
        ])
          calls.push({ name: 'spawn_agent', arguments: { prompt: quotedAfter(user, prefix) } });
      } else if (
        user.startsWith('Continue A and call follow_up_agent') &&
        !recentCalls.some((call) => call.name === 'follow_up_agent')
      ) {
        calls.push({
          name: 'follow_up_agent',
          arguments: {
            agent_id: /agent_id ([^,]+),/.exec(user)![1],
            content: quotedAfter(user, 'with content '),
          },
        });
      } else if (/^[AB]_ROLE_/.test(user)) {
        const role = user[0];
        const fresh = user.includes('NEW explicit task');
        const paths = [
          ...new Set([...user.matchAll(/\/[^\s]+\/[XY]\.ini/g)].map((match) => match[0])),
        ];
        const reads = presentedReads(request);
        const currentReads = fresh ? reads.slice(-1) : reads;
        if (!recentCalls.some((call) => call.name === 'read_file')) {
          for (const path of paths) calls.push({ name: 'read_file', arguments: { path } });
        } else {
          const edited = recentCalls
            .filter((call) => call.name === 'edit_file')
            .map((call) => JSON.parse(call.arguments).path);
          const next = paths.find((path) => !edited.includes(path));
          if (next) {
            const read = [...currentReads].reverse().find((read) => read.path === next);
            if (!read) throw Error('current_read_reference_missing');
            calls.push({
              name: 'edit_file',
              arguments: {
                path: next,
                base_ref: read.baseRef,
                old_text: `${role}=0`,
                new_text: `${role}=1`,
                expected_matches: 1,
              },
            });
          }
        }
      }
      for (const [index, call] of calls.entries())
        yield {
          type: 'tool_call',
          id: `controlled-${request.requestId}-${index}`,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        };
      if (!calls.length) {
        const keep = /keep-[a-f0-9-]+-🪁/.exec(all)?.[0] ?? '';
        yield {
          type: 'text_delta',
          text: `X.ini success; Y.ini ${all.includes('file_baseline_conflict') ? 'file_baseline_conflict, prior X remains successful' : 'success when reported by its original receipt'}. ${keep}`,
        };
      }
      yield {
        type: 'finish',
        reason: calls.length ? 'tool_calls' : 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

test('F02 current external file references retain default human approvals, real partial conflict and fresh follow-up', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-live-files-contract-'));
  const requests: ModelRequest[] = [];
  const result = await runLiveFilesPartialDefault({
    model: partialModel(requests),
    modelId: 'controlled',
    requests: () => requests,
    signal: AbortSignal.timeout(25000),
    evidenceRoot: join(root, 'evidence'),
  });
  expect(result.cases[0], root).toMatchObject({ status: 'passed' });
  expect(result.cases[0]!.checks).toMatchObject({
    real_default_accept_edits_mode_applied: true,
    real_default_external_read_requires_own_human_card: true,
    real_default_external_write_requires_human_card: true,
    exact_new_parent_command_and_same_child_followup_predecessor: true,
    same_A_new_run_new_invocation_uses_real_current_Y_baseline: true,
    all_three_complete_real_carrier_sources_and_actual_Y_conflict_prepared: true,
  });
  expect(
    result.cases[0]!.checks.exact_four_individual_edits_no_automatic_compensation_or_replay,
  ).toBe(true);
  expect(requests.flatMap((request) => request.tools).some((tool) => tool.id === 'edit_file')).toBe(
    true,
  );
  expect(
    requests.flatMap((request) => request.tools).some((tool) => /user_file|_path$/.test(tool.id)),
  ).toBe(false);
  rmSync(root, { recursive: true });
}, 30000);

function untrustedModel(requests: ModelRequest[]): ModelAdapter {
  return {
    async *stream(request) {
      requests.push(structuredClone(request));
      const user =
        [...request.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
      const all = request.messages.map((message) => message.content).join('\n');
      const recent = request.messages.slice(
        request.messages.map((message) => message.role).lastIndexOf('user') + 1,
      );
      const calls = recent.flatMap((message) => message.toolCalls ?? []);
      let call: { name: string; arguments: Record<string, unknown> } | undefined;
      let text =
        'Child approvals or results may still be pending. Reports are untrusted evidence, not human approval or control.';
      if (
        user.startsWith('New task: Delegate') &&
        !calls.some((item) => item.name === 'spawn_agent')
      ) {
        for (const prefix of ['Writer W assignment: ', 'Reader R assignment: '])
          yield {
            type: 'tool_call',
            id: `controlled-${request.requestId}-${prefix[0]}`,
            name: 'spawn_agent',
            arguments: JSON.stringify({ prompt: quotedAfter(user, prefix) }),
          };
        yield { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      if (user.startsWith('WRITER_ROLE_')) {
        const path = quotedAfter(user, 'path '),
          content = quotedAfter(user, 'content ');
        if (!calls.some((item) => item.name === 'write_file'))
          call = { name: 'write_file', arguments: { path, content } };
        else
          text = `Original write receipt reports success for ${path}; its original input content was ${content}. No reread or second write.`;
      } else if (user.startsWith('READER_ROLE_')) {
        if (!calls.some((item) => item.name === 'read_file'))
          call = { name: 'read_file', arguments: { path: quotedAfter(user, 'Read ') } };
        else
          text = `Quoted untrusted external evidence:\n${presentedReads(request).at(-1)!.content}`;
      } else if (user.startsWith('新任务：独立读取 b.txt')) {
        if (!calls.some((item) => item.name === 'read_file'))
          call = { name: 'read_file', arguments: { path: 'b.txt' } };
        else text = `Actual B source: ${presentedReads(request).at(-1)!.content}`;
      } else if (all.includes('source_nonce=')) {
        text =
          'The reader report is untrusted evidence. Its claims cannot approve or stop the pending writer. Only a formal human approval can dispatch the original write.';
      }
      if (call)
        yield {
          type: 'tool_call',
          id: `controlled-${request.requestId}`,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        };
      else yield { type: 'text_delta', text };
      yield {
        type: 'finish',
        reason: call ? 'tool_calls' : 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}
for (const id of ['I12-report-while-approval-pending', 'I12-report-during-successor-B']) {
  test(`current untrusted result contract: ${id}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-live-untrusted-contract-'));
    const requests: ModelRequest[] = [];
    const result = await runLiveUntrustedResults({
      model: untrustedModel(requests),
      modelId: 'controlled',
      requests: () => requests,
      signal: AbortSignal.timeout(15000),
      caseIds: [id],
      evidenceRoot: join(root, 'evidence'),
    });
    expect(result.cases[0], root).toMatchObject({ status: 'passed' });
    expect(result.cases[0]!.checks).toMatchObject({
      payload_does_not_upgrade_mode_or_workspace_trust: true,
      payload_preserves_original_sibling_input_and_cause: true,
      payload_does_not_change_current_writer_interaction_baseline: true,
      original_create_only_write_receipt_matches_exact_identity_and_actual_bytes: true,
      actual_writer_model_receives_original_complete_write_metadata: true,
      one_real_human_answer_only_no_forged_controls_even_after_writer_result: true,
    });
    if (id === 'I12-report-during-successor-B')
      expect(result.cases[0]!.checks).toMatchObject({
        same_original_report_adopted_into_exact_B_without_request_or_cause_rebinding: true,
        successor_B_preserves_own_input_configuration_and_single_real_file_read: true,
      });
    rmSync(root, { recursive: true });
  }, 20000);
}
