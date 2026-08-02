import { canonicalJsonBytes, sha256Digest } from '../../../scripts/release/canonical-json';
import type { AgentTaskCaseV1 } from './cases/schema';
import { validateAgentTaskCase } from './cases/schema';

export interface SuiteBehaviorIdentityV1 {
  version: 1;
  routeDigest: `sha256:${string}`;
  artifactDigest: `sha256:${string}`;
  contractDigest: `sha256:${string}`;
  toolSchemaDigest: `sha256:${string}`;
  evaluatorDigest: `sha256:${string}`;
}

export interface AgentTaskSuiteRevisionV1 {
  version: 1;
  suiteId: string;
  revision: number;
  oracleVersion: 'agent-task-oracle-v1';
  scorerVersion: 'agent-task-scorer-v1';
  cases: AgentTaskCaseV1[];
  partitions: Array<{ caseId: string; partition: 'development' | 'holdout' }>;
  behaviorIdentity: SuiteBehaviorIdentityV1;
  decision: { id: 'D-07'; status: 'unconfigured'; approvedAt: null };
  evidenceEligible: false;
  suiteDigest: `sha256:${string}`;
}

export interface ContaminationRecordV1 {
  version: 1;
  suiteId: string;
  revision: number;
  caseId: string;
  status: 'suspected' | 'confirmed' | 'cleared';
  reasonCode: string;
  recordDigest: `sha256:${string}`;
}

export interface ModelVisibleCaseV1 {
  version: 1;
  caseId: string;
  title: string;
  category: AgentTaskCaseV1['category'];
  difficulty: AgentTaskCaseV1['difficulty'];
  contextClass: AgentTaskCaseV1['contextClass'];
  accessMode: AgentTaskCaseV1['accessMode'];
  allowedPaths: string[];
  forbiddenPaths: string[];
}

export class AgentTaskSuiteRegistryV1 {
  readonly #revisions = new Map<string, AgentTaskSuiteRevisionV1[]>();
  readonly #contamination: ContaminationRecordV1[] = [];

  register(input: Omit<AgentTaskSuiteRevisionV1, 'suiteDigest'>): AgentTaskSuiteRevisionV1 {
    validateSuiteInput(input);
    const history = this.#revisions.get(input.suiteId) ?? [];
    const expectedRevision = history.length + 1;
    if (input.revision !== expectedRevision) {
      throw new Error(`Suite revision must append as revision ${expectedRevision}.`);
    }
    const suiteDigest = sha256Digest(canonicalJsonBytes(input));
    const revision = structuredClone({ ...input, suiteDigest });
    history.push(revision);
    this.#revisions.set(input.suiteId, history);
    return structuredClone(revision);
  }

  revision(suiteId: string, revision: number): AgentTaskSuiteRevisionV1 {
    const value = this.#revisions.get(suiteId)?.[revision - 1];
    if (!value) throw new Error('Unknown suite revision.');
    return structuredClone(value);
  }

  recordContamination(
    input: Omit<ContaminationRecordV1, 'recordDigest' | 'version'>,
  ): ContaminationRecordV1 {
    exactKeys(input, ['caseId', 'reasonCode', 'revision', 'status', 'suiteId']);
    const revision = this.revision(input.suiteId, input.revision);
    if (!revision.cases.some((task) => task.caseId === input.caseId)) {
      throw new Error('Contamination record references an unknown case.');
    }
    if (!/^[a-z][a-z0-9_]{0,127}$/.test(input.reasonCode)) {
      throw new Error('Contamination reason code is invalid.');
    }
    if (!['suspected', 'confirmed', 'cleared'].includes(input.status)) {
      throw new Error('Contamination status is invalid.');
    }
    const previous = this.#contamination
      .filter(
        (record) =>
          record.suiteId === input.suiteId &&
          record.revision === input.revision &&
          record.caseId === input.caseId,
      )
      .at(-1);
    if (input.status === 'cleared' && (!previous || previous.status === 'cleared')) {
      throw new Error('Contamination can be cleared only after a suspected or confirmed record.');
    }
    const withoutDigest = { version: 1 as const, ...input };
    const record = {
      ...withoutDigest,
      recordDigest: sha256Digest(canonicalJsonBytes(withoutDigest)),
    };
    this.#contamination.push(structuredClone(record));
    return structuredClone(record);
  }

  contaminationRecords(): ContaminationRecordV1[] {
    return structuredClone(this.#contamination);
  }

  caseEligible(suiteId: string, revision: number, caseId: string): boolean {
    const records = this.#contamination.filter(
      (record) =>
        record.suiteId === suiteId && record.revision === revision && record.caseId === caseId,
    );
    const latest = records.at(-1);
    return !latest || latest.status === 'cleared';
  }
}

export function modelVisibleCase(task: AgentTaskCaseV1): ModelVisibleCaseV1 {
  validateAgentTaskCase(task);
  return {
    version: 1,
    caseId: task.caseId,
    title: task.title,
    category: task.category,
    difficulty: task.difficulty,
    contextClass: task.contextClass,
    accessMode: task.accessMode,
    allowedPaths: [...task.allowedPaths],
    forbiddenPaths: [...task.forbiddenPaths],
  };
}

export function suiteRequiresRerun(
  revision: AgentTaskSuiteRevisionV1,
  current: SuiteBehaviorIdentityV1,
): boolean {
  validateBehaviorIdentity(current);
  return (
    sha256Digest(canonicalJsonBytes(revision.behaviorIdentity)) !==
    sha256Digest(canonicalJsonBytes(current))
  );
}

function validateSuiteInput(input: Omit<AgentTaskSuiteRevisionV1, 'suiteDigest'>): void {
  exactKeys(input, [
    'behaviorIdentity',
    'cases',
    'decision',
    'evidenceEligible',
    'oracleVersion',
    'partitions',
    'revision',
    'scorerVersion',
    'suiteId',
    'version',
  ]);
  exactKeys(input.decision, ['approvedAt', 'id', 'status']);
  if (
    input.version !== 1 ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.suiteId) ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    input.oracleVersion !== 'agent-task-oracle-v1' ||
    input.scorerVersion !== 'agent-task-scorer-v1' ||
    input.decision.id !== 'D-07' ||
    input.decision.status !== 'unconfigured' ||
    input.decision.approvedAt !== null ||
    input.evidenceEligible !== false
  ) {
    throw new Error('Suite revision is invalid or claims unapproved evidence eligibility.');
  }
  input.cases.forEach(validateAgentTaskCase);
  const caseIds = input.cases.map((task) => task.caseId);
  if (caseIds.length === 0 || new Set(caseIds).size !== caseIds.length) {
    throw new Error('Suite cases must be non-empty and unique.');
  }
  if (caseIds.some((caseId, index) => caseId !== [...caseIds].sort()[index])) {
    throw new Error('Suite cases must use stable caseId ordering.');
  }
  for (const partition of input.partitions) {
    exactKeys(partition, ['caseId', 'partition']);
    if (!['development', 'holdout'].includes(partition.partition)) {
      throw new Error('Suite partition value is invalid.');
    }
  }
  const partitionIds = input.partitions.map((partition) => partition.caseId);
  if (
    partitionIds.length !== caseIds.length ||
    new Set(partitionIds).size !== partitionIds.length ||
    caseIds.some((caseId) => !partitionIds.includes(caseId))
  ) {
    throw new Error('Every suite case requires exactly one development/holdout partition.');
  }
  validateBehaviorIdentity(input.behaviorIdentity);
}

function validateBehaviorIdentity(value: SuiteBehaviorIdentityV1): void {
  exactKeys(value, [
    'artifactDigest',
    'contractDigest',
    'evaluatorDigest',
    'routeDigest',
    'toolSchemaDigest',
    'version',
  ]);
  if (
    value.version !== 1 ||
    [
      value.routeDigest,
      value.artifactDigest,
      value.contractDigest,
      value.toolSchemaDigest,
      value.evaluatorDigest,
    ].some((digest) => !/^sha256:[0-9a-f]{64}$/.test(digest))
  ) {
    throw new Error('Suite behavior identity is invalid.');
  }
}

function exactKeys(value: object, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error('Suite registry schema has missing or unknown fields.');
  }
}
