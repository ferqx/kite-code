import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import standalone from 'ajv/dist/standalone';
import { z } from 'zod';
import { apiRoutes, apiSchemas } from '../apps/service/src/http/schema';

interface Schema {
  $ref?: string;
  $defs?: Record<string, Schema>;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
}
function type(schema: Schema, root: string): string {
  if (schema.$ref) {
    if (schema.$ref === '#') return root;
    if (schema.$ref.startsWith('#/$defs/'))
      return `${root}_${schema.$ref.slice(8).replaceAll(/[^A-Za-z0-9_]/g, '_')}`;
    throw new Error(`Unsupported schema reference ${schema.$ref}`);
  }
  if ('const' in schema) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  const union = schema.anyOf ?? schema.oneOf;
  if (union) return union.map((value) => `(${type(value, root)})`).join(' | ');
  if (schema.allOf) return schema.allOf.map((value) => `(${type(value, root)})`).join(' & ');
  if (Array.isArray(schema.type))
    return schema.type.map((value) => type({ ...schema, type: value }, root)).join(' | ');
  if (schema.type === 'null') return 'null';
  if (schema.type === 'string') return 'string';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'number' || schema.type === 'integer') return 'number';
  if (schema.type === 'array') return `Array<${type(schema.items ?? {}, root)}>`;
  if (schema.type === 'object') {
    const fields = Object.entries(schema.properties ?? {}).map(
      ([key, value]) =>
        `${JSON.stringify(key)}${schema.required?.includes(key) ? '' : '?'}: ${type(value, root)};`,
    );
    if (schema.additionalProperties !== false)
      fields.push(
        `[key: string]: ${typeof schema.additionalProperties === 'object' ? type(schema.additionalProperties, root) : 'unknown'};`,
      );
    return fields.length ? `{ ${fields.join(' ')} }` : 'Record<string, never>';
  }
  return 'unknown';
}

const schemas = Object.fromEntries(
  Object.entries(apiSchemas).map(([name, value]) => [name, z.toJSONSchema(value)]),
) as Record<string, Schema>;
// Schema selection only; all actual validation rules still come from the Service schema.
const responseNames = [
  'FileCheckpointPage',
  'FileCheckpointDetail',
  'FileRestoreStatus',
  'FileCheckpointRecoveryBoundary',
  'SessionLogPage',
  'SkillCataloguePage',
  'HostStatus',
  'ServiceLifecycle',
  'ShutdownServiceResponse',
  'ModelSettingsView',
  'ProviderSettingsView',
  'ConfigurationView',
  'HostMutation',
  'SessionExportManifest',
  'SessionExportPage',
  'SessionExportTextPage',
  'SessionExportCompletion',
  'WorkspaceDirectoryPage',
  'SessionDirectoryPage',
  'BrowserWorkspaceDirectoryPage',
  'PermissionModeState',
  'WorkspaceTrustState',
  'PermissionMutation',
  'PermissionGrantPage',
  'ModelInputPage',
  'ModelInputSnapshot',
  'ModelOutputSnapshot',
  'BrowserInfo',
  'BrowserWorkspaceList',
  'BrowserSessionList',
  'BrowserView',
  'SelectedContextPage',
  'SelectContextResponse',
  'ForkSessionResponse',
  'SessionMutationResponse',
  'IncludeResultResponse',
  'PendingInputPage',
  'Interaction',
  'InteractionPage',
  'ServerInfo',
  'Problem',
  'Workspace',
  'Session',
  'SessionView',
  'Command',
  'ResumeJobReportResponse',
  'JobReconcileCommand',
  'ResumeRunResponse',
  'RecoverSessionResponse',
  'Run',
  'Execution',
  'ExecutionOutputPage',
  'Message',
  'Change',
  'WorkspaceList',
  'SessionList',
  'MessageList',
  'StreamReady',
  'StreamCheckpoint',
  'ExtensionList',
  'QueryResponse',
];
const requestNames = [
  'FileCheckpointListQuery',
  'SessionLogQuery',
  'BrowserSessionLogQuery',
  'SkillCatalogueQuery',
  'HostStatusQuery',
  'ResumeRunRequest',
  'ResumeRunTarget',
  'RecoverSessionRequest',
  'RecoverSessionTarget',
  'ReconcileJobRequest',
  'ReconcileJobTarget',
  'ResumeJobReportRequest',
  'ResumeJobReportTarget',
  'ShutdownServiceRequest',
  'ModelSettingsRequest',
  'ProviderSettingsRequest',
  'ConfigurationReadQuery',
  'HostMutationQuery',
  'ConfigurationPatchRequest',
  'ConfigurationRepairRequest',
  'CredentialPutRequest',
  'CredentialRevokeRequest',
  'BeginSessionExportQuery',
  'SessionExportPageQuery',
  'SessionExportTextQuery',
  'VerifySessionExportQuery',
  'BrowserBeginSessionExportQuery',
  'BrowserSessionExportPageQuery',
  'BrowserSessionExportTextQuery',
  'BrowserVerifySessionExportQuery',
  'WorkspaceDirectoryQuery',
  'SessionDirectoryQuery',
  'BrowserWorkspaceDirectoryQuery',
  'BrowserSessionDirectoryQuery',
  'PermissionControlQuery',
  'SetPermissionModeRequest',
  'SetWorkspaceTrustRequest',
  'PermissionGrantQuery',
  'ClearPermissionGrantsRequest',
  'ModelInputQuery',
  'ModelOutputQuery',
  'BrowserModelInputQuery',
  'ContextQuery',
  'BrowserContextQuery',
  'SelectContextRequest',
  'ForkSessionRequest',
  'RenameSessionRequest',
  'DeleteSessionRequest',
  'CompressContextRequest',
  'ResetCompressionRequest',
  'IncludeResultRequest',
  'SteerCommandRequest',
  'FollowUpCommandRequest',
  'InputListQuery',
  'AnswerInteractionRequest',
  'InteractionListQuery',
  'CreateWorkspaceRequest',
  'CreateSessionRequest',
  'StartCommandRequest',
  'CancelCommandRequest',
  'CancelRunRequest',
  'CancelExecutionRequest',
  'CancelSessionRequest',
  'ExtensionCommandRequest',
];
function allowFutureFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(allowFutureFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === 'additionalProperties' && item === false ? true : allowFutureFields(item),
    ]),
  );
}
const validatorCompiler = new Ajv2020({
  strict: false,
  strictNumbers: true,
  allErrors: false,
  removeAdditional: false,
  code: { source: true, esm: true },
});
const validatorRefs: Record<string, string> = {};
for (const [prefix, names] of [
  ['response', responseNames],
  ['request', requestNames],
] as const) {
  for (const name of names) {
    const key = `${prefix}_${name}`;
    validatorCompiler.addSchema(
      (prefix === 'response' &&
      name !== 'HostStatus' &&
      name !== 'SkillCataloguePage' &&
      name !== 'SessionLogPage' &&
      name !== 'FileCheckpointPage' &&
      name !== 'FileCheckpointDetail' &&
      name !== 'FileRestoreStatus' &&
      name !== 'FileCheckpointRecoveryBoundary'
        ? allowFutureFields(schemas[name])
        : schemas[name]) as object,
      key,
    );
    validatorRefs[key] = key;
  }
}
const querySchema = schemas.ExtensionCommandRequest!;
validatorCompiler.addSchema(
  { ...querySchema.properties!.input, $defs: querySchema.$defs },
  'queryInput',
);
validatorRefs.queryInput = 'queryInput';
// Bundle only AJV's static runtime helpers; no AJV compiler or Function/eval enters the Client.
const validatorTemp = mkdtempSync(resolve('packages/client/.validator-build-'));
let validatorSource: string;
try {
  const entry = join(validatorTemp, 'index.js');
  const tables = [
    `export const responseValidators = {${responseNames.map((name) => `${name}:response_${name}`).join(',')}};`,
    `export const requestValidators = {${requestNames.map((name) => `${name}:request_${name}`).join(',')}};`,
  ].join('\n');
  writeFileSync(entry, `${standalone(validatorCompiler, validatorRefs)}\n${tables}\n`);
  const bundle = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm' });
  if (!bundle.success || bundle.outputs.length !== 1) throw new Error('Validator bundle failed');
  validatorSource = (await bundle.outputs[0]!.text()).replaceAll(
    basename(validatorTemp),
    'http-schema-validators',
  );
} finally {
  rmSync(validatorTemp, { recursive: true, force: true });
}
const validatorDeclarations = [
  ...Object.keys(validatorRefs).map(
    (name) => `export declare function ${name}(value: unknown): boolean;`,
  ),
  `export declare const responseValidators: {${responseNames.map((name) => `${name}:(value:unknown)=>boolean;`).join('')}};`,
  `export declare const requestValidators: {${requestNames.map((name) => `${name}:(value:unknown)=>boolean;`).join('')}};`,
].join('\n');
let declarations =
  '// Generated from apps/service/src/http/schema. Run bun run generate:unified-api.\n';
for (const [name, schema] of Object.entries(schemas)) {
  for (const [definition, value] of Object.entries(schema.$defs ?? {}))
    declarations += `type ${name}_${definition.replaceAll(/[^A-Za-z0-9_]/g, '_')} = ${type(value, name)};\n`;
  declarations += `export type ${name} = ${type(schema, name)};\n`;
}
const formatted = Bun.spawnSync(
  ['./node_modules/.bin/biome', 'format', '--stdin-file-path=api.ts'],
  { stdin: new TextEncoder().encode(declarations), stdout: 'pipe', stderr: 'pipe' },
);
if (formatted.exitCode !== 0) throw new Error(formatted.stderr.toString());
declarations = formatted.stdout.toString();
function openApiReferences(value: unknown, name: string): unknown {
  if (Array.isArray(value)) return value.map((item) => openApiReferences(item, name));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === '$ref' && typeof item === 'string' && item.startsWith('#')
          ? `#/components/schemas/${name}${item.slice(1)}`
          : openApiReferences(item, name),
      ]),
    );
  return value;
}
const paths: Record<string, object> = {};
for (const route of apiRoutes)
  paths[route.path] = {
    ...(paths[route.path] ?? {}),
    [route.method]: {
      parameters: [
        ...[...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
          name: match[1],
          in: 'path',
          required: true,
          schema: { type: 'string' },
        })),
        ...('query' in route
          ? Object.entries(schemas[route.query]!.properties!).map(([name, schema]) => ({
              name,
              in: 'query',
              required: schemas[route.query]!.required?.includes(name) ?? false,
              schema,
            }))
          : []),
      ],
      ...('request' in route
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: { $ref: `#/components/schemas/${route.request}` } },
              },
            },
          }
        : {}),
      responses: Object.fromEntries(
        ('statuses' in route ? route.statuses : [200]).map((status) => [
          String(status),
          {
            description:
              status === 202
                ? 'Accepted intent; query its receipt and execution for the final result'
                : 'Committed public facts',
            content:
              'binary' in route && route.binary
                ? { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } }
                : 'eventStream' in route && route.eventStream
                  ? {
                      'text/event-stream': {
                        schema: {
                          type: 'string',
                          description:
                            'Authenticated SSE frames; data uses the public Event schema.',
                        },
                      },
                    }
                  : {
                      'application/json': {
                        schema: { $ref: `#/components/schemas/${route.response}` },
                      },
                    },
          },
        ]),
      ),
    },
  };
const outputs = {
  'packages/client/src/generated/api.ts': declarations,
  'packages/client/src/generated/schema.json': `${JSON.stringify(schemas, null, 2)}\n`,
  'packages/client/src/generated/validators.js': `// Generated from apps/service/src/http/schema. No runtime code generation.\n${validatorSource}`,
  'packages/client/src/generated/validators.d.ts': `// Generated from apps/service/src/http/schema.\n${validatorDeclarations}\n`,
  'apps/service/generated/openapi.json': `${JSON.stringify({ openapi: '3.1.0', info: { title: 'Kite Agent API', version: '1.0.0' }, paths, components: { schemas: Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, openApiReferences(schema, name)])) } }, null, 2)}\n`,
};
for (const [path, source] of Object.entries(outputs)) {
  const formatted = Bun.spawnSync(
    [
      './node_modules/.bin/biome',
      'format',
      `--files-max-size=${Math.max(1048576, Buffer.byteLength(source) + 1)}`,
      `--stdin-file-path=${path}`,
    ],
    { stdin: new TextEncoder().encode(source), stdout: 'pipe', stderr: 'pipe' },
  );
  if (formatted.exitCode !== 0) throw new Error(formatted.stderr.toString());
  const content = formatted.stdout.toString();
  if (!content.trim()) throw new Error(`Generated API output is empty: ${path}`);
  const destination = resolve(path);
  if (process.argv.includes('--check')) {
    if (readFileSync(destination, 'utf8') !== content)
      throw new Error(`Generated API drift: ${path}`);
  } else {
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
}
