export const AGENT_TASK_CATEGORIES = [
  'repository_research',
  'bug_fix',
  'small_feature',
  'refactor',
  'test',
  'documentation',
  'failure_recovery',
  'adversarial',
] as const;

export const AGENT_TASK_DIFFICULTIES = ['simple', 'medium', 'complex'] as const;
export const AGENT_TASK_CONTEXT_CLASSES = ['short', 'long'] as const;
export const AGENT_TASK_ENTRYPOINTS = ['tui', 'headless_cli'] as const;
export const AGENT_TASK_ACCESS_MODES = ['read_only', 'workspace_write'] as const;

export type AgentTaskCategory = (typeof AGENT_TASK_CATEGORIES)[number];
export type AgentTaskDifficulty = (typeof AGENT_TASK_DIFFICULTIES)[number];
export type AgentTaskContextClass = (typeof AGENT_TASK_CONTEXT_CLASSES)[number];
export type AgentTaskEntrypoint = (typeof AGENT_TASK_ENTRYPOINTS)[number];
export type AgentTaskAccessMode = (typeof AGENT_TASK_ACCESS_MODES)[number];

export type DiffFactV1 =
  | { version: 1; factId: string; kind: 'file_exists'; path: string }
  | { version: 1; factId: string; kind: 'file_absent'; path: string }
  | { version: 1; factId: string; kind: 'file_changed'; path: string }
  | { version: 1; factId: string; kind: 'file_unchanged'; path: string }
  | { version: 1; factId: string; kind: 'file_contains'; path: string; text: string }
  | { version: 1; factId: string; kind: 'file_not_contains'; path: string; text: string }
  | { version: 1; factId: string; kind: 'patch_contains'; text: string }
  | { version: 1; factId: string; kind: 'patch_not_contains'; text: string };

export interface CheckSpecV1 {
  version: 1;
  checkId: string;
  kind: 'test' | 'lint' | 'build' | 'static' | 'security';
  /** Display identity only. A trusted, offline adapter owns execution. */
  command: string[];
  expectedExitCode: 0;
  network: 'off';
  timeoutMs: number;
}

export interface InteractionConstraintV1 {
  version: 1;
  entrypoint: AgentTaskEntrypoint;
  plan: 'required' | 'optional' | 'forbidden';
  approval: 'none_expected' | 'risk_based';
  verificationRequired: boolean;
  projectInstructionsRequired: boolean;
  maxUserCorrections: number;
}

export interface ResourceBudgetRefV1 {
  version: 1;
  budgetId: string;
  maxDurationMs: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}

export interface AgentTaskCaseV1 {
  version: 1;
  caseId: string;
  title: string;
  category: AgentTaskCategory;
  difficulty: AgentTaskDifficulty;
  contextClass: AgentTaskContextClass;
  accessMode: AgentTaskAccessMode;
  repositoryType: 'synthetic_local';
  primaryLanguage: string;
  buildSystem: string;
  fixtureId: string;
  baselineState: 'clean' | 'dirty';
  allowedPaths: string[];
  forbiddenPaths: string[];
  requiredDiffFacts: DiffFactV1[];
  forbiddenDiffFacts: DiffFactV1[];
  requiredChecks: CheckSpecV1[];
  expectedInteractions: InteractionConstraintV1;
  budgets: ResourceBudgetRefV1;
  capabilities: {
    plan: boolean;
    mcp: boolean;
    longContext: boolean;
  };
}

export class AgentTaskSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentTaskSchemaError';
  }
}

const CASE_KEYS = [
  'accessMode',
  'allowedPaths',
  'baselineState',
  'budgets',
  'buildSystem',
  'capabilities',
  'caseId',
  'category',
  'contextClass',
  'difficulty',
  'expectedInteractions',
  'fixtureId',
  'forbiddenDiffFacts',
  'forbiddenPaths',
  'primaryLanguage',
  'repositoryType',
  'requiredChecks',
  'requiredDiffFacts',
  'title',
  'version',
] as const;

export function validateAgentTaskCase(value: unknown): asserts value is AgentTaskCaseV1 {
  const task = exactObject(value, CASE_KEYS, 'AgentTaskCaseV1');
  literal(task.version, 1, 'version');
  identifier(task.caseId, 'caseId');
  boundedString(task.title, 'title');
  member(task.category, AGENT_TASK_CATEGORIES, 'category');
  member(task.difficulty, AGENT_TASK_DIFFICULTIES, 'difficulty');
  member(task.contextClass, AGENT_TASK_CONTEXT_CLASSES, 'contextClass');
  member(task.accessMode, AGENT_TASK_ACCESS_MODES, 'accessMode');
  literal(task.repositoryType, 'synthetic_local', 'repositoryType');
  identifier(task.primaryLanguage, 'primaryLanguage');
  identifier(task.buildSystem, 'buildSystem');
  identifier(task.fixtureId, 'fixtureId');
  member(task.baselineState, ['clean', 'dirty'] as const, 'baselineState');

  const allowedPaths = paths(task.allowedPaths, 'allowedPaths');
  const forbiddenPaths = paths(task.forbiddenPaths, 'forbiddenPaths');
  if (
    allowedPaths.some((allowed) => forbiddenPaths.some((forbidden) => overlaps(allowed, forbidden)))
  ) {
    schemaError('allowedPaths and forbiddenPaths must not overlap.');
  }
  if (task.accessMode === 'workspace_write' && allowedPaths.length === 0) {
    schemaError('workspace_write cases require at least one allowed path.');
  }

  validateFacts(task.requiredDiffFacts, 'requiredDiffFacts');
  validateFacts(task.forbiddenDiffFacts, 'forbiddenDiffFacts');
  uniqueIds(
    [...(task.requiredDiffFacts as DiffFactV1[]), ...(task.forbiddenDiffFacts as DiffFactV1[])],
    'factId',
  );
  validateChecks(task.requiredChecks);
  validateInteractions(task.expectedInteractions);
  validateBudgets(task.budgets);
  const capabilities = exactObject(
    task.capabilities,
    ['longContext', 'mcp', 'plan'] as const,
    'capabilities',
  );
  boolean(capabilities.plan, 'capabilities.plan');
  boolean(capabilities.mcp, 'capabilities.mcp');
  boolean(capabilities.longContext, 'capabilities.longContext');
  if (capabilities.longContext !== (task.contextClass === 'long')) {
    schemaError('capabilities.longContext must match contextClass.');
  }
}

export function parseAgentTaskCase(value: unknown): AgentTaskCaseV1 {
  validateAgentTaskCase(value);
  return structuredClone(value);
}

export function pathMatchesPolicy(path: string, policy: string): boolean {
  return policy.endsWith('/') ? path.startsWith(policy) : path === policy;
}

function validateFacts(value: unknown, label: string): asserts value is DiffFactV1[] {
  if (!Array.isArray(value)) schemaError(`${label} must be an array.`);
  for (const [index, candidate] of value.entries()) {
    const fact = candidate as Record<string, unknown>;
    if (!fact || typeof fact !== 'object' || Array.isArray(fact)) {
      schemaError(`${label}[${index}] must be an object.`);
    }
    const kind = fact.kind;
    if (
      ![
        'file_exists',
        'file_absent',
        'file_changed',
        'file_unchanged',
        'file_contains',
        'file_not_contains',
        'patch_contains',
        'patch_not_contains',
      ].includes(String(kind))
    ) {
      schemaError(`${label}[${index}].kind is unknown.`);
    }
    const requiresPath = String(kind).startsWith('file_');
    const requiresText = String(kind).includes('contains');
    const keys = [
      'factId',
      'kind',
      'version',
      ...(requiresPath ? ['path'] : []),
      ...(requiresText ? ['text'] : []),
    ];
    exactDynamicObject(fact, keys, `${label}[${index}]`);
    literal(fact.version, 1, `${label}[${index}].version`);
    identifier(fact.factId, `${label}[${index}].factId`);
    if (requiresPath) safePath(fact.path, `${label}[${index}].path`);
    if (requiresText) boundedString(fact.text, `${label}[${index}].text`, 8_192);
  }
}

function validateChecks(value: unknown): asserts value is CheckSpecV1[] {
  if (!Array.isArray(value)) schemaError('requiredChecks must be an array.');
  for (const [index, candidate] of value.entries()) {
    const check = exactObject(
      candidate,
      [
        'checkId',
        'command',
        'expectedExitCode',
        'kind',
        'network',
        'timeoutMs',
        'version',
      ] as const,
      `requiredChecks[${index}]`,
    );
    literal(check.version, 1, `requiredChecks[${index}].version`);
    identifier(check.checkId, `requiredChecks[${index}].checkId`);
    member(
      check.kind,
      ['test', 'lint', 'build', 'static', 'security'] as const,
      `requiredChecks[${index}].kind`,
    );
    if (
      !Array.isArray(check.command) ||
      check.command.length === 0 ||
      check.command.some((part) => typeof part !== 'string' || !part || part.includes('\0'))
    ) {
      schemaError(`requiredChecks[${index}].command must be a non-empty argv array.`);
    }
    literal(check.expectedExitCode, 0, `requiredChecks[${index}].expectedExitCode`);
    literal(check.network, 'off', `requiredChecks[${index}].network`);
    positiveInteger(check.timeoutMs, `requiredChecks[${index}].timeoutMs`, 600_000);
  }
  uniqueIds(value as CheckSpecV1[], 'checkId');
}

function validateInteractions(value: unknown): asserts value is InteractionConstraintV1 {
  const interaction = exactObject(
    value,
    [
      'approval',
      'entrypoint',
      'maxUserCorrections',
      'plan',
      'projectInstructionsRequired',
      'verificationRequired',
      'version',
    ] as const,
    'expectedInteractions',
  );
  literal(interaction.version, 1, 'expectedInteractions.version');
  member(interaction.entrypoint, AGENT_TASK_ENTRYPOINTS, 'expectedInteractions.entrypoint');
  member(
    interaction.plan,
    ['required', 'optional', 'forbidden'] as const,
    'expectedInteractions.plan',
  );
  member(
    interaction.approval,
    ['none_expected', 'risk_based'] as const,
    'expectedInteractions.approval',
  );
  boolean(interaction.verificationRequired, 'expectedInteractions.verificationRequired');
  boolean(
    interaction.projectInstructionsRequired,
    'expectedInteractions.projectInstructionsRequired',
  );
  nonNegativeInteger(
    interaction.maxUserCorrections,
    'expectedInteractions.maxUserCorrections',
    100,
  );
}

function validateBudgets(value: unknown): asserts value is ResourceBudgetRefV1 {
  const budget = exactObject(
    value,
    [
      'budgetId',
      'maxDurationMs',
      'maxInputTokens',
      'maxModelCalls',
      'maxOutputTokens',
      'maxToolCalls',
      'version',
    ] as const,
    'budgets',
  );
  literal(budget.version, 1, 'budgets.version');
  identifier(budget.budgetId, 'budgets.budgetId');
  positiveInteger(budget.maxDurationMs, 'budgets.maxDurationMs', 24 * 60 * 60 * 1_000);
  nonNegativeInteger(budget.maxModelCalls, 'budgets.maxModelCalls', 10_000);
  nonNegativeInteger(budget.maxToolCalls, 'budgets.maxToolCalls', 100_000);
  nonNegativeInteger(budget.maxInputTokens, 'budgets.maxInputTokens', 100_000_000);
  nonNegativeInteger(budget.maxOutputTokens, 'budgets.maxOutputTokens', 100_000_000);
}

function paths(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) schemaError(`${label} must be an array.`);
  const result = value.map((entry, index) => safePath(entry, `${label}[${index}]`));
  const sorted = [...result].sort();
  if (result.some((entry, index) => entry !== sorted[index] || entry === result[index - 1])) {
    schemaError(`${label} must be sorted and unique.`);
  }
  return result;
}

function safePath(value: unknown, label: string): string {
  const normalized = typeof value === 'string' && value.endsWith('/') ? value.slice(0, -1) : value;
  if (
    typeof value !== 'string' ||
    !value ||
    !normalized ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.includes('//') ||
    String(normalized)
      .split('/')
      .some((part) => part === '.' || part === '..')
  ) {
    schemaError(`${label} must be a normalized relative repository path.`);
  }
  return value;
}

function overlaps(left: string, right: string): boolean {
  return pathMatchesPolicy(left, right) || pathMatchesPolicy(right, left);
}

function exactObject<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
  label: string,
): Record<Keys[number], unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    schemaError(`${label} must be an object.`);
  }
  exactDynamicObject(value as Record<string, unknown>, [...keys], label);
  return value as Record<Keys[number], unknown>;
}

function exactDynamicObject(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    schemaError(`${label} has missing or unknown fields.`);
  }
}

function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) {
    schemaError(`${label} must be a stable lowercase identifier.`);
  }
}

function boundedString(value: unknown, label: string, maximum = 512): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > maximum || value.includes('\0')) {
    schemaError(`${label} must be a non-empty bounded string.`);
  }
}

function boolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') schemaError(`${label} must be boolean.`);
}

function literal<const Value extends string | number>(
  value: unknown,
  expected: Value,
  label: string,
): asserts value is Value {
  if (value !== expected) schemaError(`${label} must equal ${JSON.stringify(expected)}.`);
}

function member<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): asserts value is Values[number] {
  if (typeof value !== 'string' || !values.includes(value as Values[number])) {
    schemaError(`${label} has an unknown value.`);
  }
}

function positiveInteger(value: unknown, label: string, maximum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    schemaError(`${label} must be a positive bounded integer.`);
  }
}

function nonNegativeInteger(
  value: unknown,
  label: string,
  maximum: number,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    schemaError(`${label} must be a non-negative bounded integer.`);
  }
}

function uniqueIds<Kind extends Record<Key, string>, Key extends keyof Kind>(
  values: Kind[],
  key: Key,
): void {
  const identifiers = values.map((value) => value[key]);
  if (new Set(identifiers).size !== identifiers.length)
    schemaError(`${String(key)} must be unique.`);
}

function schemaError(message: string): never {
  throw new AgentTaskSchemaError(message);
}
