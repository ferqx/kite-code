import { describe, expect, it } from 'bun:test';
import {
  type DocumentationMap,
  evaluateDocumentationImpact,
  matchesDocumentationPattern,
} from '../scripts/check-docs-impact';

const map: DocumentationMap = {
  version: 1,
  rules: [
    {
      id: 'runtime',
      sources: ['src/core/runtime/**'],
      documents: ['docs/active/runtime.md', 'docs/book/runtime.md'],
    },
  ],
};

describe('documentation impact gate', () => {
  it('matches directory and exact-file patterns across path separators', () => {
    expect(
      matchesDocumentationPattern('src\\core\\runtime\\kernel.ts', 'src/core/runtime/**'),
    ).toBe(true);
    expect(matchesDocumentationPattern('src/core/runtime.ts', 'src/core/runtime/**')).toBe(false);
    expect(matchesDocumentationPattern('./src/protocol/events.ts', 'src/protocol/events.ts')).toBe(
      true,
    );
  });

  it('requires an affected document for matching implementation changes', () => {
    expect(evaluateDocumentationImpact(['src/core/runtime/kernel.ts'], map)).toEqual([
      {
        ruleId: 'runtime',
        sources: ['src/core/runtime/kernel.ts'],
        expectedDocuments: ['docs/active/runtime.md', 'docs/book/runtime.md'],
      },
    ]);
  });

  it('accepts any mapped current document in the same staged change', () => {
    expect(
      evaluateDocumentationImpact(['src/core/runtime/kernel.ts', 'docs/active/runtime.md'], map),
    ).toEqual([]);
  });

  it('does not require documentation for unrelated or documentation-only changes', () => {
    expect(evaluateDocumentationImpact(['tests/runtime/kernel.test.ts'], map)).toEqual([]);
    expect(evaluateDocumentationImpact(['docs/active/runtime.md'], map)).toEqual([]);
  });
});
