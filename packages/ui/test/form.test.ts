import { expect, test } from 'bun:test';
import { describeInput, serializeInput } from '../src/form';

test('flat schema creates typed fields and preserves future draft keys', () => {
  const form = describeInput({
    type: 'object',
    additionalProperties: false,
    required: ['businessKey', 'count', 'marked'],
    properties: {
      businessKey: { type: 'string', minLength: 1 },
      count: { type: 'integer' },
      marked: { type: 'boolean' },
      priority: { type: 'string', enum: ['low', 'high'] },
    },
  });
  expect(form.kind).toBe('fields');
  expect(
    serializeInput(
      form,
      { businessKey: 'new-intent', count: '2', marked: false, priority: 'high' },
      { future: { data: 1 } },
    ),
  ).toEqual({
    businessKey: 'new-intent',
    count: 2,
    marked: false,
    priority: 'high',
    future: { data: 1 },
  });
  expect(() => serializeInput(form, { count: '2', marked: false })).toThrow('Input required');
  expect(() =>
    serializeInput(form, { businessKey: 'k', count: '9007199254740993', marked: false }),
  ).toThrow('Invalid number');
});

test('nested, unknown, references and unsupported constraints explicitly use raw JSON', () => {
  for (const schema of [
    true,
    { type: 'array' },
    { type: 'object', additionalProperties: false, properties: { nested: { type: 'object' } } },
    { type: 'object', additionalProperties: false, properties: {}, oneOf: [] },
    { type: 'object', additionalProperties: false, properties: { x: { $ref: '#/$defs/x' } } },
    { type: 'object', additionalProperties: true, properties: {} },
  ])
    expect(describeInput(schema).kind).toBe('raw-json');
});
