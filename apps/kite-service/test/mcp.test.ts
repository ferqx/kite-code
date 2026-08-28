// MCP core unit tests
import { afterEach, describe, expect, it } from 'bun:test';
import { normalizeMcpToolResult } from '@kite-ai/builtin-runtime/mcp';
import {
  compileCapabilitySchema,
  createCapabilitySnapshot,
  descriptorRevision,
  validateCapabilityArguments,
} from '@kite-ai/builtin-runtime/skills';
import type { CapabilityDescriptor } from '@kite-ai/runtime-contract';
import { expandEnvVars } from '#kite-service/config/index';

// ─── capability schema and revisions ─────────────────────────────

describe('capability schema', () => {
  const schema = {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  };

  it('compiles object schemas and validates arguments', () => {
    expect(compileCapabilitySchema(schema).ok).toBe(true);
    expect(validateCapabilityArguments(schema, { name: 'kite' })).toBeNull();
    expect(validateCapabilityArguments(schema, {})).toContain('Arguments do not match');
  });

  it('rejects non-object and malformed schemas instead of widening to any', () => {
    expect(compileCapabilitySchema({ type: 'string' }).ok).toBe(false);
    const malformed = { type: 'object', properties: { x: 1 } };
    expect(compileCapabilitySchema(malformed).ok).toBe(false);
    expect(compileCapabilitySchema(malformed).ok).toBe(false);
  });

  it('changes a snapshot revision when a same-count tool changes', () => {
    const descriptor = (schemaValue: Record<string, unknown>): CapabilityDescriptor => {
      const base = {
        capabilityId: 'mcp:test/read',
        kind: 'mcp_tool' as const,
        displayName: 'read',
        description: 'read',
        provider: { type: 'mcp' as const, id: 'test', provenance: 'remote' as const },
        inputSchema: schemaValue,
        declaredEffects: {
          filesystem: 'unknown' as const,
          network: 'unknown' as const,
          externalState: 'unknown' as const,
        },
        effectiveEffects: {
          filesystem: 'unknown' as const,
          network: 'unknown' as const,
          externalState: 'unknown' as const,
        },
        policy: { workspaceTrustRequired: false, minimumApproval: 'user' as const },
        availability: 'available' as const,
        diagnostics: [],
      };
      return { ...base, revision: descriptorRevision(base) };
    };
    expect(createCapabilitySnapshot([descriptor(schema)]).revision).not.toBe(
      createCapabilitySnapshot([descriptor({ type: 'object', properties: {} })]).revision,
    );
  });
});

describe('MCP result normalization', () => {
  it('preserves protocol content, structured content and isError', () => {
    const normalized = normalizeMcpToolResult({
      isError: true,
      content: [
        { type: 'text', text: 'failed' },
        { type: 'resource_link', uri: 'resource://fixture', name: 'fixture' },
      ],
      structuredContent: { code: 'E_FIXTURE' },
      _meta: { secret: 'must-not-be-persisted' },
    } as unknown as Parameters<typeof normalizeMcpToolResult>[0]);
    expect(normalized.status).toBe('error');
    expect(normalized.content).toHaveLength(2);
    expect(normalized.structuredContent).toEqual({ code: 'E_FIXTURE' });
    expect(normalized.providerMeta).toBeUndefined();
  });

  it('marks invalid structured output as partial instead of successful', () => {
    const normalized = normalizeMcpToolResult(
      {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { count: 'one' },
      } as unknown as Parameters<typeof normalizeMcpToolResult>[0],
      {
        type: 'object',
        properties: { count: { type: 'number' } },
        required: ['count'],
      },
    );
    expect(normalized.status).toBe('partial');
    expect(normalized.error?.kind).toBe('tool_invalid_args');
  });
});

// ─── expandEnvVars ───────────────────────────────────────────────

describe('expandEnvVars', () => {
  afterEach(() => {
    delete process.env.TEST_MCP_VAR;
    delete process.env.TEST_MCP_EMPTY;
  });

  it('returns the original string if no variables', () => {
    expect(expandEnvVars('hello world')).toBe('hello world');
  });

  it('expands environment variable from process.env', () => {
    process.env.TEST_MCP_VAR = 'expanded_value';
    expect(expandEnvVars(`prefix_\${TEST_MCP_VAR}_suffix`)).toBe('prefix_expanded_value_suffix');
  });

  it('returns empty string for unset variable', () => {
    expect(expandEnvVars(`\${NONEXISTENT_VAR_12345}`)).toBe('');
  });

  it('uses default fallback syntax when variable is unset', () => {
    expect(expandEnvVars(`\${NONEXISTENT_VAR_12345:-fallback}`)).toBe('fallback');
  });

  it('uses env value over default when set', () => {
    process.env.TEST_MCP_VAR = 'real_value';
    expect(expandEnvVars(`\${TEST_MCP_VAR:-fallback}`)).toBe('real_value');
  });

  it('uses default value when env var is empty string', () => {
    process.env.TEST_MCP_EMPTY = '';
    expect(expandEnvVars(`\${TEST_MCP_EMPTY:-default_val}`)).toBe('default_val');
  });

  it('handles multiple variables in one string', () => {
    process.env.TEST_MCP_VAR = 'alpha';
    expect(expandEnvVars(`\${TEST_MCP_VAR}_\${MISSING:-beta}`)).toBe('alpha_beta');
  });
});
