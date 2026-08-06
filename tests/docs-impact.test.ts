import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
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
  it('matches directory, glob, and exact-file patterns across path separators', () => {
    expect(
      matchesDocumentationPattern('src\\core\\runtime\\kernel.ts', 'src/core/runtime/**'),
    ).toBe(true);
    expect(matchesDocumentationPattern('src/core/runtime.ts', 'src/core/runtime/**')).toBe(false);
    expect(matchesDocumentationPattern('./src/protocol/events.ts', 'src/protocol/events.ts')).toBe(
      true,
    );
    expect(
      matchesDocumentationPattern(
        'scripts/evals/contracts/qualification/l2-native-conformance-schema-v1.ts',
        'scripts/evals/contracts/qualification/l2-native-*.ts',
      ),
    ).toBe(true);
    expect(
      matchesDocumentationPattern(
        'tests/evals/qualification/l2-evidence.test.ts',
        'tests/evals/qualification/l2-*.test.ts',
      ),
    ).toBe(true);
    expect(
      matchesDocumentationPattern(
        'tests/evals/qualification/nested/l2-evidence.test.ts',
        'tests/evals/qualification/l2-*.test.ts',
      ),
    ).toBe(false);
  });

  it('enforces documentation for a source selected by an in-file glob', () => {
    const globMap: DocumentationMap = {
      version: 1,
      rules: [
        {
          id: 'globbed-runtime',
          sources: ['scripts/evals/contracts/qualification/l2-native-*.ts'],
          documents: ['docs/active/agent-task-evaluation.md'],
        },
      ],
    };

    expect(
      evaluateDocumentationImpact(
        ['scripts/evals/contracts/qualification/l2-native-conformance-schema-v1.ts'],
        globMap,
      ),
    ).toEqual([
      {
        ruleId: 'globbed-runtime',
        sources: ['scripts/evals/contracts/qualification/l2-native-conformance-schema-v1.ts'],
        expectedDocuments: ['docs/active/agent-task-evaluation.md'],
      },
    ]);
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

  it('lets a narrower rule own an explicitly excluded composition source', () => {
    const withCompositionRule: DocumentationMap = {
      version: 1,
      rules: [
        {
          id: 'runtime',
          sources: ['src/core/runtime/**'],
          excludeSources: ['src/core/runtime/agent.ts'],
          documents: ['docs/active/runtime.md'],
        },
        {
          id: 'composition',
          sources: ['src/core/runtime/agent.ts'],
          documents: ['docs/active/session-logging.md'],
        },
      ],
    };

    expect(
      evaluateDocumentationImpact(
        ['src/core/runtime/agent.ts', 'docs/active/session-logging.md'],
        withCompositionRule,
      ),
    ).toEqual([]);
  });

  it('does not let accepted ADRs satisfy the Phase 1C current-document routes', () => {
    const repositoryMap = JSON.parse(
      readFileSync(new URL('../docs/documentation-map.json', import.meta.url), 'utf8'),
    ) as DocumentationMap;
    const phase1cRuleIds = new Set([
      'runtime-kernel',
      'runtime-agent-composition',
      'tool-controller-runtime-composition',
      'subagent',
    ]);
    const rules = repositoryMap.rules.filter((rule) => phase1cRuleIds.has(rule.id));
    expect(rules.map((rule) => rule.id).sort()).toEqual([...phase1cRuleIds].sort());
    for (const rule of rules) {
      expect(rule.documents.some((document) => document.startsWith('docs/adr/'))).toBe(false);
      expect(
        rule.documents.some(
          (document) => document.startsWith('docs/active/') || document.startsWith('docs/book/'),
        ),
      ).toBe(true);
    }
  });
});
