import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKnowledgeReadScope } from '../../src/platform/knowledge-reads';
import {
  compileSkillWorkflow,
  compileSkillWorkflowAsync,
  createWorkflowCompilerSession,
  readWorkflowReferenceAsync,
  revalidateSkillWorkflowAsync,
  validateWorkflowArguments,
  validateWorkflowArgumentsAsync,
  type WorkflowCapability,
} from '../../src/skills/workflow-contract';

const capability: WorkflowCapability = {
  capabilityId: 'builtin:read',
  revision: 'one',
  availability: 'available',
  effectiveEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
  policy: { minimumApproval: 'none' },
};
const manifest = {
  name: 'async-check',
  version: '1.0.0',
  description: 'Exact compiler comparison',
  invocation: { allow_implicit: false, allow_manual: true },
  context: { mode: 'inline', agent: 'code' },
  input_schema: { type: 'object' },
  output_schema: { type: 'object' },
  capabilities: { require: ['builtin:read'], deny: [] },
  effects: { filesystem: 'read', network: 'none', external_state: 'none' },
  approval: { minimum: 'none' },
  execution: { timeout_ms: 300000, max_attempts: 1 },
  verification: { mode: 'not_required' },
  recovery: { retry: 'never' },
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kite-async-workflow-'));
  await mkdir(join(root, 'assets'));
  await writeFile(
    join(root, 'SKILL.md'),
    `---\n${JSON.stringify(manifest)}\n---\nOriginal instructions🙂`,
  );
  await writeFile(join(root, 'assets', 'original.bin'), new Uint8Array([0, 255, 1, 2]));
  return {
    root,
    input: {
      skillDir: root,
      source: 'project' as const,
      origin: '.agents' as const,
      resolveCapability: () => capability,
    },
  };
}
test('async full original Skill compilation preserves sync schema, byte revision and reference while yielding to Service work', async () => {
  const f = await fixture();
  const scope = createKnowledgeReadScope();
  try {
    for (let n = 0; n < 96; n++)
      await writeFile(join(f.root, 'assets', `${n}.bin`), Buffer.alloc(65536, n));
    const original = compileSkillWorkflow(f.input);
    let responsive = false;
    const ready = new Promise<void>((resolve) =>
      setImmediate(() => {
        responsive = true;
        resolve();
      }),
    );
    const actual = await compileSkillWorkflowAsync(f.input, scope);
    expect(responsive).toBe(true);
    await ready;
    expect(actual).toEqual(original);
    expect(Object.isFrozen(actual)).toBe(true);
    expect(actual.descriptor.availability).toBe('available');
    expect(await revalidateSkillWorkflowAsync(actual, f.input.resolveCapability, scope)).toEqual(
      original,
    );
    expect(
      await readWorkflowReferenceAsync(
        actual,
        'assets/original.bin',
        f.input.resolveCapability,
        scope,
      ),
    ).toMatchObject({ path: 'assets/original.bin', encoding: 'base64', content: 'AP8BAg==' });
    await writeFile(join(f.root, 'assets', 'original.bin'), 'different complete bytes');
    expect(
      (await revalidateSkillWorkflowAsync(actual, f.input.resolveCapability, scope)).descriptor
        .availability,
    ).toBe('unavailable');
  } finally {
    await scope.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});
test('dependency change between original compilation and confirmation is rejected without returning stale availability', async () => {
  const f = await fixture();
  const scope = createKnowledgeReadScope();
  let calls = 0;
  try {
    await expect(
      compileSkillWorkflowAsync(
        { ...f.input, resolveCapability: () => ({ ...capability, revision: String(++calls) }) },
        scope,
      ),
    ).rejects.toThrow('workflow_source_changed');
    expect(calls).toBeGreaterThan(1);
  } finally {
    await scope.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});
test('cancellation during capability resolution waits owned Worker exit and preserves original knowledge close ownership', async () => {
  const f = await fixture();
  const scope = createKnowledgeReadScope();
  const abort = new AbortController();
  try {
    await expect(
      compileSkillWorkflowAsync(
        {
          ...f.input,
          resolveCapability: () => {
            abort.abort(Error('original_workflow_cancel'));
            return capability;
          },
        },
        scope,
        { signal: abort.signal },
      ),
    ).rejects.toThrow('original_workflow_cancel');
    await scope.dispose();
    await expect(compileSkillWorkflowAsync(f.input, scope)).rejects.toMatchObject({
      code: 'knowledge_scope_closed',
    });
  } finally {
    await scope.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('explicit compiler session rereads source and current dependencies, then rejects after confirmed disposal', async () => {
  const f = await fixture(),
    scope = createKnowledgeReadScope(),
    compiler = createWorkflowCompilerSession();
  try {
    const first = await compileSkillWorkflowAsync(f.input, scope, { compiler });
    await writeFile(join(f.root, 'assets', 'original.bin'), 'new original bytes');
    const next = await compileSkillWorkflowAsync(f.input, scope, { compiler });
    expect(next.descriptor.revision).not.toBe(first.descriptor.revision);
    expect(next).toEqual(compileSkillWorkflow(f.input));
    expect(
      (await revalidateSkillWorkflowAsync(first, f.input.resolveCapability, scope, { compiler }))
        .descriptor.availability,
    ).toBe('unavailable');
    await compiler.dispose();
    await expect(compileSkillWorkflowAsync(f.input, scope, { compiler })).rejects.toMatchObject({
      code: 'workflow_compiler_closed',
    });
  } finally {
    await compiler.dispose();
    await scope.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('cancelled compiler session confirms its original Worker exit and reconstructs a fresh compiler on the next operation', async () => {
  const f = await fixture(),
    scope = createKnowledgeReadScope(),
    compiler = createWorkflowCompilerSession(),
    abort = new AbortController();
  try {
    await expect(
      compileSkillWorkflowAsync(
        {
          ...f.input,
          resolveCapability: () => {
            abort.abort(Error('cancel_original_session_compile'));
            return capability;
          },
        },
        scope,
        { compiler, signal: abort.signal },
      ),
    ).rejects.toThrow('cancel_original_session_compile');
    expect(await compileSkillWorkflowAsync(f.input, scope, { compiler })).toEqual(
      compileSkillWorkflow(f.input),
    );
  } finally {
    await compiler.dispose();
    await scope.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('binding disposal waits the original admitted knowledge read before confirming Worker exit', async () => {
  const f = await fixture(),
    original = createKnowledgeReadScope(),
    compiler = createWorkflowCompilerSession();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const scope = {
    ...original,
    run: <T>(operation: Parameters<typeof original.run<T>>[0]) =>
      original.run((access) =>
        operation({
          ...access,
          read: (path, flags, read) =>
            access.read(path, flags, async (handle) => {
              enter();
              await gate;
              return read(handle);
            }),
        }),
      ),
  };
  let disposed = false;
  const work = compileSkillWorkflowAsync(f.input, scope, { compiler });
  try {
    await entered;
    const disposal = compiler.dispose().then(() => {
      disposed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(disposed).toBe(false);
    await expect(compileSkillWorkflowAsync(f.input, original, { compiler })).rejects.toMatchObject({
      code: 'workflow_compiler_closed',
    });
    release();
    expect((await work).descriptor.availability).toBe('available');
    await disposal;
    expect(disposed).toBe(true);
  } finally {
    release();
    await work.catch(() => {});
    await compiler.dispose();
    await original.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('unconfirmed compiler Worker cleanup seals the session and cannot become a successful retry', async () => {
  const compiler = createWorkflowCompilerSession();
  let confirmOriginal!: () => Promise<void>;
  await compiler.run(async (owned) => {
    confirmOriginal = owned.terminate.bind(owned);
    owned.terminate = async () => {
      throw Error('injected_original_worker_exit_unconfirmed');
    };
  });
  try {
    await expect(compiler.dispose()).rejects.toMatchObject({
      code: 'knowledge_cleanup_unconfirmed',
    });
    await expect(compiler.run(async () => 'must not run')).rejects.toMatchObject({
      code: 'knowledge_cleanup_unconfirmed',
    });
  } finally {
    await confirmOriginal();
  }
});

test('binding Worker preserves exact schema validation diagnostics and independent schema registries', async () => {
  const compiler = createWorkflowCompilerSession();
  const schema = {
    type: 'object',
    properties: { value: { type: 'integer', minimum: 2 } },
    required: ['value'],
    additionalProperties: false,
  };
  try {
    for (const input of [{ value: 2 }, { value: 1 }, { value: '2' }, { value: 2, extra: true }, {}])
      expect(await validateWorkflowArgumentsAsync(schema, input, { compiler })).toBe(
        validateWorkflowArguments(schema, input),
      );
    const invalid = { type: 'object', properties: { value: { $ref: 'unknown-schema' } } };
    expect(await validateWorkflowArgumentsAsync(invalid, {}, { compiler })).toBe(
      validateWorkflowArguments(invalid, {}),
    );
    expect(await validateWorkflowArgumentsAsync(schema, { value: 3 }, { compiler })).toBeNull();
  } finally {
    await compiler.dispose();
  }
});

test('Worker dependency discovery matches the sole compiler across valid and malformed original manifests', async () => {
  const f = await fixture();
  const compiler = createWorkflowCompilerSession();
  const schema = {
    ...manifest,
    capabilities: {
      require: ['z', 'skill.workflow.verify', 'z', 'skill.workflow.compensate', 'denied'],
      deny: ['denied'],
    },
  };
  const bodies = [
    JSON.stringify(schema),
    JSON.stringify({ ...schema, input_schema: { type: 'array' } }),
    JSON.stringify({ ...schema, capabilities: { require: ['z'], deny: [1] } }),
    JSON.stringify({ ...schema, capabilities: { require: [''], deny: [] } }),
    JSON.stringify({ ...schema, capabilities: { require: ['z'], deny: ['z'] } }),
    'capabilities:\n  require: [z]\n  deny: []\ncapabilities: {}',
    '[not, an, object]',
    '{broken',
  ];
  try {
    for (const body of bodies) {
      await writeFile(join(f.root, 'SKILL.md'), `---\r\n${body}\r\n---\r\nOriginal`);
      const syncIds: string[] = [],
        asyncIds: string[] = [];
      const original = compileSkillWorkflow({
        ...f.input,
        resolveCapability(id) {
          syncIds.push(id);
          return { ...capability, capabilityId: id };
        },
      });
      const actual = await compileSkillWorkflowAsync(
        {
          ...f.input,
          resolveCapability(id) {
            asyncIds.push(id);
            return { ...capability, capabilityId: id };
          },
        },
        undefined,
        { compiler },
      );
      expect(actual).toEqual(original);
      expect(asyncIds).toEqual([...syncIds, ...syncIds, ...syncIds, ...syncIds]);
    }
  } finally {
    await compiler.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});
