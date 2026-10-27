import { expect, test } from 'bun:test';
import {
  CanonicalJsonError,
  canonicalJson,
  parseCanonicalJson,
  parseStrictJson,
} from '../../scripts/release/canonical-json';

test('uses one strict canonical JSON representation', () => {
  expect(canonicalJson({ z: 1, a: ['x', -0, true] })).toBe('{"a":["x",0,true],"z":1}');
  expect(parseCanonicalJson('{"a":1,"z":2}')).toEqual({ a: 1, z: 2 });
  expect(() => parseCanonicalJson('{ "a": 1 }')).toThrow(CanonicalJsonError);
  expect(() => parseStrictJson('{"a":1,"a":2}')).toThrow('Duplicate JSON key');
  expect(() => canonicalJson({ invalid: undefined })).toThrow(CanonicalJsonError);
  expect(() => canonicalJson({ invalid: Number.NaN })).toThrow(CanonicalJsonError);
  expect(() => parseStrictJson('1e400')).toThrow(CanonicalJsonError);
  const sparse = Array<unknown>(2);
  sparse[1] = 1;
  expect(() => canonicalJson(sparse)).toThrow(CanonicalJsonError);
  const decorated = [1] as number[] & { extra?: number };
  decorated.extra = 2;
  expect(() => canonicalJson(decorated)).toThrow(CanonicalJsonError);
});
