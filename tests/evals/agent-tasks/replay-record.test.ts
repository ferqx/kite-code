import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '@/core/config';
import { createChatModel } from '@/core/model/factory';
import { StrictModelReplayCatalogV1 } from '@/core/model/replay-catalog';
import type { ModelResponseSourceV1 } from '@/core/model/response-source';
import type { ModelAttemptOutcomeV1 } from '@/protocol/model-surface';
import {
  assertModelReplayRecordExecutionContextV1,
  createModelReplayRecordStagingDirectoryV1,
  readModelReplayRecordCredentialV1,
  recordModelReplayCandidateV1,
  resolveModelReplayRepositoryRootV1,
  sanitizeModelReplayRecordOutcomeV1,
} from '../../../scripts/evals/model-replay-record';
import { PS03_LOCAL_SUBAGENT_CANDIDATE_SUITE_ID_V1 } from '../../../scripts/evals/model-replay-subagent-journey';

const COMMIT = '1'.repeat(40);
const CONFIG: AgentConfig = {
  providerName: 'record-test',
  providerType: 'openai-compatible',
  apiKey: '',
  baseURL: 'https://record-test.invalid/v1',
  modelName: 'record-test',
  sandbox: { enabled: false },
  features: { providerDataPolicyV1: false },
};
const MODEL = createChatModel(CONFIG);

describe('RP-03 trusted local replay baseline record flow', () => {
  test('admits only an interactive clean authority-bound upstream checkout without env credentials', () => {
    const allowed = {
      interactive: true,
      environmentKeys: ['PATH', 'SHELL'],
      authority: 'github:@ferqx',
      confirmation: 'record-synthetic-model-replay',
      candidateCommit: COMMIT,
      headCommit: COMMIT,
      worktreeDirty: false,
      remoteUrl: 'https://github.com/ferqx/kite-code.git',
      upstreamReference: 'origin/main',
      upstreamCommit: COMMIT,
    };
    expect(() => assertModelReplayRecordExecutionContextV1(allowed)).not.toThrow();
    for (const changed of [
      { interactive: false },
      { environmentKeys: ['CI'] },
      { environmentKeys: ['DEEPSEEK_API_KEY'] },
      { environmentKeys: ['GITHUB_TOKEN'] },
      { environmentKeys: ['GH_TOKEN'] },
      { environmentKeys: ['AWS_SECRET_ACCESS_KEY'] },
      { environmentKeys: ['GIT_CONFIG_COUNT'] },
      { authority: 'github:@someone-else' },
      { confirmation: 'yes' },
      { headCommit: '2'.repeat(40) },
      { upstreamCommit: '2'.repeat(40) },
      { upstreamReference: 'fork/main' },
      { worktreeDirty: true },
      { remoteUrl: 'https://github.com/fork/kite-code.git' },
    ]) {
      expect(() => assertModelReplayRecordExecutionContextV1({ ...allowed, ...changed })).toThrow(
        'MODEL_REPLAY_RECORD_CONTEXT_DENIED',
      );
    }
  });

  test('resolves the Git worktree root even when invoked from a repository subdirectory', () => {
    const start = join(process.cwd(), 'tests');
    let observedStart = '';
    expect(
      resolveModelReplayRepositoryRootV1(start, (value) => {
        observedStart = value;
        return process.cwd();
      }),
    ).toBe(realpathSync.native(process.cwd()));
    expect(observedStart).toBe(start);
  });

  test('requires an owner-only credential and a new staging directory outside the worktree', () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-replay-record-boundary-'));
    const repositoryRoot = join(root, 'repo');
    const credentialFile = join(root, 'credential');
    const credentialLink = join(root, 'credential-link');
    const stagingDirectory = join(root, 'model-replay-record-test');
    mkdirSync(repositoryRoot);
    writeFileSync(credentialFile, 'synthetic-record-credential', { mode: 0o600 });
    chmodSync(credentialFile, 0o600);
    symlinkSync(credentialFile, credentialLink);
    try {
      expect(readModelReplayRecordCredentialV1({ credentialFile, repositoryRoot })).toBe(
        'synthetic-record-credential',
      );
      expect(() =>
        readModelReplayRecordCredentialV1({
          credentialFile: credentialLink,
          repositoryRoot,
        }),
      ).toThrow('MODEL_REPLAY_RECORD_CREDENTIAL_DENIED');
      const created = createModelReplayRecordStagingDirectoryV1({
        stagingDirectory,
        repositoryRoot,
      });
      expect(created).toBe(realpathSync.native(stagingDirectory));
      expect(() =>
        createModelReplayRecordStagingDirectoryV1({
          stagingDirectory: join(repositoryRoot, 'model-replay-record-inside'),
          repositoryRoot,
        }),
      ).toThrow('MODEL_REPLAY_RECORD_STAGING_DENIED');
      chmodSync(credentialFile, 0o644);
      expect(() => readModelReplayRecordCredentialV1({ credentialFile, repositoryRoot })).toThrow(
        'MODEL_REPLAY_RECORD_CREDENTIAL_DENIED',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('sanitizes Provider identity and rejects secret-shaped outcome content', () => {
    const safe = sanitizeModelReplayRecordOutcomeV1({
      outcome: successOutcome('safe synthetic response'),
      purpose: 'primary_agent',
      actor: { kind: 'parent' },
      logicalInvocationOrdinal: 1,
      attemptOrdinal: 1,
    });
    expect(safe.kind === 'success' ? safe.response.providerMetadata : null).toEqual({
      responseId: 'cassette-response-record-primary_agent-parent-1-1',
      rawFinishReason: null,
    });
    const secret = ['sk', 'proj', '0123456789abcdefghijklmnopqrstuvwxyz'].join('-');
    expect(() =>
      sanitizeModelReplayRecordOutcomeV1({
        outcome: successOutcome(secret),
        purpose: 'primary_agent',
        actor: { kind: 'parent' },
        logicalInvocationOrdinal: 1,
        attemptOrdinal: 1,
      }),
    ).toThrow('MODEL_REPLAY_RECORD_PRIVACY_REJECTED');
    expect(() =>
      sanitizeModelReplayRecordOutcomeV1({
        outcome: successOutcome('ordinary-looking-record-credential'),
        purpose: 'primary_agent',
        actor: { kind: 'parent' },
        logicalInvocationOrdinal: 1,
        attemptOrdinal: 1,
        knownSecrets: ['ordinary-looking-record-credential'],
      }),
    ).toThrow('MODEL_REPLAY_RECORD_PRIVACY_REJECTED');
  });

  test('stages reviewed candidate catalogs without installing or approving them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-replay-record-candidate-'));
    const stagingDirectory = join(root, 'staging');
    mkdirSync(stagingDirectory);
    let attempts = 0;
    const live: ModelResponseSourceV1 = {
      mode: 'live',
      attempt: async (input) => {
        attempts += 1;
        if (input.context.replayBinding?.suiteId === PS03_LOCAL_SUBAGENT_CANDIDATE_SUITE_ID_V1) {
          return input.context.replayBinding.actor.kind === 'subagent' &&
            input.context.replayBinding.actor.continuationId === null
            ? toolCallOutcome('bun run typecheck')
            : successOutcome('safe synthetic subagent continuation');
        }
        return successOutcome(`safe synthetic response ${attempts}`);
      },
    };
    try {
      const report = await recordModelReplayCandidateV1({
        config: CONFIG,
        model: MODEL,
        stagingDirectory,
        suiteRevision: 2,
        liveSource: live,
      });
      expect(report).toEqual({
        schema: 'ModelReplayRecordCandidateReportV1',
        status: 'candidate_staged',
        suiteRevision: 2,
        pilotRecordCount: 6,
        riskRecordCount: 6,
        localSubagentRecordCount: 2,
        localSubagentReplayPreflight: 'passed',
        contentLogged: false,
      });
      expect(attempts).toBe(11);
      const pilot = readFileSync(join(stagingDirectory, 'pilot-candidate-v2.jsonl'), 'utf8');
      const risk = readFileSync(join(stagingDirectory, 'risk-candidate-v2.jsonl'), 'utf8');
      const localSubagentPath = join(
        stagingDirectory,
        'subagent-start-blocked-resume-candidate-v2.jsonl',
      );
      const localSubagent = readFileSync(localSubagentPath, 'utf8');
      expect(() => StrictModelReplayCatalogV1.parse(pilot.slice(0, -1))).not.toThrow();
      expect(() => StrictModelReplayCatalogV1.parse(risk.slice(0, -1))).not.toThrow();
      expect(() => StrictModelReplayCatalogV1.parse(localSubagent.slice(0, -1))).not.toThrow();
      const localCatalog = JSON.parse(localSubagent) as {
        suite: { suiteId: string };
        records: unknown[];
      };
      expect(localCatalog.suite.suiteId).toBe(PS03_LOCAL_SUBAGENT_CANDIDATE_SUITE_ID_V1);
      expect(localCatalog.records).toHaveLength(2);
      expect(statSync(localSubagentPath).mode & 0o777).toBe(0o600);
      const riskCatalog = JSON.parse(risk) as {
        records: Array<{ outcome: { kind: string } }>;
      };
      expect(riskCatalog.records.map((record) => record.outcome.kind)).toEqual([
        'retryable_failure',
        'success',
        'fatal_failure',
        'aborted',
        'success',
        'success',
      ]);
      const index = JSON.parse(
        readFileSync(join(stagingDirectory, 'candidate-index-v2.json'), 'utf8'),
      );
      expect(index).toMatchObject({
        status: 'candidate',
        approval: 'absent',
        installAutomatically: false,
        localSubagent: {
          suiteId: PS03_LOCAL_SUBAGENT_CANDIDATE_SUITE_ID_V1,
          recordCount: 2,
          replayPreflight: 'passed',
        },
        contentLogged: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function successOutcome(text: string): ModelAttemptOutcomeV1 {
  return {
    schema: {
      name: 'kite.model-attempt-outcome',
      version: 1,
      canonicalizerVersion: 'kite.model-surface.canonical-json.v1',
    },
    kind: 'success',
    nativeReplayState: null,
    response: {
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0 },
      providerMetadata: { responseId: 'raw-provider-response-id', rawFinishReason: 'stop' },
    },
  };
}

function toolCallOutcome(command: string): ModelAttemptOutcomeV1 {
  return {
    schema: {
      name: 'kite.model-attempt-outcome',
      version: 1,
      canonicalizerVersion: 'kite.model-surface.canonical-json.v1',
    },
    kind: 'success',
    nativeReplayState: null,
    response: {
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            toolCallId: 'raw-tool-call',
            toolName: 'shell_execute',
            input: { command },
          },
        ],
      },
      finishReason: 'tool_calls',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0 },
      providerMetadata: { responseId: 'raw-provider-response', rawFinishReason: null },
    },
  };
}
