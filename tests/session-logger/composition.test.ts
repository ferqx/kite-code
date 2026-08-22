import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeEvent } from '@kite/agent-kernel';
import { aiMessage, createModelSecretDetectorV1 } from '@kite/builtin-runtime/model';
import { classifyFailure } from '#app/bootstrap/runtime/failures';
import {
  type AgentConfig,
  loadAgentConfig,
  resolveSessionLoggingPolicyV1,
  type SessionLoggingPolicyV1,
} from '#app/config';
import { sessionLogDir } from '#app/config/paths';
import { SessionLogCollector } from '#app/session-logger';
import { buildRunAgentParams } from '../../apps/kite/src/bootstrap/runtime/runtime-agent-input';
import { openState26Store5ForTestV1 } from '../../scripts/support/runtime-storage';
import { CURRENT_TEST_PLAN_REVIEW_FACTS } from '../helpers/current-plan';
import { runTestRuntimeAgentV1 } from '../helpers/runtime-model';
import { createMockModel } from '../mock-model';

const CONTENT_ARTIFACT_POLICY: SessionLoggingPolicyV1 = {
  version: 1,
  mode: 'content',
  retentionDays: 7,
  maxTotalBytes: 256 * 1024 * 1024,
  maxSessionBytes: 16 * 1024 * 1024,
  includeReasoning: false,
  includeFileContent: false,
  includeToolContent: false,
};
const CLEAR_CONTENT_INSPECTOR = () =>
  ({
    schemaVersion: 1,
    detector: 'runtime_secret_detector',
    verdict: 'clear',
  }) as const;

function ollamaConfig(extra = ''): string {
  return `{
    "provider": {
      "ollama": {
        "models": [{ "name": "fixture", "default": true }]
      }
    },
    "features": { "sessionLoggingPolicyV1": true }
    ${extra}
  }`;
}

describe('session logger composition', () => {
  test('passes the complete resolved retention and capacity policy into the writer', async () => {
    let receivedPolicy: SessionLoggingPolicyV1 | undefined;
    const collector = new SessionLogCollector(
      'policy-forwarding',
      '/workspace',
      'fixture',
      { provider: 'fixture', name: 'fixture' },
      {
        policy: CONTENT_ARTIFACT_POLICY,
        contentInspector: CLEAR_CONTENT_INSPECTOR,
        writerFactory: (_frontend, _threadId, _basename, _onDiagnostic, policy) => {
          receivedPolicy = policy;
          return { write() {}, async finalize() {} };
        },
      },
    );
    await collector.finalize('completed');
    expect(receivedPolicy).toEqual(CONTENT_ARTIFACT_POLICY);
  });

  test('requires both artifact permission and explicit user opt-in for content mode', () => {
    expect(resolveSessionLoggingPolicyV1({ enabled: false }).mode).toBe('off');
    expect(resolveSessionLoggingPolicyV1({ enabled: true }).mode).toBe('metadata');
    expect(
      resolveSessionLoggingPolicyV1({
        enabled: true,
        artifactPolicy: CONTENT_ARTIFACT_POLICY,
      }).mode,
    ).toBe('metadata');
    expect(
      resolveSessionLoggingPolicyV1({
        enabled: true,
        artifactPolicy: CONTENT_ARTIFACT_POLICY,
        user: { mode: 'content' },
      }).mode,
    ).toBe('content');
    expect(() =>
      resolveSessionLoggingPolicyV1({
        enabled: true,
        artifactPolicy: CONTENT_ARTIFACT_POLICY,
        user: { mode: 'content' },
        project: { mode: 'content' },
      }),
    ).toThrow('Project config cannot enable content session logging');
  });

  test('loads user content opt-in only under a content-capable artifact', () => {
    const root = mkdtempSync(join(process.cwd(), '.openpx-logging-config-'));
    try {
      const configPath = join(root, 'kite-code.jsonc');
      writeFileSync(configPath, ollamaConfig(',\n"sessionLogging": { "mode": "content" }'));
      expect(() => loadAgentConfig({ configPath })).toThrow(
        'Session logging mode cannot be widened',
      );
      expect(
        loadAgentConfig({
          configPath,
          artifactSessionLoggingPolicy: CONTENT_ARTIFACT_POLICY,
        }).sessionLoggingPolicy?.mode,
      ).toBe('content');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects project content opt-in even when the user and artifact permit content', () => {
    const root = mkdtempSync(join(process.cwd(), '.openpx-logging-project-'));
    const userHome = join(root, 'home');
    const workspace = join(root, 'workspace');
    const userConfigDir = join(userHome, '.kite-code');
    const projectConfigDir = join(workspace, '.kite-code');
    mkdirSync(userConfigDir, { recursive: true });
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      join(userConfigDir, 'kite-code.jsonc'),
      ollamaConfig(',\n"sessionLogging": { "mode": "content" }'),
    );
    writeFileSync(
      join(projectConfigDir, 'kite-code.jsonc'),
      `{
        "sessionLogging": { "mode": "content" }
      }`,
    );
    const previousHome = process.env.KITE_CODE_HOME;
    const previousCwd = process.cwd();
    try {
      process.env.KITE_CODE_HOME = userHome;
      process.chdir(workspace);
      expect(() =>
        loadAgentConfig({ artifactSessionLoggingPolicy: CONTENT_ARTIFACT_POLICY }),
      ).toThrow('Project config cannot enable content session logging');
    } finally {
      process.chdir(previousCwd);
      if (previousHome == null) delete process.env.KITE_CODE_HOME;
      else process.env.KITE_CODE_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('TUI run composition preserves each resolved mode', () => {
    const modes = ['off', 'metadata', 'content'] as const;
    for (const mode of modes) {
      const config: AgentConfig = {
        apiKey: '',
        baseURL: 'http://localhost:11434',
        modelName: 'fixture',
        providerName: 'ollama',
        providerType: 'ollama',
        sandbox: { enabled: false },
        sessionLoggingPolicy: { ...CONTENT_ARTIFACT_POLICY, mode },
      };
      const input = buildRunAgentParams({
        task: 'fixture',
        threadId: `mode-${mode}`,
        workspace: '/workspace',
        config,
        shellExecutor: async () => ({
          ok: true,
          command: '',
          exitCode: 0,
          stdout: '',
          stderr: '',
        }),
        signal: new AbortController().signal,
        thinkingLevel: null,
        skills: [],
        skillOptions: null,
        mcpManager: null,
        shellContext: '',
      });
      expect(input.sessionLoggingPolicy?.mode).toBe(mode);
      expect(input.frontend).toBe('tui');
      expect(
        input.sessionLoggingContentInspector?.({
          text: 'ordinary visible text',
          provenance: 'user_message',
        }).verdict,
      ).toBe('clear');
    }
  });

  test('TUI composition detector rejects an arbitrary configured secret marker', () => {
    const secret = 'ULTRA_PRIVATE_SECRET_MARKER_7391';
    const config: AgentConfig = {
      apiKey: secret,
      baseURL: 'http://localhost:11434',
      modelName: 'fixture',
      providerName: 'ollama',
      providerType: 'ollama',
      sandbox: { enabled: false },
      sessionLoggingPolicy: CONTENT_ARTIFACT_POLICY,
    };
    const input = buildRunAgentParams({
      task: 'fixture',
      threadId: 'detector',
      workspace: '/workspace',
      config,
      shellExecutor: async () => ({
        ok: true,
        command: '',
        exitCode: 0,
        stdout: '',
        stderr: '',
      }),
      signal: new AbortController().signal,
      thinkingLevel: null,
      skills: [],
      skillOptions: null,
      mcpManager: null,
      shellContext: '',
    });

    expect(
      input.sessionLoggingContentInspector?.({
        text: `model repeated ${secret}`,
        provenance: 'model_visible_answer',
      }).verdict,
    ).toBe('secret');
  });

  test('content mode keeps user/model text but excludes reasoning, tool content, and credentials', () => {
    const records: unknown[] = [];
    const collector = new SessionLogCollector(
      'content',
      '/private/workspace',
      'fixture',
      { provider: 'fixture', name: 'fixture' },
      {
        mode: 'content',
        contentInspector: CLEAR_CONTENT_INSPECTOR,
        writerFactory: () => ({
          write: (record) => records.push(record),
          finalize: async () => {},
        }),
      },
    );
    collector.recordRuntime({
      type: 'model.responded',
      messageId: 'model-1',
      text: 'Safe answer with password="super-secret-value".',
      reasoningText: 'PRIVATE_REASONING_MARKER',
      toolCalls: [],
    });
    collector.recordRuntime({
      type: 'tool.queued',
      toolCallId: 'tool-1',
      name: 'shell_execute',
      args: { command: 'PRIVATE_TOOL_COMMAND' },
    });
    collector.recordRuntime({
      type: 'tool.finished',
      toolCallId: 'tool-1',
      name: 'shell_execute',
      result: {
        ok: false,
        command: 'PRIVATE_TOOL_COMMAND',
        exitCode: 1,
        stdout: 'PRIVATE_TOOL_STDOUT',
        stderr: 'PRIVATE_TOOL_STDERR',
      },
    });

    const output = JSON.stringify(records);
    expect(output).toContain('Safe answer');
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('super-secret-value');
    expect(output).not.toContain('PRIVATE_REASONING_MARKER');
    expect(output).not.toContain('PRIVATE_TOOL_COMMAND');
    expect(output).not.toContain('PRIVATE_TOOL_STDOUT');
    expect(output).not.toContain('PRIVATE_TOOL_STDERR');
  });

  test('content collector is a hostile-input allowlist with content-free boundaries', async () => {
    const forbidden = {
      workspace: '/private/workspace/HOSTILE_WORKSPACE_MARKER',
      model: 'HOSTILE_MODEL_MARKER',
      question: 'HOSTILE_QUESTION_MARKER',
      option: 'HOSTILE_OPTION_MARKER',
      context: 'HOSTILE_CONTEXT_MARKER',
      approvalReason: 'HOSTILE_APPROVAL_REASON_MARKER',
      toolFailure: 'HOSTILE_TOOL_FAILURE_MARKER',
      plan: 'HOSTILE_PLAN_MARKER',
      source: 'HOSTILE_SOURCE_MARKER',
      secret: 'ULTRA_PRIVATE_SECRET_MARKER_7391',
    };
    const records: unknown[] = [];
    const collector = new SessionLogCollector(
      'HOSTILE_THREAD_MARKER',
      forbidden.workspace,
      'fixture',
      { provider: 'fixture', name: forbidden.model },
      {
        mode: 'content',
        contentInspector: ({ text }) =>
          text.includes(forbidden.secret)
            ? {
                schemaVersion: 1,
                detector: 'runtime_secret_detector',
                verdict: 'secret',
              }
            : CLEAR_CONTENT_INSPECTOR(),
        writerFactory: () => ({
          write: (record) => records.push(record),
          finalize: async () => {},
        }),
      },
    );

    const rejectedEvents: RuntimeEvent[] = [
      {
        type: 'user_input.requested',
        interactionId: 'input',
        toolCallId: 'ask',
        request: {
          question: forbidden.question,
          options: [{ id: 'a', label: forbidden.option }],
          allow_free_text: true,
          context: forbidden.context,
        },
      },
      {
        type: 'approval.rejected',
        interactionId: 'approval',
        toolCallId: 'shell',
        reason: forbidden.approvalReason,
      },
      {
        type: 'tool.failed',
        toolCallId: 'shell',
        failure: classifyFailure('tool_runtime_error', forbidden.toolFailure),
      },
      {
        type: 'plan.review_requested',
        interactionId: 'plan',
        toolCallId: 'plan-tool',
        ...CURRENT_TEST_PLAN_REVIEW_FACTS,
        plan: {
          name: forbidden.plan,
          description: forbidden.source,
          status: 'pending',
          steps: [],
        },
        planSummary: forbidden.plan,
      },
      {
        type: 'tool.file_change',
        toolCallId: 'edit',
        path: forbidden.workspace,
        kind: 'edit',
        preview: forbidden.source,
      },
    ];
    for (const event of rejectedEvents) collector.recordRuntime(event);
    collector.recordRuntime({
      type: 'user.message_appended',
      messageId: 'user-secret-id',
      content: 'Allowed user text with token=HOSTILE_SECRET_VALUE.',
    });
    collector.recordRuntime({
      type: 'user.message_appended',
      messageId: 'unformatted-secret-id',
      content: `This whole record must be rejected: ${forbidden.secret}`,
    });
    collector.recordRuntime({
      type: 'model.responded',
      messageId: 'model-secret-id',
      text: 'Allowed model answer.',
      reasoningText: 'HOSTILE_REASONING_MARKER',
      toolCalls: [{ id: 'call', name: 'shell_execute', args: { source: forbidden.source } }],
    });
    await collector.finalize('completed');

    const output = JSON.stringify(records);
    expect(output).toContain('Allowed user text');
    expect(output).toContain('Allowed model answer');
    expect(output).toContain('[REDACTED]');
    for (const marker of [
      'HOSTILE_THREAD_MARKER',
      ...Object.values(forbidden),
      'HOSTILE_SECRET_VALUE',
      'HOSTILE_REASONING_MARKER',
      'user-secret-id',
      'model-secret-id',
    ]) {
      expect(output).not.toContain(marker);
    }
  });

  test('writer failure stops later writes but retains one contained finalization attempt', async () => {
    const records: unknown[] = [];
    const diagnostics: string[] = [];
    let finalizeCalls = 0;
    const collector = new SessionLogCollector(
      'write-failure',
      '/workspace',
      'fixture',
      { provider: 'fixture', name: 'fixture' },
      {
        mode: 'content',
        contentInspector: CLEAR_CONTENT_INSPECTOR,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
        writerFactory: () => ({
          write: (record) => {
            records.push(record);
            if (JSON.stringify(record).includes('TRIP_WRITER')) {
              throw new Error('write failed');
            }
          },
          finalize: async () => {
            finalizeCalls++;
            throw new Error('finalize failed');
          },
        }),
      },
    );

    collector.recordRuntime({
      type: 'user.message_appended',
      messageId: 'first',
      content: 'TRIP_WRITER',
    });
    collector.recordRuntime({
      type: 'model.responded',
      messageId: 'ignored',
      text: 'MUST_NOT_BE_WRITTEN',
    });
    await expect(collector.finalize('completed')).resolves.toBeUndefined();

    expect(records).toHaveLength(2);
    expect(JSON.stringify(records)).not.toContain('MUST_NOT_BE_WRITTEN');
    expect(finalizeCalls).toBe(1);
    expect(diagnostics).toEqual([
      'Session logging is unavailable; the Agent will continue without a logging fallback.',
    ]);
  });

  test('finalize rejection is contained and reported once', async () => {
    const diagnostics: string[] = [];
    const collector = new SessionLogCollector(
      'finalize-failure',
      '/workspace',
      'fixture',
      { provider: 'fixture', name: 'fixture' },
      {
        mode: 'metadata',
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
        writerFactory: () => ({
          write: () => {},
          finalize: async () => {
            throw new Error('finalize failed');
          },
        }),
      },
    );

    await expect(collector.finalize('completed')).resolves.toBeUndefined();
    expect(diagnostics).toEqual([
      'Session logging is unavailable; the Agent will continue without a logging fallback.',
    ]);
  });

  test('content mode fails closed when no trusted secret inspector is available', async () => {
    const records: unknown[] = [];
    const collector = new SessionLogCollector(
      'no-inspector',
      '/workspace',
      'fixture',
      { provider: 'fixture', name: 'fixture' },
      {
        mode: 'content',
        writerFactory: () => ({
          write: (record) => records.push(record),
          finalize: async () => {},
        }),
      },
    );
    collector.recordRuntime({
      type: 'user.message_appended',
      messageId: 'user',
      content: 'UNCLASSIFIED_CONTENT_MUST_NOT_BE_WRITTEN',
    });
    await collector.finalize('completed');

    expect(JSON.stringify(records)).not.toContain('UNCLASSIFIED_CONTENT_MUST_NOT_BE_WRITTEN');
    expect(records).toHaveLength(2);
  });

  test('Runtime content composition persists clear text and rejects a known arbitrary secret', async () => {
    const root = mkdtempSync(join(process.cwd(), '.openpx-content-runtime-'));
    const previousHome = process.env.KITE_CODE_HOME;
    const secret = 'ULTRA_PRIVATE_SECRET_MARKER_7391';
    process.env.KITE_CODE_HOME = root;
    try {
      const events: RuntimeEvent[] = [];
      for await (const event of runTestRuntimeAgentV1(
        {
          task: 'CLEAR_USER_MESSAGE_MARKER',
          userId: 'u',
          threadId: 'content-runtime',
          workspace: root,
          openState26SessionStorage: () => openState26Store5ForTestV1(join(root, 'runtime.db')),
          config: {
            apiKey: secret,
            baseURL: 'https://example.invalid',
            modelName: 'fixture',
            providerName: 'fixture',
            providerType: 'openai-compatible',
            sandbox: { enabled: false },
          },
          model: createMockModel([{ message: aiMessage({ content: `model repeated ${secret}` }) }]),
          sandboxBackend: 'unknown',
          frontend: 'content-runtime',
          sessionLoggingPolicy: CONTENT_ARTIFACT_POLICY,
        },
        {
          requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }),
        },
      )) {
        events.push(event);
      }

      const output = readFileSync(
        join(sessionLogDir('content-runtime', 'content-runtime'), 'events.jsonl'),
        'utf8',
      );
      expect(output).toContain('CLEAR_USER_MESSAGE_MARKER');
      expect(output).not.toContain(secret);
      expect(events.some((event) => event.type === 'run.completed')).toBe(true);
    } finally {
      if (previousHome == null) delete process.env.KITE_CODE_HOME;
      else process.env.KITE_CODE_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runtime secret detector returns unknown for text beyond its inspection bound', () => {
    const inspector = createModelSecretDetectorV1({
      knownSecrets: [],
      environment: {},
      maxInspectionChars: 4,
    });
    expect(inspector({ text: '12345', provenance: 'user_message' }).verdict).toBe('unknown');
  });

  test('writer construction failure reports once and does not stop the Runtime', async () => {
    const root = mkdtempSync(join(process.cwd(), '.openpx-logging-failure-'));
    const blockedHome = join(root, 'home');
    mkdirSync(blockedHome, { recursive: true });
    writeFileSync(join(blockedHome, '.kite-code'), 'not a directory');
    const previousHome = process.env.KITE_CODE_HOME;
    process.env.KITE_CODE_HOME = blockedHome;
    const diagnostics: string[] = [];
    const events: RuntimeEvent[] = [];
    try {
      for await (const event of runTestRuntimeAgentV1(
        {
          task: 'Complete despite logging failure.',
          userId: 'u',
          threadId: 'logging-failure',
          workspace: root,
          openState26SessionStorage: () => openState26Store5ForTestV1(join(root, 'runtime.db')),
          config: {
            apiKey: 'unused',
            baseURL: 'https://example.invalid',
            modelName: 'fixture',
            providerName: 'fixture',
            providerType: 'openai-compatible',
            sandbox: { enabled: false },
          },
          model: createMockModel([{ message: aiMessage({ content: 'Completed.' }) }]),
          sandboxBackend: 'unknown',
          sessionLoggingPolicy: {
            ...CONTENT_ARTIFACT_POLICY,
            mode: 'metadata',
          },
          onSessionLoggingDiagnostic: (message) => diagnostics.push(message),
        },
        {
          requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }),
        },
      )) {
        events.push(event);
      }
      expect(diagnostics).toEqual([
        'Session logging is unavailable; the Agent will continue without a logging fallback.',
      ]);
      expect(events.some((event) => event.type === 'run.completed')).toBe(true);
      expect(events.some((event) => event.type === 'run.error')).toBe(false);
    } finally {
      if (previousHome == null) delete process.env.KITE_CODE_HOME;
      else process.env.KITE_CODE_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
