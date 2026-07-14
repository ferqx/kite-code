import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { descriptorRevision, digestCapability } from '@/core/capabilities/catalog';
import { compileCapabilitySchema, type JsonSchema } from '@/core/capabilities/schema';
import type {
  CapabilityApproval,
  CapabilityDescriptor,
  EffectProfile,
} from '@/protocol/capabilities';

export const SKILL_WORKFLOW_SCHEMA_VERSION = 1;

export type SkillDiagnosticCode =
  | 'missing_skill_file'
  | 'yaml_parse_error'
  | 'manifest_not_object'
  | 'unknown_field'
  | 'invalid_field'
  | 'invalid_schema'
  | 'invalid_path'
  | 'missing_path'
  | 'missing_capability'
  | 'dependency_changed';

export interface SkillDiagnostic {
  code: SkillDiagnosticCode;
  message: string;
  path?: string;
}

export interface SkillWorkflowContract {
  schemaVersion: typeof SKILL_WORKFLOW_SCHEMA_VERSION;
  name: string;
  version: string;
  description: string;
  instructions: string;
  invocation: { allowImplicit: boolean; allowManual: boolean };
  context: { mode: 'inline' | 'fork'; agent: string };
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  capabilityCeiling: string[];
  deniedCapabilities: string[];
  effects: EffectProfile;
  minimumApproval: CapabilityApproval;
  execution: { timeoutMs: number; maxAttempts: number };
  verification: {
    mode: 'not_required' | 'best_effort' | 'required';
    strategy?: 'script';
    entrypoint?: string;
    timeoutMs?: number;
  };
  recovery: { retry: 'never' | 'safe_read' | 'idempotency_key'; compensation?: string };
  files: string[];
  dependencyRevisions: Record<string, string>;
}

export interface CompiledSkillWorkflow {
  sourcePath: string;
  source: 'project' | 'user';
  origin: '.kite-code' | '.agents';
  contract?: SkillWorkflowContract;
  descriptor: CapabilityDescriptor;
  diagnostics: SkillDiagnostic[];
}

export interface CompileSkillWorkflowInput {
  skillDir: string;
  source: 'project' | 'user';
  origin: '.kite-code' | '.agents';
  /** Resolves the current revision of a capability named in `capabilities.require`. */
  resolveCapability?: (capabilityId: string) => CapabilityDescriptor | undefined;
}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const EFFECTS = new Set(['none', 'read', 'write', 'destructive', 'unknown']);
const TOP_LEVEL_FIELDS = new Set([
  'name',
  'version',
  'description',
  'invocation',
  'context',
  'input_schema',
  'output_schema',
  'capabilities',
  'effects',
  'approval',
  'execution',
  'verification',
  'recovery',
]);

function diagnostic(
  diagnostics: SkillDiagnostic[],
  code: SkillDiagnosticCode,
  message: string,
  path?: string,
): void {
  diagnostics.push({ code, message, ...(path ? { path } : {}) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function strictRecord(
  value: unknown,
  allowed: readonly string[],
  path: string,
  diagnostics: SkillDiagnostic[],
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    diagnostic(diagnostics, 'invalid_field', `${path} must be an object.`, path);
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      diagnostic(
        diagnostics,
        'unknown_field',
        `${path}.${key} is not supported.`,
        `${path}.${key}`,
      );
    }
  }
  return value;
}

function requiredString(
  value: unknown,
  path: string,
  diagnostics: SkillDiagnostic[],
  matcher?: RegExp,
): string | undefined {
  if (typeof value !== 'string' || !value.trim() || (matcher && !matcher.test(value))) {
    diagnostic(diagnostics, 'invalid_field', `${path} must be a valid non-empty string.`, path);
    return undefined;
  }
  return value;
}

function requiredBoolean(
  value: unknown,
  path: string,
  diagnostics: SkillDiagnostic[],
): boolean | undefined {
  if (typeof value !== 'boolean') {
    diagnostic(diagnostics, 'invalid_field', `${path} must be a boolean.`, path);
    return undefined;
  }
  return value;
}

function requiredPositiveInt(
  value: unknown,
  path: string,
  diagnostics: SkillDiagnostic[],
): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    diagnostic(diagnostics, 'invalid_field', `${path} must be a positive integer.`, path);
    return undefined;
  }
  return value;
}

function readSkillFiles(
  skillDir: string,
  diagnostics: SkillDiagnostic[],
): Array<{ path: string; content: Buffer }> {
  const files: Array<{ path: string; content: Buffer }> = [];
  const root = resolve(skillDir);
  const walk = (directory: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory).sort((left, right) => left.localeCompare(right));
    } catch (error) {
      diagnostic(
        diagnostics,
        'missing_path',
        `Unable to read ${directory}: ${String(error)}`,
        directory,
      );
      return;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry);
      const rel = relative(root, absolute);
      try {
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) {
          diagnostic(
            diagnostics,
            'invalid_path',
            `Skill files may not be symbolic links: ${rel}`,
            rel,
          );
        } else if (stat.isDirectory()) {
          walk(absolute);
        } else if (stat.isFile()) {
          files.push({ path: rel, content: readFileSync(absolute) });
        }
      } catch (error) {
        diagnostic(diagnostics, 'missing_path', `Unable to read ${rel}: ${String(error)}`, rel);
      }
    }
  };
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    diagnostic(diagnostics, 'missing_path', `Skill directory does not exist: ${root}`, root);
    return files;
  }
  walk(root);
  return files;
}

function safeDeclaredPath(
  skillDir: string,
  value: string,
  field: string,
  diagnostics: SkillDiagnostic[],
): string | undefined {
  if (!value || value.includes('\0') || value.split(/[\\/]/).includes('..')) {
    diagnostic(
      diagnostics,
      'invalid_path',
      `${field} must remain within the skill directory.`,
      field,
    );
    return undefined;
  }
  const target = resolve(skillDir, value);
  const root = `${resolve(skillDir)}${sep}`;
  if (!target.startsWith(root) || !existsSync(target) || !statSync(target).isFile()) {
    diagnostic(
      diagnostics,
      'missing_path',
      `${field} does not reference a readable skill file.`,
      field,
    );
    return undefined;
  }
  return value;
}

function effectsFrom(value: unknown, diagnostics: SkillDiagnostic[]): EffectProfile | undefined {
  const record = strictRecord(
    value,
    ['filesystem', 'network', 'external_state'],
    'effects',
    diagnostics,
  );
  if (!record) return undefined;
  const fields = ['filesystem', 'network', 'external_state'] as const;
  const parsed = fields.map((field) => {
    const item = record[field];
    if (typeof item !== 'string' || !EFFECTS.has(item)) {
      diagnostic(diagnostics, 'invalid_field', `effects.${field} is invalid.`, `effects.${field}`);
      return undefined;
    }
    return item as EffectProfile['filesystem'];
  });
  if (parsed.some((item) => !item)) return undefined;
  return { filesystem: parsed[0]!, network: parsed[1]!, externalState: parsed[2]! };
}

function buildDescriptor(input: {
  sourcePath: string;
  source: 'project' | 'user';
  origin: '.kite-code' | '.agents';
  contract?: SkillWorkflowContract;
  diagnostics: SkillDiagnostic[];
  revision: string;
}): CapabilityDescriptor {
  const contract = input.contract;
  const name = contract?.name ?? input.sourcePath.split('/').at(-1) ?? 'invalid-skill';
  const availability = contract && input.diagnostics.length === 0 ? 'available' : 'unavailable';
  const descriptor: Omit<CapabilityDescriptor, 'revision'> = {
    capabilityId: `skill:${name}`,
    kind: 'skill',
    displayName: name,
    description: contract?.description ?? 'Invalid Skill Workflow Contract.',
    provider: {
      type: 'skill',
      id: name,
      provenance: input.source === 'project' ? 'project' : 'user',
      version: contract?.version,
    },
    ...(contract ? { inputSchema: contract.inputSchema, outputSchema: contract.outputSchema } : {}),
    declaredEffects: contract?.effects ?? {
      filesystem: 'unknown',
      network: 'unknown',
      externalState: 'unknown',
    },
    effectiveEffects: contract?.effects ?? {
      filesystem: 'unknown',
      network: 'unknown',
      externalState: 'unknown',
    },
    policy: {
      workspaceTrustRequired: input.source === 'project',
      minimumApproval: contract?.minimumApproval ?? 'user',
    },
    execution: contract ? { retry: contract.recovery.retry } : { retry: 'never' },
    availability,
    diagnostics: input.diagnostics.map((item) => `${item.code}: ${item.message}`),
  };
  return { ...descriptor, revision: input.revision || descriptorRevision(descriptor) };
}

/** Compile a complete, immutable Workflow Contract. Invalid skills are returned as diagnostics, never skipped. */
export function compileSkillWorkflow(input: CompileSkillWorkflowInput): CompiledSkillWorkflow {
  const diagnostics: SkillDiagnostic[] = [];
  const files = readSkillFiles(input.skillDir, diagnostics);
  const skillFile = files.find((file) => file.path === 'SKILL.md');
  if (!skillFile) {
    diagnostic(diagnostics, 'missing_skill_file', 'SKILL.md is required.', 'SKILL.md');
    return {
      sourcePath: resolve(input.skillDir),
      source: input.source,
      origin: input.origin,
      diagnostics,
      descriptor: buildDescriptor({
        sourcePath: resolve(input.skillDir),
        source: input.source,
        origin: input.origin,
        diagnostics,
        revision: digestCapability(
          files.map((file) => [file.path, file.content.toString('base64')]),
        ),
      }),
    };
  }

  const raw = skillFile.content.toString('utf8').replace(/\r\n?/g, '\n');
  const match = raw.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) {
    diagnostic(
      diagnostics,
      'yaml_parse_error',
      'SKILL.md must start with a complete YAML manifest delimited by ---.',
      'SKILL.md',
    );
  }
  let manifest: Record<string, unknown> | undefined;
  let instructions = '';
  if (match) {
    const document = parseDocument(match[1]!, { uniqueKeys: true, prettyErrors: false });
    if (document.errors.length > 0) {
      for (const error of document.errors)
        diagnostic(diagnostics, 'yaml_parse_error', error.message, 'SKILL.md');
    } else if (!isRecord(document.toJS())) {
      diagnostic(
        diagnostics,
        'manifest_not_object',
        'Skill manifest must be a YAML object.',
        'SKILL.md',
      );
    } else {
      manifest = document.toJS() as Record<string, unknown>;
      instructions = match[2]!.trim();
      for (const key of Object.keys(manifest)) {
        if (!TOP_LEVEL_FIELDS.has(key))
          diagnostic(diagnostics, 'unknown_field', `Unknown top-level field '${key}'.`, key);
      }
    }
  }

  let contract: SkillWorkflowContract | undefined;
  if (manifest) {
    const name = requiredString(manifest.name, 'name', diagnostics, NAME);
    const version = requiredString(manifest.version, 'version', diagnostics, SEMVER);
    const description = requiredString(manifest.description, 'description', diagnostics);
    if (!instructions)
      diagnostic(
        diagnostics,
        'invalid_field',
        'Skill instruction body must not be empty.',
        'SKILL.md',
      );
    const invocation = strictRecord(
      manifest.invocation,
      ['allow_implicit', 'allow_manual'],
      'invocation',
      diagnostics,
    );
    const context = strictRecord(manifest.context, ['mode', 'agent'], 'context', diagnostics);
    const capabilities = strictRecord(
      manifest.capabilities,
      ['require', 'deny'],
      'capabilities',
      diagnostics,
    );
    const approval = strictRecord(manifest.approval, ['minimum'], 'approval', diagnostics);
    const execution = strictRecord(
      manifest.execution,
      ['timeout_ms', 'max_attempts'],
      'execution',
      diagnostics,
    );
    const verification = strictRecord(
      manifest.verification,
      ['mode', 'strategy', 'entrypoint', 'timeout_ms'],
      'verification',
      diagnostics,
    );
    const recovery = strictRecord(
      manifest.recovery,
      ['retry', 'compensation'],
      'recovery',
      diagnostics,
    );
    const effects = effectsFrom(manifest.effects, diagnostics);
    const inputCompiled = compileCapabilitySchema(manifest.input_schema);
    const outputCompiled = compileCapabilitySchema(manifest.output_schema);
    if (!inputCompiled.ok)
      diagnostic(
        diagnostics,
        'invalid_schema',
        `input_schema: ${inputCompiled.diagnostic}`,
        'input_schema',
      );
    if (!outputCompiled.ok)
      diagnostic(
        diagnostics,
        'invalid_schema',
        `output_schema: ${outputCompiled.diagnostic}`,
        'output_schema',
      );

    const allowImplicit =
      invocation &&
      requiredBoolean(invocation.allow_implicit, 'invocation.allow_implicit', diagnostics);
    const allowManual =
      invocation &&
      requiredBoolean(invocation.allow_manual, 'invocation.allow_manual', diagnostics);
    const contextMode = context?.mode as 'inline' | 'fork' | undefined;
    if (contextMode !== 'inline' && contextMode !== 'fork')
      diagnostic(
        diagnostics,
        'invalid_field',
        'context.mode must be inline or fork.',
        'context.mode',
      );
    const agent = context && requiredString(context.agent, 'context.agent', diagnostics);
    const required = capabilities?.require;
    const denied = capabilities?.deny;
    const capabilitiesValid = [required, denied].every(
      (value) =>
        Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0),
    );
    if (!capabilitiesValid)
      diagnostic(
        diagnostics,
        'invalid_field',
        'capabilities.require and capabilities.deny must be string arrays.',
        'capabilities',
      );
    const minimum = approval?.minimum as CapabilityApproval | undefined;
    if (minimum !== 'none' && minimum !== 'auto_review' && minimum !== 'user')
      diagnostic(diagnostics, 'invalid_field', 'approval.minimum is invalid.', 'approval.minimum');
    const timeoutMs =
      execution && requiredPositiveInt(execution.timeout_ms, 'execution.timeout_ms', diagnostics);
    const maxAttempts =
      execution &&
      requiredPositiveInt(execution.max_attempts, 'execution.max_attempts', diagnostics);
    const verificationMode = verification?.mode;
    if (!['not_required', 'best_effort', 'required'].includes(String(verificationMode)))
      diagnostic(
        diagnostics,
        'invalid_field',
        'verification.mode is invalid.',
        'verification.mode',
      );
    const strategy = verification?.strategy as 'script' | undefined;
    if (strategy !== undefined && strategy !== 'script')
      diagnostic(
        diagnostics,
        'invalid_field',
        'verification.strategy is invalid.',
        'verification.strategy',
      );
    const entrypoint =
      typeof verification?.entrypoint === 'string' ? verification.entrypoint : undefined;
    if (strategy === 'script' && !entrypoint)
      diagnostic(
        diagnostics,
        'invalid_field',
        'Script verification requires verification.entrypoint.',
        'verification.entrypoint',
      );
    if (entrypoint)
      safeDeclaredPath(input.skillDir, entrypoint, 'verification.entrypoint', diagnostics);
    const verificationTimeout =
      verification?.timeout_ms === undefined
        ? undefined
        : requiredPositiveInt(verification.timeout_ms, 'verification.timeout_ms', diagnostics);
    const retry = recovery?.retry as SkillWorkflowContract['recovery']['retry'] | undefined;
    if (retry !== 'never' && retry !== 'safe_read' && retry !== 'idempotency_key')
      diagnostic(diagnostics, 'invalid_field', 'recovery.retry is invalid.', 'recovery.retry');
    const compensation =
      typeof recovery?.compensation === 'string' ? recovery.compensation : undefined;
    if (compensation)
      safeDeclaredPath(input.skillDir, compensation, 'recovery.compensation', diagnostics);
    const dependencyRevisions: Record<string, string> = {};
    if (Array.isArray(required))
      for (const capabilityId of required as string[]) {
        const dependency = input.resolveCapability?.(capabilityId);
        if (input.resolveCapability && !dependency)
          diagnostic(
            diagnostics,
            'missing_capability',
            `Required capability '${capabilityId}' is unavailable.`,
            'capabilities.require',
          );
        if (dependency) dependencyRevisions[capabilityId] = dependency.revision;
      }
    if (
      name &&
      version &&
      description &&
      instructions &&
      invocation &&
      allowImplicit !== undefined &&
      allowManual !== undefined &&
      contextMode &&
      agent &&
      capabilitiesValid &&
      effects &&
      minimum &&
      timeoutMs &&
      maxAttempts &&
      verificationMode &&
      retry &&
      inputCompiled.ok &&
      outputCompiled.ok
    ) {
      contract = {
        schemaVersion: SKILL_WORKFLOW_SCHEMA_VERSION,
        name,
        version,
        description,
        instructions,
        invocation: { allowImplicit, allowManual },
        context: { mode: contextMode, agent },
        inputSchema: inputCompiled.compiled.schema,
        outputSchema: outputCompiled.compiled.schema,
        capabilityCeiling: [...(required as string[])].sort(),
        deniedCapabilities: [...(denied as string[])].sort(),
        effects,
        minimumApproval: minimum,
        execution: { timeoutMs, maxAttempts },
        verification: {
          mode: verificationMode as SkillWorkflowContract['verification']['mode'],
          ...(strategy ? { strategy } : {}),
          ...(entrypoint ? { entrypoint } : {}),
          ...(verificationTimeout ? { timeoutMs: verificationTimeout } : {}),
        },
        recovery: { retry, ...(compensation ? { compensation } : {}) },
        files: files.map((file) => file.path),
        dependencyRevisions,
      };
      const highRisk = [effects.filesystem, effects.network, effects.externalState].some(
        (effect) => effect === 'write' || effect === 'destructive' || effect === 'unknown',
      );
      if (highRisk && allowImplicit)
        diagnostic(
          diagnostics,
          'invalid_field',
          'High-risk Skills must set invocation.allow_implicit to false.',
          'invocation.allow_implicit',
        );
    }
  }
  const revision = createHash('sha256')
    .update(
      JSON.stringify({
        files: files.map((file) => [file.path, file.content.toString('base64')]),
        contract: contract
          ? { ...contract, dependencyRevisions: contract.dependencyRevisions }
          : undefined,
      }),
    )
    .digest('hex');
  return {
    sourcePath: resolve(input.skillDir),
    source: input.source,
    origin: input.origin,
    contract,
    diagnostics,
    descriptor: buildDescriptor({
      sourcePath: resolve(input.skillDir),
      source: input.source,
      origin: input.origin,
      contract,
      diagnostics,
      revision,
    }),
  };
}
