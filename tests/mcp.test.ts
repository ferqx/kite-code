// MCP core unit tests
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { expandEnvVars } from '../src/core/config/index';
import { jsonSchemaToZod } from '../src/core/mcp/tool-adapter';

// ─── jsonSchemaToZod ─────────────────────────────────────────────

describe('jsonSchemaToZod', () => {
  it('maps string type', () => {
    const result = jsonSchemaToZod({
      type: 'string',
      description: 'A name',
    });
    expect(result).toBeInstanceOf(z.ZodString);
  });

  it('maps number type', () => {
    const result = jsonSchemaToZod({ type: 'number' });
    expect(result).toBeInstanceOf(z.ZodNumber);
  });

  it('maps integer type to ZodNumber with .int()', () => {
    const result = jsonSchemaToZod({ type: 'integer' });
    expect(result).toBeInstanceOf(z.ZodNumber);
  });

  it('maps boolean type', () => {
    const result = jsonSchemaToZod({ type: 'boolean' });
    expect(result).toBeInstanceOf(z.ZodBoolean);
  });

  it('maps object with properties and required', () => {
    const result = jsonSchemaToZod({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
      },
      required: ['name'],
    });
    expect(result).toBeInstanceOf(z.ZodObject);

    // name is required, age is optional
    const parsedValid = result.safeParse({ name: 'Alice' });
    expect(parsedValid.success).toBe(true);

    const parsedInvalid = result.safeParse({ age: 30 });
    // name is required, so this should fail
    expect(parsedInvalid.success).toBe(false);
  });

  it('maps string enum', () => {
    const result = jsonSchemaToZod({
      type: 'string',
      enum: ['red', 'green', 'blue'],
    });
    expect(result).toBeInstanceOf(z.ZodEnum);
    const parsed = result.safeParse('red');
    expect(parsed.success).toBe(true);
    const parsedBad = result.safeParse('yellow');
    expect(parsedBad.success).toBe(false);
  });

  it('maps array with items', () => {
    const result = jsonSchemaToZod({
      type: 'array',
      items: { type: 'string' },
    });
    expect(result).toBeInstanceOf(z.ZodArray);
    const parsed = result.safeParse(['a', 'b']);
    expect(parsed.success).toBe(true);
  });

  it('maps array without items to ZodArray<ZodAny>', () => {
    const result = jsonSchemaToZod({
      type: 'array',
    });
    expect(result).toBeInstanceOf(z.ZodArray);
    const parsed = result.safeParse([1, 'b', true]);
    expect(parsed.success).toBe(true);
  });

  it('falls back to ZodAny for null/empty schema', () => {
    const result1 = jsonSchemaToZod({} as unknown as Parameters<typeof jsonSchemaToZod>[0]);
    expect(result1).toBeInstanceOf(z.ZodAny);

    const result2 = jsonSchemaToZod(null as unknown as Parameters<typeof jsonSchemaToZod>[0]);
    expect(result2).toBeInstanceOf(z.ZodAny);
  });

  it('preserves description on various types', () => {
    const desc = 'My custom field';
    const strResult = jsonSchemaToZod({ type: 'string', description: desc });
    expect(strResult.description).toBe(desc);

    const numResult = jsonSchemaToZod({ type: 'number', description: desc });
    expect(numResult.description).toBe(desc);

    const boolResult = jsonSchemaToZod({ type: 'boolean', description: desc });
    expect(boolResult.description).toBe(desc);
  });

  it('maps object without properties to passthrough', () => {
    const result = jsonSchemaToZod({ type: 'object' });
    expect(result).toBeInstanceOf(z.ZodObject);
    // Passthrough objects accept extra keys
    const parsed = result.safeParse({ anything: 'goes' });
    expect(parsed.success).toBe(true);
  });

  it('maps nested objects', () => {
    const result = jsonSchemaToZod({
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            email: { type: 'string' },
          },
          required: ['name'],
        },
      },
      required: ['user'],
    });
    expect(result).toBeInstanceOf(z.ZodObject);
    const parsed = result.safeParse({
      user: { name: 'Bob', email: 'bob@example.com' },
    });
    expect(parsed.success).toBe(true);
    // Missing required nested field
    const parsedBad = result.safeParse({
      user: { email: 'bob@example.com' },
    });
    expect(parsedBad.success).toBe(false);
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

  it('expands ${VAR} from process.env', () => {
    process.env.TEST_MCP_VAR = 'expanded_value';
    expect(expandEnvVars('prefix_${TEST_MCP_VAR}_suffix')).toBe('prefix_expanded_value_suffix');
  });

  it('returns empty string for unset variable', () => {
    expect(expandEnvVars('${NONEXISTENT_VAR_12345}')).toBe('');
  });

  it('uses default value with ${VAR:-default} syntax when unset', () => {
    expect(expandEnvVars('${NONEXISTENT_VAR_12345:-fallback}')).toBe('fallback');
  });

  it('uses env value over default when set', () => {
    process.env.TEST_MCP_VAR = 'real_value';
    expect(expandEnvVars('${TEST_MCP_VAR:-fallback}')).toBe('real_value');
  });

  it('uses default value when env var is empty string', () => {
    process.env.TEST_MCP_EMPTY = '';
    expect(expandEnvVars('${TEST_MCP_EMPTY:-default_val}')).toBe('default_val');
  });

  it('handles multiple variables in one string', () => {
    process.env.TEST_MCP_VAR = 'alpha';
    expect(expandEnvVars('${TEST_MCP_VAR}_${MISSING:-beta}')).toBe('alpha_beta');
  });
});
