import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import ts from 'typescript';
import {
  type AgentApiArtifactJson,
  canonicalAgentApiJson,
  generateAgentApiArtifacts,
} from '../src/generation';
import { AGENT_API_ARTIFACT_DIGEST, AGENT_API_LIMITS } from '../src/index';

const packageRoot = join(import.meta.dir, '..');
const generatedRoot = join(packageRoot, 'generated');

function examples(): Readonly<Record<string, AgentApiArtifactJson>> {
  return Object.fromEntries(
    readdirSync(join(packageRoot, 'fixtures'))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => [
        name.slice(0, -'.json'.length),
        JSON.parse(
          readFileSync(join(packageRoot, 'fixtures', name), 'utf8'),
        ) as AgentApiArtifactJson,
      ]),
  );
}

function committedFiles(): Map<string, string> {
  const collect = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
      const child = join(path, entry.name);
      return entry.isDirectory() ? collect(child) : entry.isFile() ? [child] : [];
    });
  return new Map(
    collect(generatedRoot).map((path) => [
      relative(generatedRoot, path).replaceAll('\\', '/'),
      readFileSync(path, 'utf8'),
    ]),
  );
}

describe('Agent API generated artifacts', () => {
  test('keeps committed OpenAPI, JSON Schema, declarations and examples byte-exact', () => {
    const generated = generateAgentApiArtifacts({ examples: examples() });
    const committed = committedFiles();
    for (const [path, contents] of generated.files) {
      expect(committed.get(path), path).toBe(contents);
    }
    expect(
      [...committed.keys()]
        .filter((path) => path !== 'digest.json' && path !== 'artifact-digest.ts')
        .sort(),
    ).toEqual([...generated.files.keys()].sort());
  });

  test('binds the digest to every non-digest artifact', () => {
    const committed = committedFiles();
    const digest = JSON.parse(committed.get('digest.json') ?? '{}') as {
      schema?: string;
      api_version?: string;
      algorithm?: string;
      digest?: string;
      files?: readonly { readonly path: string; readonly sha256: string }[];
    };
    expect(digest.schema).toBe('kite.agent-api.artifact-digest.v1');
    expect(digest.api_version).toBe('v1');
    expect(digest.algorithm).toBe('sha256');
    const aggregate = createHash('sha256');
    aggregate.update('kite.agent-api.artifacts.v1\0');
    for (const file of digest.files ?? []) {
      const contents = committed.get(file.path);
      expect(contents, file.path).toBeDefined();
      expect(
        createHash('sha256')
          .update(contents ?? '')
          .digest('hex'),
      ).toBe(file.sha256);
      aggregate.update(file.path);
      aggregate.update('\0');
      aggregate.update(file.sha256);
      aggregate.update('\0');
    }
    if (!digest.digest) throw new Error('Generated digest is missing.');
    expect(aggregate.digest('hex')).toBe(digest.digest);
    expect(digest.digest).toBe(AGENT_API_ARTIFACT_DIGEST);
  });

  test('publishes the exact stable route/status/security surface without live secrets', () => {
    const openapiText = committedFiles().get('openapi.json') ?? '';
    const openapi = JSON.parse(openapiText) as {
      openapi?: string;
      'x-kite-contract-limits'?: unknown;
      paths?: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
      components?: { securitySchemes?: Record<string, unknown> };
    };
    expect(openapi.openapi).toBe('3.1.0');
    expect(openapi['x-kite-contract-limits']).toEqual(AGENT_API_LIMITS);
    expect(Object.keys(openapi.paths ?? {}).sort()).toEqual(
      [
        '/v1',
        '/v1/auth/exchange',
        '/v1/auth/session',
        '/v1/sessions',
        '/v1/sessions/{session_id}',
        '/v1/sessions/{session_id}/checkpoints',
        '/v1/sessions/{session_id}/checkpoints/{checkpoint_id}/preview',
        '/v1/sessions/{session_id}/close',
        '/v1/sessions/{session_id}/events',
        '/v1/sessions/{session_id}/forks',
        '/v1/sessions/{session_id}/history',
        '/v1/sessions/{session_id}/interactions',
        '/v1/sessions/{session_id}/interactions/{interaction_id}/responses',
        '/v1/sessions/{session_id}/resume',
        '/v1/sessions/{session_id}/rewinds',
        '/v1/sessions/{session_id}/runs',
        '/v1/sessions/{session_id}/runs/{run_id}',
        '/v1/sessions/{session_id}/runs/{run_id}/cancel',
        '/v1/sessions/{session_id}/runs/{run_id}/events',
        '/v1/sessions/{session_id}/runs/{run_id}/wait',
      ].sort(),
    );
    expect(
      Object.keys(openapi.paths?.['/v1/sessions/{session_id}/runs']?.post?.responses ?? {}).filter(
        (status) => status.startsWith('2'),
      ),
    ).toEqual(['202']);
    const createRunSuccess =
      openapi.paths?.['/v1/sessions/{session_id}/runs']?.post?.responses?.['202'];
    expect(JSON.stringify(createRunSuccess)).toContain('"const":"create_run"');
    expect(JSON.stringify(createRunSuccess)).toContain('"$ref":"#/components/schemas/AgentApiRun"');
    expect(
      Object.keys(
        openapi.paths?.['/v1/sessions/{session_id}/runs/{run_id}/wait']?.get?.responses ?? {},
      ).filter((status) => status.startsWith('2')),
    ).toEqual(['200', '202']);
    expect(Object.keys(openapi.components?.securitySchemes ?? {}).sort()).toEqual([
      'AgentApiContext',
      'WorkerConnectionCapability',
    ]);
    expect(openapiText).not.toContain('/healthz');
    expect(openapiText).not.toContain('/readyz');
    expect(openapiText).not.toContain('/api-docs');
    expect(openapiText).not.toMatch(/\/Users\/|[A-Za-z]:\\|BEGIN [A-Z ]*PRIVATE KEY/u);
  });

  test('emits syntactically valid standalone wire declarations', () => {
    const declarations = committedFiles().get('wire.d.ts') ?? '';
    const source = ts.createSourceFile(
      'wire.d.ts',
      declarations,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const parsed = source as ts.SourceFile & {
      readonly parseDiagnostics: readonly ts.Diagnostic[];
    };
    expect(parsed.parseDiagnostics).toEqual([]);
    expect(declarations).toContain('export type AgentApiRun =');
    expect(declarations).toContain('export type AgentApiProblem =');
  });

  test('emits valid draft 2020-12 JSON Schemas', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const committed = committedFiles();
    const schemaPaths = [...committed.keys()].filter((path) => path.startsWith('schema/'));
    expect(schemaPaths).toHaveLength(33);
    for (const path of schemaPaths) {
      const schema = JSON.parse(committed.get(path) ?? '{}');
      expect(ajv.validateSchema(schema), `${path}: ${ajv.errorsText()}`).toBeTrue();
      ajv.addSchema(schema);
    }
  });

  test('uses canonical JSON for stable generation order', () => {
    expect(canonicalAgentApiJson({ z: 1, a: ['x', { y: true, b: null }] })).toBe(
      '{"a":["x",{"b":null,"y":true}],"z":1}',
    );
  });
});
