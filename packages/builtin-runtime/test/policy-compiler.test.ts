import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  BUILTIN_DYNAMIC_MCP_OPERATION_ID_,
  type BuiltinModelToolCatalogEntry,
  compileBuiltinDynamicMcpPolicy,
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjection,
  isReadOnlyShellCommand,
} from '@kite-ai/builtin-runtime';
import {
  type CapabilityPolicyCompilation,
  type CapabilityPolicyContext,
  createRuntimeModuleRegistry,
} from '@kite-ai/runtime-spi';

const CONTEXT: CapabilityPolicyContext = Object.freeze({
  workspace: '/tmp/kite-policy-workspace',
  phase: 'building',
  threadId: 'thread-policy',
  turnId: 'turn-policy',
  toolSearchEnabled: true,
  hasTaskAdapter: true,
  hasGitBroker: true,
  brokeredGitFeatureRevision: 'brokered-git-r1',
  activeSkillFrameIds: Object.freeze(['skill-frame']),
  availableSkillIds: Object.freeze(['skill']),
  featureFlags: Object.freeze({
    brokeredGit: true,
    skillWorkflow: true,
    skillActivation: true,
  }),
});

const WEATHER_COMMAND = "curl -s --max-time 20 'https://wttr.in/?format=3&lang=zh'";

function projection() {
  return createBuiltinToolCatalogProjection(
    createRuntimeModuleRegistry(createBuiltinRuntimeModules()),
    { turnContext: CONTEXT },
  );
}

function modelEntry(name: string): BuiltinModelToolCatalogEntry {
  const entry = projection().entries.find(
    (candidate): candidate is BuiltinModelToolCatalogEntry =>
      candidate.visibility === 'model' && candidate.name === name,
  );
  if (!entry) throw new Error(`missing model entry: ${name}`);
  return entry;
}

function compile(
  name: string,
  input: Parameters<BuiltinModelToolCatalogEntry['compilePolicy']>[0],
  context: CapabilityPolicyContext = CONTEXT,
): CapabilityPolicyCompilation {
  return modelEntry(name).compilePolicy(input, context);
}

function dynamicMcpPolicyInput(
  overrides: Partial<Parameters<typeof compileBuiltinDynamicMcpPolicy>[0]> = {},
): Parameters<typeof compileBuiltinDynamicMcpPolicy>[0] {
  return {
    operationId: BUILTIN_DYNAMIC_MCP_OPERATION_ID_,
    capabilityRevision: 'a'.repeat(64),
    parserRevision: 'b'.repeat(64),
    exposedToolName: 'mcp__fixture__search',
    effectiveEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
    minimumApproval: 'none',
    phase: 'building',
    workspace: '/tmp/kite-policy-workspace',
    ...overrides,
  };
}

describe('Builtin dynamic MCP policy compiler', () => {
  test('allows only a locally classified read-only capability without approval', () => {
    const compiled = compileBuiltinDynamicMcpPolicy(dynamicMcpPolicyInput());
    expect(compiled).toMatchObject({
      schema: 'kite.capability-policy-compilation.v1',
      operationId: 'mcp:dynamic_tool',
      capabilityRevision: 'a'.repeat(64),
      parserRevision: 'b'.repeat(64),
      decision: 'allow',
      allowed: true,
      requiresApproval: false,
      risk: 'read',
      minimumApproval: 'none',
    });
    expect(compiled.effects).toBeUndefined();
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.effectiveEffects)).toBe(true);
  });

  test('requires user approval for non-read-only MCP effects while building', () => {
    const compiled = compileBuiltinDynamicMcpPolicy(
      dynamicMcpPolicyInput({
        effectiveEffects: { filesystem: 'none', network: 'write', externalState: 'write' },
        minimumApproval: 'user',
      }),
    );
    expect(compiled).toMatchObject({
      decision: 'ask',
      allowed: true,
      requiresApproval: true,
      risk: 'mcp',
      effects: { uncertainEffects: true },
      minimumApproval: 'user',
    });
  });

  test('denies non-read-only MCP effects during planning', () => {
    const compiled = compileBuiltinDynamicMcpPolicy(
      dynamicMcpPolicyInput({
        effectiveEffects: { filesystem: 'write', network: 'none', externalState: 'none' },
        phase: 'planning',
      }),
    );
    expect(compiled).toMatchObject({
      decision: 'deny',
      allowed: false,
      requiresApproval: false,
      risk: 'mcp',
      phaseConstraint: 'planning',
    });
  });

  test('rejects wrapper identity drift and contains no external execution authority', () => {
    expect(() =>
      compileBuiltinDynamicMcpPolicy(
        dynamicMcpPolicyInput({
          operationId: 'mcp:wrong' as typeof BUILTIN_DYNAMIC_MCP_OPERATION_ID_,
        }),
      ),
    ).toThrow('Dynamic MCP policy compiler identity is invalid.');
    const source = readFileSync(new URL('../src/policy-compiler.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('callCapability');
    expect(source).not.toContain('CapabilityExecutionPort');
  });
});

describe('Builtin operation policy compiler', () => {
  test('projects one compiler for each of 20 model operations and none for internals', () => {
    const result = projection();
    const model = result.entries.filter((entry) => entry.visibility === 'model');
    const internal = result.entries.filter((entry) => entry.visibility === 'internal');
    expect(result.entries).toHaveLength(28);
    expect(model).toHaveLength(20);
    expect(internal).toHaveLength(8);
    expect(model.every((entry) => typeof entry.compilePolicy === 'function')).toBe(true);
    expect(internal.every((entry) => !('compilePolicy' in entry))).toBe(true);
    expect(internal.find((entry) => entry.operationId === 'mcp:dynamic_tool')).toBeDefined();
  });

  test('binds frozen facts to operation, capability, and parser identity', () => {
    const entry = modelEntry('read_file');
    const facts = entry.compilePolicy({ path: 'src/index.ts' }, CONTEXT);
    expect(facts).toMatchObject({
      schema: 'kite.capability-policy-compilation.v1',
      operationId: 'builtin:read_file',
      capabilityRevision: entry.revision,
      parserRevision: entry.parser.parserRevision,
      decision: 'allow',
      allowed: true,
      requiresApproval: false,
      minimumApproval: 'none',
    });
    expect(Object.isFrozen(facts)).toBe(true);
    expect(Object.isFrozen(facts.expectedEffects)).toBe(true);
    expect(Object.isFrozen(facts.effectiveEffects)).toBe(true);
    expect(facts.fullAccessMayBypassApproval).toBe(false);
    expect(facts.sameCommandMayBypassApproval).toBe(false);
  });

  test('runs workspace Shell commands in the baseline and reviews only known scope expansion', () => {
    for (const command of [
      'cat package.json',
      'bun test',
      'custom-build-tool --deploy candidate',
      'touch local.txt',
      'mkdir build',
      'echo hi > local.txt',
      'rm -rf .',
      'rm -rf build',
      'rm -rf $TARGET',
    ]) {
      expect(compile('shell_execute', { command })).toMatchObject({
        decision: 'allow',
        allowed: true,
        requiresApproval: false,
        requiresSandbox: true,
        fullAccessMayBypassApproval: false,
        sameCommandMayBypassApproval: false,
        sandboxScope: {
          kind: 'baseline',
          filesystem: 'workspace_write',
          network: 'disabled',
        },
      });
    }
    for (const command of [
      'cat /tmp/external.txt',
      'echo hi > /tmp/external.txt',
      'cp /tmp/source.txt local.txt',
    ]) {
      expect(compile('shell_execute', { command })).toMatchObject({
        decision: 'ask',
        allowed: true,
        requiresApproval: true,
        requiresSandbox: true,
        fullAccessMayBypassApproval: true,
        sameCommandMayBypassApproval: true,
        sandboxScope: {
          kind: 'expanded',
          filesystem: 'full_access',
          network: 'disabled',
        },
      });
    }
    expect(compile('shell_execute', { command: 'sudo rm -rf /' })).toMatchObject({
      decision: 'deny',
      risk: 'destructive',
      fullAccessMayBypassApproval: false,
      sameCommandMayBypassApproval: false,
    });
    expect(compile('shell_execute', { command: 'rm -f ~/.ssh/id_ed25519' })).toMatchObject({
      decision: 'ask',
      risk: 'write_file',
      effects: { externalWrite: true, sensitiveExternalAccess: true },
      fullAccessMayBypassApproval: true,
      sameCommandMayBypassApproval: false,
    });
    expect(compile('shell_execute', { command: 'cat ~/.ssh/id_rsa' })).toMatchObject({
      decision: 'ask',
      effects: { externalRead: true, sensitiveExternalAccess: true },
      fullAccessMayBypassApproval: true,
      sameCommandMayBypassApproval: false,
    });
    expect(compile('shell_execute', { command: 'echo 127.0.0.1 x >> /etc/hosts' })).toMatchObject({
      decision: 'ask',
      risk: 'write_file',
      effects: { externalWrite: true, sensitiveExternalAccess: true },
      fullAccessMayBypassApproval: true,
      sameCommandMayBypassApproval: false,
    });
    expect(
      compile('shell_execute', { command: 'bun test' }, { ...CONTEXT, phase: 'planning' }),
    ).toMatchObject({
      decision: 'allow',
      requiresApproval: false,
      sandboxScope: { kind: 'baseline', filesystem: 'read_only', network: 'disabled' },
    });
  });

  test('proves only bounded workspace inventory loops read-only', () => {
    const inventory =
      'for d in packages/* apps/*; do echo "=== $d ==="; ls "$d"; done 2>/dev/null | head -120';
    expect(isReadOnlyShellCommand(inventory)).toBe(true);
    expect(compile('shell_execute', { command: inventory })).toMatchObject({
      decision: 'allow',
      requiresApproval: false,
      effectiveEffects: { filesystem: 'read' },
    });

    for (const command of [
      'for d in packages/*; do rm -rf "$d"; done',
      'for d in /tmp/*; do cat "$d"; done',
      'for d in ../*; do cat "$d"; done',
      'for d in $TARGETS; do cat "$d"; done',
      'for d in packages/*; do echo "$d" > inventory.txt; done',
      'for d in packages/*; do cat "$d"; done | tee inventory.txt',
      'for d in packages/*; do "$d"; done',
    ]) {
      expect(isReadOnlyShellCommand(command)).toBe(false);
    }
  });

  test('treats only exact current-branch inspection as read-only Git', () => {
    const inspection =
      'git status && echo "---BRANCH---" && git branch --show-current && echo "---LOG---" && git log --oneline -10';
    expect(isReadOnlyShellCommand(inspection)).toBe(true);
    expect(compile('shell_execute', { command: inspection })).toMatchObject({
      decision: 'allow',
      requiresApproval: false,
      effectiveEffects: { filesystem: 'read' },
    });
    for (const command of [
      'git branch -a',
      'git branch feature/new',
      'git branch -d old',
      'git branch --show-current feature/new',
      'git branch --show-current && git branch feature/new',
    ]) {
      expect(isReadOnlyShellCommand(command)).toBe(false);
    }
  });

  test('keeps Git inside the baseline without a subcommand allowlist and reviews known expansion', () => {
    for (const command of [
      'git status --short',
      'git log --oneline -10',
      '/usr/bin/git status --short',
      'git diff -- safe.txt',
      'git add safe.txt',
      'git commit -m update',
      'git -C . status --short',
      'git --git-dir=.git status --short',
      'sh -c "git diff -- safe.txt"',
      "python -c \"import subprocess; subprocess.run(['git','status'])\"",
      'env PATH=/usr/bin command git.exe status',
      'C:\\Tools\\Git\\bin\\git.exe status',
      'git workspace-alias',
    ]) {
      expect(compile('shell_execute', { command })).toMatchObject({
        decision: 'allow',
        allowed: true,
        requiresApproval: false,
        fullAccessMayBypassApproval: false,
        sandboxScope: { kind: 'baseline', filesystem: 'workspace_write' },
      });
      expect(compile('shell_execute', { command }).recovery).toBeUndefined();
    }
    for (const command of [
      'git push origin main',
      'git -C ../outside status --short',
      'git --git-dir=/tmp/repo/.git status',
      'git config --global user.name test',
      'git hash-object /tmp/external.txt',
      'git diff --no-index safe.txt /tmp/external.txt',
    ]) {
      expect(compile('shell_execute', { command })).toMatchObject({
        decision: 'ask',
        allowed: true,
        requiresApproval: true,
        fullAccessMayBypassApproval: true,
        sandboxScope: { kind: 'expanded' },
      });
      expect(compile('shell_execute', { command }).recovery).toBeUndefined();
    }
    expect(compile('shell_execute', { command: 'git -C /etc clean -fdx' })).toMatchObject({
      decision: 'deny',
      risk: 'destructive',
      fullAccessMayBypassApproval: false,
    });
    expect(
      compile(
        'shell_execute',
        { command: 'git commit -m update' },
        { ...CONTEXT, phase: 'planning' },
      ),
    ).toMatchObject({
      decision: 'ask',
      requiresApproval: true,
      sandboxScope: { kind: 'expanded', filesystem: 'workspace_write', network: 'disabled' },
    });
    const readOnlyPlanningInspection =
      'git status --short | head -40 && echo "=== diff stat vs origin ===" && git diff --stat HEAD | tail -20 && echo "=== unpushed commits ===" && git log --oneline origin/feat/kite-local-runtime-service-v1..HEAD 2>/dev/null | head -20';
    expect(
      compile(
        'shell_execute',
        { command: readOnlyPlanningInspection },
        { ...CONTEXT, phase: 'planning' },
      ),
    ).toMatchObject({
      decision: 'allow',
      requiresApproval: false,
      risk: 'unknown',
      sandboxScope: { kind: 'baseline', filesystem: 'read_only', network: 'disabled' },
    });
    expect(compile('shell_execute', { command: 'git push origin main' })).toMatchObject({
      decision: 'ask',
      sandboxScope: { kind: 'expanded', filesystem: 'workspace_write', network: 'allow_all' },
    });
  });

  test('classifies the approved weather command as a network-only scope expansion', () => {
    expect(compile('shell_execute', { command: WEATHER_COMMAND })).toMatchObject({
      decision: 'ask',
      allowed: true,
      requiresApproval: true,
      risk: 'network',
      effects: { network: true },
      sandboxScope: {
        kind: 'expanded',
        filesystem: 'workspace_write',
        network: 'allow_all',
      },
    });
  });

  test('uses known scope effects for review while uncertainty stays sandbox-confined', () => {
    const corpus = [
      {
        input: { command: 'rm -rf /etc/nginx' },
        expected: { decision: 'deny', risk: 'destructive' },
      },
      {
        input: { command: 'rm -rf /tmp/build' },
        expected: {
          decision: 'ask',
          risk: 'write_file',
          effects: { externalWrite: true },
        },
      },
      {
        input: { command: 'bun install' },
        expected: {
          decision: 'ask',
          risk: 'network',
          effects: { network: true, uncertainEffects: true },
        },
      },
      {
        input: { command: 'git push origin main' },
        expected: { decision: 'ask', risk: 'network', effects: { network: true } },
      },
      {
        input: { command: 'git commit -m update' },
        expected: {
          decision: 'allow',
          risk: 'vcs_mutation',
          sandboxScope: { kind: 'baseline', filesystem: 'workspace_write' },
        },
      },
      {
        input: { command: 'node script.js' },
        expected: {
          decision: 'allow',
          risk: 'unknown',
          effects: { uncertainEffects: true },
          sandboxScope: { kind: 'baseline', filesystem: 'workspace_write' },
        },
      },
      {
        input: { command: 'rg -f /tmp/kite-patterns src' },
        expected: { decision: 'ask', risk: 'read', effects: { externalRead: true } },
      },
      {
        input: { command: 'curl -o /tmp/out https://example.com' },
        expected: {
          decision: 'ask',
          risk: 'network',
          effects: { network: true, externalWrite: true },
        },
      },
      {
        input: { command: 'scp host:/file /tmp/out' },
        expected: {
          decision: 'ask',
          risk: 'network',
          effects: { network: true, uncertainEffects: true },
        },
      },
    ] as const;
    const legacyShellContext = {
      ...CONTEXT,
      featureFlags: { ...CONTEXT.featureFlags, brokeredGit: false },
    };
    for (const vector of corpus) {
      expect(compile('shell_execute', vector.input, legacyShellContext)).toMatchObject(
        vector.expected,
      );
    }
    for (const protectedPath of ['~/.ssh/id_ed25519', '~/.aws/credentials', '~/.env']) {
      expect(
        compile('shell_execute', { command: `cat ${protectedPath}` }, legacyShellContext),
      ).toMatchObject({
        decision: 'ask',
        requiresApproval: true,
        effects: { externalRead: true, sensitiveExternalAccess: true },
        fullAccessMayBypassApproval: true,
        sameCommandMayBypassApproval: false,
      });
    }
  });

  test('keeps web privacy, file externality, and planning-role facts', () => {
    expect(compile('web_fetch', { url: 'not a url' })).toMatchObject({
      decision: 'deny',
      risk: 'network',
    });
    expect(compile('web_fetch', { url: 'https://user:pass@example.com/docs' })).toMatchObject({
      decision: 'deny',
      reason: expect.stringContaining('userinfo'),
    });
    expect(
      compile('web_fetch', {
        url: 'https://example.com/?token=123456789012345678901234567890',
      }),
    ).toMatchObject({ decision: 'deny' });
    expect(compile('web_fetch', { url: 'https://example.com/docs' })).toMatchObject({
      decision: 'allow',
      effects: { network: true },
      risk: 'network',
    });
    expect(compile('read_file', { path: '/tmp/external.txt' })).toMatchObject({
      decision: 'allow',
      expectedEffects: ['Reads files outside the workspace boundary'],
    });
    expect(compile('read_file', { path: '/tmp/external.txt' }).effects).toEqual({
      externalRead: true,
    });
    expect(compile('read_file', { path: '~/.ssh/id_ed25519' })).toMatchObject({
      decision: 'ask',
      risk: 'read',
      effects: { externalRead: true, sensitiveExternalAccess: true },
      fullAccessMayBypassApproval: true,
      sameCommandMayBypassApproval: false,
    });
    expect(compile('read_file', { path: '/tmp/fixture/.env.local' })).toMatchObject({
      decision: 'ask',
      effects: { externalRead: true, sensitiveExternalAccess: true },
    });
    expect(compile('search_files', { path: '~', pattern: '*' })).toMatchObject({
      decision: 'ask',
      risk: 'read',
      effects: { externalRead: true, sensitiveExternalAccess: true },
    });
    expect(compile('search_content', { path: '/tmp', pattern: 'needle' })).toMatchObject({
      decision: 'ask',
      effects: { externalRead: true, sensitiveExternalAccess: true },
    });
    expect(compile('write_file', { path: '/tmp/external.txt', content: 'x' })).toMatchObject({
      decision: 'ask',
      risk: 'write_file',
      effects: { externalWrite: true },
      minimumApproval: 'none',
      fullAccessMayBypassApproval: true,
      sameCommandMayBypassApproval: false,
    });
    expect(compile('write_file', { path: '/tmp/fixture/.env.local', content: 'x' })).toMatchObject({
      decision: 'ask',
      risk: 'write_file',
      effects: { externalWrite: true, sensitiveExternalAccess: true },
      fullAccessMayBypassApproval: true,
      sameCommandMayBypassApproval: false,
    });
    expect(compile('write_file', { path: 'src/local.ts', content: 'x' })).toMatchObject({
      decision: 'allow',
      requiresApproval: false,
      risk: 'write_file',
      fullAccessMayBypassApproval: false,
      sameCommandMayBypassApproval: false,
    });
    expect(
      compile(
        'write_file',
        { path: 'src/index.ts', content: 'x' },
        { ...CONTEXT, phase: 'planning' },
      ),
    ).toMatchObject({ decision: 'deny', phaseConstraint: 'planning' });
    expect(
      compile(
        'task',
        {
          name: 'Implement feature',
          subagent_type: 'code',
          task: 'Implement the requested feature.',
        },
        {
          ...CONTEXT,
          phase: 'planning',
        },
      ),
    ).toMatchObject({ decision: 'deny', phaseConstraint: 'planning' });
    expect(
      compile(
        'task',
        {
          name: 'Inspect code paths',
          subagent_type: 'explore',
          task: 'Inspect the relevant code paths.',
        },
        {
          ...CONTEXT,
          phase: 'planning',
        },
      ),
    ).toMatchObject({ decision: 'allow', risk: 'plan' });
  });

  test('keeps interrupt, skill, and planning semantics out of authorization', () => {
    expect(
      compile('ask_user', {
        questions: [
          {
            question: 'Continue?',
            options: [
              { label: 'Yes', description: 'Continue.', recommended: true },
              { label: 'No', description: 'Stop.', recommended: false },
            ],
          },
        ],
      }),
    ).toMatchObject({ decision: 'allow', risk: 'plan', requiresApproval: false });
    expect(
      compile(
        'activate_skill',
        { skill_id: 'skill', input: {} },
        {
          ...CONTEXT,
          phase: 'planning',
        },
      ),
    ).toMatchObject({ decision: 'deny', phaseConstraint: 'planning' });
    expect(compile('activate_skill', { skill_id: 'skill', input: {} })).toMatchObject({
      decision: 'ask',
      minimumApproval: 'user',
      fullAccessMayBypassApproval: false,
      sameCommandMayBypassApproval: false,
    });
    expect(compile('read_plan', { plan_id: 'plan-1' })).toMatchObject({
      decision: 'allow',
      risk: 'read',
    });
    expect(
      compile('write_plan', {
        action: 'submit',
        plan_id: 'plan-1',
        version: 1,
        structural_digest: 'digest',
      }),
    ).toMatchObject({
      decision: 'allow',
      risk: 'plan',
    });
  });

  test('covers the fixed URL and Task phase corpus', () => {
    for (const url of [
      'not-a-url',
      'https://user:pass@example.com/docs',
      'https://example.com/?api_key=123456789012345678901234567890',
    ]) {
      expect(compile('web_fetch', { url })).toMatchObject({ decision: 'deny', allowed: false });
    }
    expect(compile('web_fetch', { url: 'https://example.com/docs' })).toMatchObject({
      decision: 'allow',
      allowed: true,
      requiresApproval: false,
    });
    for (const role of ['code', 'review'] as const) {
      expect(
        compile(
          'task',
          {
            name: 'Inspect or implement task',
            subagent_type: role,
            task: 'Inspect or implement the requested task.',
          },
          { ...CONTEXT, phase: 'planning' },
        ),
      ).toMatchObject({ decision: 'deny', phaseConstraint: 'planning' });
    }
    for (const role of ['explore', 'plan'] as const) {
      expect(
        compile(
          'task',
          {
            name: 'Inspect code paths',
            subagent_type: role,
            task: 'Inspect the relevant code paths.',
          },
          { ...CONTEXT, phase: 'planning' },
        ),
      ).toMatchObject({ decision: 'allow', risk: 'plan' });
    }
    expect(
      compile('task', {
        name: 'Implement feature',
        subagent_type: 'code',
        task: 'Implement the requested feature.',
      }),
    ).toMatchObject({ decision: 'allow', risk: 'plan' });
  });
});
