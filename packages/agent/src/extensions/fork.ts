import Ajv from 'ajv';
import { AgentError, type ExtensionRecord, type Json, type JsonSchema } from '../storage/types';

export interface ForkRecordInput {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly selectionId: string;
  readonly boundary: { readonly upperSeq: string };
  readonly records: readonly Readonly<ExtensionRecord>[];
  /** Opt-in, schema-validated same-namespace snapshot; never another extension. */
  readonly namespaceRecords?: readonly Readonly<ExtensionRecord>[];
  readonly selectedMessages: readonly {
    readonly id: string;
    readonly seq: string;
    readonly sourceIds: readonly string[];
  }[];
}
export type ForkReadSourceDeclaration =
  | {
      readonly kind: 'execution';
      readonly executionId: string;
      readonly executionKind: 'model' | 'tool' | 'job';
      readonly artifactRefIds: readonly string[];
    }
  | {
      readonly kind: 'inherited';
      readonly anchorKey: string;
      readonly executionId: string;
      readonly artifactRefIds: readonly string[];
    };
export interface ForkRecordOutput {
  readonly key: string;
  readonly contentType: string;
  readonly contentVersion: number;
  readonly value: Json;
  readonly readonlySources?: readonly ForkReadSourceDeclaration[];
}
/** Trusted host registration, never accepted from a public Fork command or a renderer. */
export type RecordForkRule =
  | { readonly mode: 'omit' }
  | {
      readonly mode: 'copy';
      readonly version: string;
      readonly onUnsupported?: 'omit' | 'reject';
    }
  | {
      readonly mode: 'rebuild';
      readonly version: string;
      readonly sourceScope?: 'namespace';
      readonly sourceReads?: 'declared';
      readonly onUnsupported?: 'omit' | 'reject';
      prepare(input: Readonly<ForkRecordInput>): Promise<readonly ForkRecordOutput[]>;
    };
export function sealForkRule(rule: RecordForkRule | undefined): RecordForkRule | undefined {
  if (!rule) return undefined;
  const fields =
    rule.mode === 'omit'
      ? ['mode']
      : rule.mode === 'copy'
        ? ['mode', 'version', 'onUnsupported']
        : ['mode', 'version', 'onUnsupported', 'sourceScope', 'sourceReads', 'prepare'];
  if (Object.keys(rule).some((key) => !fields.includes(key)))
    throw new AgentError('fork_rule_invalid');
  if (rule.mode === 'omit') return Object.freeze({ mode: 'omit' });
  if (
    !['copy', 'rebuild'].includes(rule.mode) ||
    typeof rule.version !== 'string' ||
    !rule.version ||
    rule.version.length > 128 ||
    (rule.onUnsupported !== undefined && !['omit', 'reject'].includes(rule.onUnsupported))
  )
    throw new AgentError('fork_rule_invalid');
  if (rule.mode === 'copy') {
    return Object.freeze({
      mode: 'copy',
      version: rule.version,
      onUnsupported: rule.onUnsupported ?? 'omit',
    });
  }
  if (rule.sourceScope !== undefined && rule.sourceScope !== 'namespace')
    throw new AgentError('fork_rule_invalid');
  if (rule.sourceReads !== undefined && rule.sourceReads !== 'declared')
    throw new AgentError('fork_rule_invalid');
  if (typeof rule.prepare !== 'function') throw new AgentError('fork_rule_invalid');
  const implementation = rule.prepare;
  const sealed: Extract<RecordForkRule, { mode: 'rebuild' }> = {
    mode: 'rebuild',
    version: rule.version,
    onUnsupported: rule.onUnsupported ?? 'omit',
    ...(rule.sourceScope ? { sourceScope: rule.sourceScope } : {}),
    ...(rule.sourceReads ? { sourceReads: rule.sourceReads } : {}),
    prepare(input) {
      return implementation.call(sealed, input);
    },
  };
  return Object.freeze(sealed);
}
export function recordValidator(schema: JsonSchema) {
  if (schema.$async === true) throw new AgentError('fork_schema_unsupported');
  return new Ajv({ allErrors: true, strict: false }).compile(structuredClone(schema));
}
