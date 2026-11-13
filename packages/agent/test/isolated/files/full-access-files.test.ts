import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '#kite-test';
import { spawnSync as spawnProcessSync } from '../../../../../scripts/tooling/process';
import type { AuthorizationRequest, ToolContext } from '../../../src/extensions';
import {
  createFileTools,
  createWorkspaceFiles,
  withExternalFileReads,
  withFullAccessFiles,
} from '../../../src/files';
import { canonicalJson } from '../../../src/json';
import type { CapabilityDescription, PermissionMode } from '../../../src/permissions';
import type { Json } from '../../../src/storage/types';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-full-files-'))),
    workspace = join(root, 'workspace'),
    external = join(root, 'external'),
    protectedRoot = join(root, 'private');
  for (const path of [workspace, external, protectedRoot]) mkdirSync(path);
  const files = createWorkspaceFiles({ root: workspace });
  let captures = 0;
  const original = createFileTools(files, {
    capture: {
      async before() {
        captures++;
        return null;
      },
      async after() {},
      async failed() {},
    },
  });
  const reads = withExternalFileReads({
    tools: original,
    workspaceRoot: async () => workspace,
    protectedRoots: () => [protectedRoot],
  });
  const api = withFullAccessFiles({
    tools: reads.tools,
    workspaceRoot: async () => workspace,
    protectedRoots: () => [protectedRoot],
  });
  let id = 0;
  const request = (toolId: string, input: Json): AuthorizationRequest => ({
    kind: 'tool',
    definitionId: toolId,
    definitionVersion: api.tools.find((t) => t.id === toolId)!.version,
    sessionId: 's',
    runId: 'r',
    executionId: `file-${++id}`,
    input,
    signal: new AbortController().signal,
  });
  const proof = (mode: PermissionMode, capability: CapabilityDescription | null) => ({
    namespace: 'builtin.permissions',
    version: '1',
    data: { mode, workspaceTrust: true, capability },
  });
  async function context(req: AuthorizationRequest, mode: PermissionMode = 'full') {
    const capability =
      (await api.describeRequest(req, { mode })) ?? (await reads.describeRequest(req));
    return {
      sessionId: req.sessionId,
      runId: req.runId,
      executionId: req.executionId,
      signal: req.signal,
      dispatchAuthorization: { revision: 'accepted-final', snapshot: proof(mode, capability) },
    } as unknown as ToolContext;
  }
  async function execute(
    toolId: string,
    input: Json,
    extra: Partial<ToolContext> = {},
    mode: PermissionMode = 'full',
  ) {
    const req = request(toolId, input),
      ctx = await context(req, mode);
    return api.tools.find((t) => t.id === toolId)!.execute(input, { ...ctx, ...extra });
  }
  return {
    root,
    workspace,
    external,
    protectedRoot,
    original,
    api,
    reads,
    request,
    context,
    proof,
    execute,
    captures: () => captures,
    async close() {
      await files.close();
      rmSync(root, { recursive: true });
    },
  };
}

test('Full direct external write, baseline read, replace and edit retain original tools without workspace capture', async () => {
  const f = fixture();
  try {
    expect(f.api.tools.map((t) => [t.id, t.version])).toEqual(
      f.original.map((t) => [t.id, t.version]),
    );
    const path = join(f.external, 'report.txt');
    const write = await f.execute('files.write', { path, base: null, content: 'before 😀\r\n' });
    expect(write.outcome).toBe('succeeded');
    expect(write.details).toMatchObject({
      fileScope: 'external_path',
      workspaceCheckpoint: false,
      fileChange: { path },
    });
    expect(JSON.parse(write.content)).toMatchObject({
      path,
      baseline: { size: Buffer.byteLength('before 😀\r\n') },
    });
    const read = await f.execute('files.read', { path });
    const body = JSON.parse(read.content);
    expect(body.content).toBe('before 😀\r\n');
    expect(body.baseline.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof body.baseline.device).toBe('string');
    expect(typeof body.baseline.inode).toBe('string');
    expect(read.details).toMatchObject({ workspaceCheckpoint: false });
    const edit = await f.execute('files.edit', {
      path,
      base: body.baseline,
      find: 'before',
      replace: 'after',
      occurrences: 1,
    });
    expect(edit.outcome, JSON.stringify({ edit, baseline: body.baseline })).toBe('succeeded');
    expect(readFileSync(path, 'utf8')).toBe('after 😀\r\n');
    const baseline = JSON.parse((await f.execute('files.read', { path })).content).baseline;
    expect(
      (await f.execute('files.write', { path, base: baseline, content: 'replaced' })).outcome,
    ).toBe('succeeded');
    expect(readFileSync(path, 'utf8')).toBe('replaced');
    expect(f.captures()).toBe(0);
  } finally {
    await f.close();
  }
});

test('Full creates missing parent directories through the original native create-only path', async () => {
  const f = fixture();
  try {
    const path = join(f.external, 'one', 'two', 'report.txt');
    expect((await f.execute('files.write', { path, base: null, content: 'created' })).outcome).toBe(
      'succeeded',
    );
    expect(readFileSync(path, 'utf8')).toBe('created');
    expect(
      (await f.execute('files.write', { path, base: null, content: 'must not replace' })).details,
    ).toMatchObject({ code: 'file_baseline_conflict' });
    expect(readFileSync(path, 'utf8')).toBe('created');
  } finally {
    await f.close();
  }
});

test('non-Full external mutation is explicit denied while ordinary external reads keep their old contract', async () => {
  const f = fixture();
  try {
    const path = join(f.external, 'outside.txt');
    writeFileSync(path, 'original');
    for (const mode of ['accept_edits', 'auto'] as const) {
      const req = f.request('files.write', { path, base: null, content: 'must not write' });
      expect(await f.api.describeRequest(req, { mode })).toMatchObject({
        hardAllowed: false,
        denialReason: 'file_full_access_required',
      });
      expect((await f.execute('files.write', req.input, {}, mode)).details).toMatchObject({
        code: 'file_full_access_required',
      });
      const read = JSON.parse((await f.execute('files.read', { path }, {}, mode)).content);
      expect(read.content).toBe('original');
      expect(read.baseline).toBeUndefined();
    }
    expect(readFileSync(path, 'utf8')).toBe('original');
  } finally {
    await f.close();
  }
});

test('every accepted parent/child policy must be Full and match the original capability revision', async () => {
  const f = fixture();
  try {
    const path = join(f.external, 'never.txt'),
      input = { path, base: null, content: 'never' };
    const req = f.request('files.write', input),
      cap = await f.api.describeRequest(req, { mode: 'full' });
    const good = f.proof('full', cap),
      restricted = f.proof('accept_edits', cap);
    const context = await f.context(req);
    const snapshots: Json[] = [
      {
        namespace: 'agent.permission-intersection',
        version: '1',
        data: {
          policies: [
            { scope: 'parent', revision: 'p', allowed: true, snapshot: restricted },
            { scope: 'child', revision: 'c', allowed: true, snapshot: good },
          ],
        },
      } as unknown as Json,
      f.proof('full', { ...cap!, revision: 'changed' }) as unknown as Json,
    ];
    for (const snapshot of snapshots) {
      const result = await f.api.tools
        .find((t) => t.id === 'files.write')!
        .execute(input, {
          ...context,
          dispatchAuthorization: { revision: 'accepted', snapshot },
        } as unknown as ToolContext);
      expect(result.outcome).toBe('failed');
    }
    expect(
      (await f.execute('files.write', input, { dispatchAuthorization: undefined })).outcome,
    ).toBe('failed');
    expect((await f.execute('files.read', { path: f.protectedRoot })).outcome).toBe('failed');
    expect(f.captures()).toBe(0);
  } finally {
    await f.close();
  }
});

test('protected roots and symlink mutation never fall back to an unprotected writer; old symlink reads remain readable', async () => {
  const f = fixture();
  try {
    const ordinary = join(f.external, 'ordinary.txt'),
      link = join(f.external, 'link.txt'),
      privatePath = join(f.protectedRoot, 'secret.txt'),
      privateLink = join(f.external, 'private-link');
    writeFileSync(ordinary, 'ordinary');
    writeFileSync(privatePath, 'private');
    symlinkSync(ordinary, link);
    symlinkSync(privatePath, privateLink);
    for (const path of [privatePath, privateLink]) {
      expect(
        await f.api.describeRequest(
          f.request('files.write', { path, base: null, content: 'never' }),
          { mode: 'full' },
        ),
      ).toMatchObject({ hardAllowed: false, denialReason: 'file_path_protected' });
      expect((await f.execute('files.read', { path })).outcome).toBe('failed');
    }
    expect(
      await f.api.describeRequest(
        f.request('files.write', { path: link, base: null, content: 'never' }),
        { mode: 'full' },
      ),
    ).toMatchObject({ hardAllowed: false, denialReason: 'file_symlink' });
    const read = JSON.parse((await f.execute('files.read', { path: link })).content);
    expect(read.content).toBe('ordinary');
    expect(read.baseline).toBeUndefined();
    expect(readFileSync(privatePath, 'utf8')).toBe('private');
    expect(readFileSync(ordinary, 'utf8')).toBe('ordinary');
  } finally {
    await f.close();
  }
});

test('ordinary hardlink reads retain compatibility without issuing a writable baseline', async () => {
  const f = fixture();
  try {
    const path = join(f.external, 'original'),
      link = join(f.external, 'alias');
    writeFileSync(path, 'linked');
    linkSync(path, link);
    const read = JSON.parse((await f.execute('files.read', { path: link })).content);
    expect(read.content).toBe('linked');
    expect(read.baseline).toBeUndefined();
    const write = await f.execute('files.write', { path: link, base: null, content: 'never' });
    expect(write.outcome).toBe('failed');
    expect(readFileSync(path, 'utf8')).toBe('linked');
  } finally {
    await f.close();
  }
});

test('stale baseline and a changed prepared parent are rejected before publication', async () => {
  const f = fixture();
  try {
    const path = join(f.external, 'existing');
    writeFileSync(path, 'before');
    const baseline = JSON.parse((await f.execute('files.read', { path })).content).baseline;
    writeFileSync(path, 'changed externally');
    expect(
      (await f.execute('files.write', { path, base: baseline, content: 'never' })).details,
    ).toMatchObject({ code: 'file_baseline_conflict' });
    const fresh = join(f.external, 'new', 'file.txt'),
      input = { path: fresh, base: null, content: 'never' };
    const req = f.request('files.write', input),
      context = await f.context(req);
    mkdirSync(dirname(fresh));
    const result = await f.api.tools.find((t) => t.id === 'files.write')!.execute(input, context);
    expect(result.details).toMatchObject({ code: 'file_dispatch_scope_changed' });
    expect(readFileSync(path, 'utf8')).toBe('changed externally');
  } finally {
    await f.close();
  }
});

test('cancellation before native work has no effect; postpublication artifact failure remains unknown', async () => {
  const f = fixture();
  try {
    const path = join(f.external, 'report.txt'),
      input = { path, base: null, content: 'published' };
    const req = f.request('files.write', input),
      context = await f.context(req),
      controller = new AbortController();
    controller.abort();
    expect(
      (
        await f.api.tools
          .find((t) => t.id === 'files.write')!
          .execute(input, { ...context, signal: controller.signal })
      ).outcome,
    ).toBe('cancelled');
    const result = await f.execute('files.write', input, {
      artifacts: {
        async publish() {
          throw Error('owned snapshot failure');
        },
      } as unknown as ToolContext['artifacts'],
    });
    expect(result.outcome).toBe('outcome_unknown');
    expect(result.content).toContain('Do not repeat');
    expect(result.details).toMatchObject({
      code: 'file_publish_outcome_unknown',
      workspaceCheckpoint: false,
    });
    expect(readFileSync(path, 'utf8')).toBe('published');
  } finally {
    await f.close();
  }
});

test('workspace calls still enter their original capture and retain relative paths', async () => {
  const f = fixture();
  try {
    const result = await f.execute('files.write', {
      path: join(f.workspace, 'inside'),
      base: null,
      content: 'inside',
    });
    expect(result.outcome).toBe('succeeded');
    expect(JSON.parse(result.content).path).toBe('inside');
    expect(f.captures()).toBe(1);
    expect(canonicalJson(result.details as Json)).not.toContain('workspaceCheckpoint');
  } finally {
    await f.close();
  }
});

test.skipIf(process.platform === 'win32')(
  'a parent replaced after preparation cannot become the new native write root',
  async () => {
    const f = fixture();
    try {
      const path = join(f.external, 'never.txt'),
        input = { path, base: null, content: 'never' };
      const req = f.request('files.write', input),
        context = await f.context(req),
        controller = new AbortController();
      const original = controller.signal.throwIfAborted.bind(controller.signal);
      let checks = 0;
      Object.defineProperty(controller.signal, 'throwIfAborted', {
        value() {
          original();
          if (++checks === 2) {
            renameSync(f.external, join(f.root, 'original-external'));
            mkdirSync(f.external);
          }
        },
      });
      const result = await f.api.tools
        .find((tool) => tool.id === 'files.write')!
        .execute(input, { ...context, signal: controller.signal });
      expect(checks).toBe(2);
      expect(result.details).toMatchObject({ code: 'file_dispatch_scope_changed' });
      expect(() => readFileSync(path)).toThrow();
      expect(() => readFileSync(join(f.root, 'original-external', 'never.txt'))).toThrow();
    } finally {
      await f.close();
    }
  },
);

test('the established outer read v5 bridge still returns a complete Full external baseline', async () => {
  const f = fixture();
  try {
    const path = join(f.external, 'file.txt');
    writeFileSync(path, 'editable');
    const req = f.request('files.read', { path }),
      capability = await f.reads.describeRequest({ ...req, definitionVersion: '5' });
    const result = await f.api.tools
      .find((tool) => tool.id === 'files.read')!
      .execute(req.input, {
        ...(await f.context(req)),
        dispatchAuthorization: {
          revision: 'outer-input-reader',
          snapshot: f.proof('full', capability),
        },
      } as unknown as ToolContext);
    expect(JSON.parse(result.content).baseline.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(result.content).content).toBe('editable');
  } finally {
    await f.close();
  }
});

test('a native close fault preserves an already-unknown publication and its original diagnostic', () => {
  const entry = new URL('../../../src/files.ts', import.meta.url).href;
  const binding = fileURLToPath(new URL('../../../src/files-native-binding.ts', import.meta.url));
  const child = spawnProcessSync(
    [
      process.execPath,
      '--eval',
      `
    import {mock} from '#kite-test';
    import * as fs from 'node:fs';
    import {tmpdir} from 'node:os';
    import {join} from 'node:path';
    const binding = await import(${JSON.stringify(pathToFileURL(binding).href)});
    const actualNative = binding.createNativeWorkspaceFileIo;
    let closeFault = false, publications = 0;
    mock.module(${JSON.stringify(binding)}, () => ({...binding, createNativeWorkspaceFileIo(...args) {
      const io = actualNative(...args);
      return {...io, publishAt(...values) { publications++; return io.publishAt(...values); }, close() {
        io.close(); if (closeFault) throw Error('owned close failure');
      }};
    }}));
    const {createWorkspaceFiles,createFileTools,withFullAccessFiles} = await import(${JSON.stringify(entry)});
    const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'kite-full-close-'))), workspace=join(root,'workspace'), external=join(root,'external');
    fs.mkdirSync(workspace);fs.mkdirSync(external);
    const native=createWorkspaceFiles({root:workspace}), path=join(external,'report.txt');
    const api=withFullAccessFiles({tools:createFileTools(native),workspaceRoot:async()=>workspace,protectedRoots:()=>[]});
    const input={path,base:null,content:'published'}, signal=new AbortController().signal;
    const request={kind:'tool',sessionId:'s',runId:'r',executionId:'write',definitionId:'files.write',definitionVersion:'3',input,signal};
    try {
      const capability=await api.describeRequest(request,{mode:'full'});
      const result=await api.tools.find(t=>t.id==='files.write').execute(input,{
        ...request,dispatchAuthorization:{revision:'accepted',snapshot:{namespace:'builtin.permissions',version:'1',data:{mode:'full',workspaceTrust:true,capability}}},
        artifacts:{async publish(){closeFault=true;throw Error('original snapshot failure');}},
      });
      console.log(JSON.stringify({result,publications,content:fs.readFileSync(path,'utf8')}));
    } finally {closeFault=false;await native.close();fs.rmSync(root,{recursive:true});}
  `,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const facts = JSON.parse(child.stdout.toString().trim());
  expect(facts.result.outcome).toBe('outcome_unknown');
  expect(facts.result.details.code).toBe('file_publish_outcome_unknown');
  expect(facts.result.content).toContain('original snapshot failure');
  expect(facts.result.content).toContain('owned close failure');
  expect(facts.publications).toBe(1);
  expect(facts.content).toBe('published');
});

test.skipIf(process.platform === 'win32')(
  'Full writes a new owned file in an OS-writable shared parent without adding a parent-owner restriction',
  async () => {
    const f = fixture(),
      path = join(realpathSync('/tmp'), `kite-full-shared-${randomUUID()}.txt`),
      content = `owned-${randomUUID()}`;
    let cleanupMatched = true;
    try {
      const result = await f.execute('files.write', { path, base: null, content });
      expect(result.outcome, result.content).toBe('succeeded');
      expect(readFileSync(path, 'utf8')).toBe(content);
      const read = JSON.parse((await f.execute('files.read', { path })).content);
      expect(read.content).toBe(content);
      expect(read.baseline.hash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      if (existsSync(path)) {
        cleanupMatched = readFileSync(path, 'utf8') === content;
        if (cleanupMatched) unlinkSync(path);
      }
      await f.close();
    }
    expect(cleanupMatched).toBe(true);
  },
);
