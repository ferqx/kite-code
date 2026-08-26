import {
  arrayValue,
  type ExactJsonCodec,
  enumValue,
  exactCodec,
  exactObject,
  invalid,
  type JsonObject,
  nonEmptyString,
  optional,
  required,
  safeIdentifier,
  stringValue,
} from './validation';
import { decodeWorkspaceIdentity, type KiteWorkspaceIdentity } from './workspace-trust';

export const SKILL_CATALOG_REQUEST_SCHEMA_ = 'kite.app.skill-catalog.request.v1' as const;
export const SKILL_CATALOG_RESPONSE_SCHEMA_ = 'kite.app.skill-catalog.response.v1' as const;

export type AppSkillSource = 'project' | 'user';
export type AppSkillOrigin = '.kite-code' | '.agents';
export type AppSkillStatus = 'available' | 'invalid' | 'disabled';

export interface AppSkillSummary {
  readonly name: string;
  readonly description: string;
  readonly source: AppSkillSource;
  readonly origin: AppSkillOrigin;
  readonly status: AppSkillStatus;
  readonly diagnosticCode?: string;
}

export interface SkillCatalogRequest {
  readonly schema: typeof SKILL_CATALOG_REQUEST_SCHEMA_;
  readonly workspace: KiteWorkspaceIdentity;
}

export interface SkillCatalogSnapshot {
  readonly schema: typeof SKILL_CATALOG_RESPONSE_SCHEMA_;
  readonly workspace: KiteWorkspaceIdentity;
  readonly revision: string;
  readonly skills: readonly AppSkillSummary[];
}

export const skillCatalogRequestCodec: ExactJsonCodec<SkillCatalogRequest> = exactCodec({
  schema: SKILL_CATALOG_REQUEST_SCHEMA_,
  decode: decodeSkillCatalogRequest,
  encode: encodeSkillCatalogRequest,
});

export const skillCatalogResponseCodec: ExactJsonCodec<SkillCatalogSnapshot> = exactCodec({
  schema: SKILL_CATALOG_RESPONSE_SCHEMA_,
  decode: decodeSkillCatalogSnapshot,
  encode: encodeSkillCatalogSnapshot,
});

function decodeSkillCatalogRequest(input: unknown): SkillCatalogRequest {
  const value = exactObject(input, ['schema', 'workspace'], 'SkillCatalogRequest');
  assertSchema(value, SKILL_CATALOG_REQUEST_SCHEMA_, 'SkillCatalogRequest');
  return {
    schema: SKILL_CATALOG_REQUEST_SCHEMA_,
    workspace: decodeWorkspaceIdentity(required(value, 'workspace', 'SkillCatalogRequest')),
  };
}

function encodeSkillCatalogRequest(value: SkillCatalogRequest): JsonObject {
  return { schema: value.schema, workspace: encodeWorkspace(value.workspace) };
}

function decodeSkillCatalogSnapshot(input: unknown): SkillCatalogSnapshot {
  const value = exactObject(
    input,
    ['revision', 'schema', 'skills', 'workspace'],
    'SkillCatalogSnapshot',
  );
  assertSchema(value, SKILL_CATALOG_RESPONSE_SCHEMA_, 'SkillCatalogSnapshot');
  return {
    schema: SKILL_CATALOG_RESPONSE_SCHEMA_,
    workspace: decodeWorkspaceIdentity(required(value, 'workspace', 'SkillCatalogSnapshot')),
    revision: nonEmptyString(
      required(value, 'revision', 'SkillCatalogSnapshot'),
      'SkillCatalogSnapshot.revision',
      256,
    ),
    skills: arrayValue(
      required(value, 'skills', 'SkillCatalogSnapshot'),
      'SkillCatalogSnapshot.skills',
      (entry, index) => decodeSkillSummary(entry, `SkillCatalogSnapshot.skills[${index}]`),
      512,
    ),
  };
}

function encodeSkillCatalogSnapshot(value: SkillCatalogSnapshot): JsonObject {
  return {
    schema: value.schema,
    workspace: encodeWorkspace(value.workspace),
    revision: value.revision,
    skills: value.skills.map(encodeSkillSummary),
  };
}

function decodeSkillSummary(input: unknown, label: string): AppSkillSummary {
  const value = exactObject(
    input,
    ['description', 'diagnosticCode', 'name', 'origin', 'source', 'status'],
    label,
  );
  const diagnosticCode = optional(value, 'diagnosticCode');
  return {
    name: safeIdentifier(required(value, 'name', label), `${label}.name`, 256),
    description: stringValue(required(value, 'description', label), `${label}.description`, {
      max: 8_192,
    }),
    source: enumValue(required(value, 'source', label), `${label}.source`, [
      'project',
      'user',
    ] as const),
    origin: enumValue(required(value, 'origin', label), `${label}.origin`, [
      '.kite-code',
      '.agents',
    ] as const),
    status: enumValue(required(value, 'status', label), `${label}.status`, [
      'available',
      'invalid',
      'disabled',
    ] as const),
    ...(diagnosticCode === undefined
      ? {}
      : { diagnosticCode: safeIdentifier(diagnosticCode, `${label}.diagnosticCode`, 128) }),
  };
}

function encodeSkillSummary(value: AppSkillSummary): JsonObject {
  return {
    name: value.name,
    description: value.description,
    source: value.source,
    origin: value.origin,
    status: value.status,
    ...(value.diagnosticCode === undefined ? {} : { diagnosticCode: value.diagnosticCode }),
  };
}

function encodeWorkspace(value: KiteWorkspaceIdentity): JsonObject {
  return {
    canonicalPath: value.canonicalPath,
    projectId: value.projectId,
    workspaceDigest: value.workspaceDigest,
  };
}

function assertSchema(value: JsonObject, expected: string, label: string): void {
  if (value.schema !== expected) invalid(`${label}.schema must equal ${expected}.`);
}
