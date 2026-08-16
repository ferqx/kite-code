import { createHash } from 'node:crypto';
import {
  type CanonicalJsonObjectV1,
  type CanonicalModelMessageV1,
  type CanonicalProviderOptionsV1,
  type CanonicalToolDeclarationV1,
  MODEL_INVOCATION_PURPOSES_V1,
  MODEL_SURFACE_SCHEMA_V1,
  type ModelAdapterReplayOwnerV1,
  type ModelRouteIdentityV1,
  type ModelSurfaceV1,
  type ResolvedModelCapabilitiesValueV1,
  type Sha256DigestV1,
} from '@/protocol/model-surface';

const UTF8_ENCODER = new TextEncoder();
const PRIVATE_MODEL_DIGEST_PREFIX = 'kite-code-private-model-evidence-v1\0';
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_ROUTE_KIND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const ENDPOINT_LIKE_ROUTE_PATTERN =
  /^(?:(?:[a-z0-9-]+\.)+[a-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/|$)/iu;

const MODEL_SURFACE_DIGEST_DOMAIN_V1 = 'kite.model-surface.v1';
const MODEL_ROUTE_DIGEST_DOMAIN_V1 = 'kite.model-route-identity.v1';
const MODEL_CAPABILITY_DIGEST_DOMAIN_V1 = 'kite.model-resolved-capabilities.v1';
const MODEL_PROVIDER_OPTIONS_DIGEST_DOMAIN_V1 = 'kite.model-provider-options.v1';

const FORBIDDEN_PROVIDER_OPTION_KEYS = new Set([
  'authorization',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'credential',
  'credentials',
  'password',
  'secret',
  'baseurl',
  'endpoint',
  'url',
  'header',
  'headers',
  'host',
  'hostname',
  'origin',
  'proxy',
  'dsn',
  'cookie',
]);

const SECRET_BEARING_VALUE_PATTERNS = [
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]+=*/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|credential)\s*[:=]/iu,
  /\b(?:sk-(?:proj-)?|ghp_|github_pat_)[A-Za-z0-9_=-]{16,}\b/u,
  /\b(?:auth|bearer|api[_-]?token|token|secret|key)\s*[:=]\s*\S+/iu,
  /(?:^|\s)[a-z][a-z0-9+.-]*:\/\//iu,
] as const;

export interface ModelSurfaceDigestLayersV1 {
  routeIdentityDigest: Sha256DigestV1;
  resolvedCapabilitiesDigest: Sha256DigestV1;
  providerOptionsDigest: Sha256DigestV1;
  surfaceDigest: Sha256DigestV1;
}

export class ModelSurfaceCanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelSurfaceCanonicalizationError';
  }
}

/**
 * Strict RFC 8785-like canonicalization for private model evidence.
 *
 * Arrays retain their semantic order. Objects are ordered by UTF-16 code units.
 * Values outside the JSON data model fail closed rather than being omitted.
 */
export function canonicalModelJsonV1(value: unknown): string {
  return serializeCanonical(value, new Set<object>(), '$');
}

export function canonicalModelJsonBytesV1(value: unknown): Uint8Array {
  return UTF8_ENCODER.encode(canonicalModelJsonV1(value));
}

export function computeResolvedModelCapabilitiesDigestV1(
  value: ResolvedModelCapabilitiesValueV1,
): Sha256DigestV1 {
  const canonicalBytes = canonicalModelJsonBytesV1(value);
  assertResolvedCapabilities(value, '$');
  return digestPrivateModelEvidence(MODEL_CAPABILITY_DIGEST_DOMAIN_V1, canonicalBytes);
}

export function computeCanonicalProviderOptionsDigestV1(
  value: CanonicalJsonObjectV1,
): Sha256DigestV1 {
  const canonicalBytes = canonicalModelJsonBytesV1(value);
  assertObject(value, '$.providerOptions');
  assertNoSecretBearingOptionKeys(value);
  return digestPrivateModelEvidence(MODEL_PROVIDER_OPTIONS_DIGEST_DOMAIN_V1, canonicalBytes);
}

export function computeModelRouteIdentityDigestV1(route: ModelRouteIdentityV1): Sha256DigestV1 {
  const canonicalBytes = canonicalModelJsonBytesV1(route);
  assertRoute(route, '$');
  return digestPrivateModelEvidence(MODEL_ROUTE_DIGEST_DOMAIN_V1, canonicalBytes);
}

export function computeModelSurfaceDigestV1(surface: ModelSurfaceV1): Sha256DigestV1 {
  canonicalModelJsonV1(surface);
  assertModelSurfaceV1(surface);
  const canonicalBytes = canonicalModelJsonBytesV1(modelSurfaceDigestMaterial(surface));
  return digestPrivateModelEvidence(MODEL_SURFACE_DIGEST_DOMAIN_V1, canonicalBytes);
}

export function computeModelSurfaceDigestLayersV1(
  surface: ModelSurfaceV1,
): ModelSurfaceDigestLayersV1 {
  const routeIdentityDigest = computeModelRouteIdentityDigestV1(surface.route);
  const resolvedCapabilitiesDigest = computeResolvedModelCapabilitiesDigestV1(
    surface.request.resolvedCapabilities.value,
  );
  const providerOptionsIdentityDigest = providerOptionsDigest(surface.request.providerOptions);
  const surfaceDigest = computeModelSurfaceDigestV1(surface);
  return {
    routeIdentityDigest,
    resolvedCapabilitiesDigest,
    providerOptionsDigest: providerOptionsIdentityDigest,
    surfaceDigest,
  };
}

/** Runtime validation rejects extra fields even when callers bypass TypeScript. */
export function assertModelSurfaceV1(surface: ModelSurfaceV1): void {
  assertExactKeys(surface, ['schema', 'purpose', 'route', 'request'], '$');
  assertExactKeys(
    surface.schema,
    ['name', 'canonicalizerVersion', 'surfaceFormatVersion'],
    '$.schema',
  );
  if (
    surface.schema.name !== MODEL_SURFACE_SCHEMA_V1.name ||
    surface.schema.canonicalizerVersion !== MODEL_SURFACE_SCHEMA_V1.canonicalizerVersion ||
    surface.schema.surfaceFormatVersion !== MODEL_SURFACE_SCHEMA_V1.surfaceFormatVersion
  ) {
    fail('Model Surface schema identity is unsupported.');
  }
  if (!MODEL_INVOCATION_PURPOSES_V1.includes(surface.purpose)) {
    fail('Model Surface purpose is unsupported.');
  }
  assertRoute(surface.route, '$.route');
  assertSemanticRequest(surface.request);
}

export function assertCanonicalModelMessageV1(
  message: unknown,
): asserts message is CanonicalModelMessageV1 {
  canonicalModelJsonV1(message);
  assertMessage(message as CanonicalModelMessageV1, '$');
}

export function assertModelRouteIdentityV1(route: unknown): asserts route is ModelRouteIdentityV1 {
  canonicalModelJsonV1(route);
  assertRoute(route as ModelRouteIdentityV1, '$');
}

export function assertModelAdapterReplayOwnerV1(
  owner: unknown,
): asserts owner is ModelAdapterReplayOwnerV1 {
  canonicalModelJsonV1(owner);
  assertReplayOwner(owner as ModelAdapterReplayOwnerV1, '$');
}

function assertSemanticRequest(request: ModelSurfaceV1['request']): void {
  assertExactKeys(
    request,
    [
      'system',
      'messages',
      'tools',
      'temperature',
      'maxOutputTokens',
      'stopPolicy',
      'transport',
      'sdkRetry',
      'resolvedCapabilities',
      'providerOptions',
    ],
    '$.request',
  );
  assertString(request.system, '$.request.system');
  if (!Array.isArray(request.messages)) fail('Model Surface messages must be an array.');
  for (const [index, message] of request.messages.entries()) {
    assertMessage(message, `$.request.messages[${index}]`);
  }
  if (!Array.isArray(request.tools)) fail('Model Surface tools must be an array.');
  for (const [index, tool] of request.tools.entries()) {
    assertTool(tool, `$.request.tools[${index}]`);
  }
  assertFiniteNumber(request.temperature, '$.request.temperature');
  if (request.maxOutputTokens !== null) {
    assertPositiveInteger(request.maxOutputTokens, '$.request.maxOutputTokens');
  }
  assertExactKeys(request.stopPolicy, ['kind', 'maxSteps'], '$.request.stopPolicy');
  if (request.stopPolicy.kind !== 'single_step' || request.stopPolicy.maxSteps !== 1) {
    fail('Model Surface stop policy must be single-step.');
  }
  if (request.transport !== 'stream' && request.transport !== 'generate') {
    fail('Model Surface transport is unsupported.');
  }
  assertExactKeys(request.sdkRetry, ['maxRetries'], '$.request.sdkRetry');
  if (request.sdkRetry.maxRetries !== 0) {
    fail('Model SDK retries must remain disabled.');
  }
  assertExactKeys(
    request.resolvedCapabilities,
    ['value', 'digest'],
    '$.request.resolvedCapabilities',
  );
  assertResolvedCapabilities(
    request.resolvedCapabilities.value,
    '$.request.resolvedCapabilities.value',
  );
  assertDigest(request.resolvedCapabilities.digest, '$.request.resolvedCapabilities.digest');
  const expectedCapabilityDigest = computeResolvedModelCapabilitiesDigestV1(
    request.resolvedCapabilities.value,
  );
  if (request.resolvedCapabilities.digest !== expectedCapabilityDigest) {
    fail('Resolved model capability digest does not match its canonical value.');
  }
  assertProviderOptions(request.providerOptions);
}

function assertRoute(route: ModelRouteIdentityV1, path: string): void {
  assertExactKeys(
    route,
    ['providerKind', 'modelName', 'adapterProtocolVersion', 'routeFingerprint', 'replayOwner'],
    path,
  );
  assertRouteKind(route.providerKind, `${path}.providerKind`);
  assertModelName(route.modelName, `${path}.modelName`);
  assertRouteKind(route.adapterProtocolVersion, `${path}.adapterProtocolVersion`);
  assertDigest(route.routeFingerprint, `${path}.routeFingerprint`);
  assertReplayOwner(route.replayOwner, `${path}.replayOwner`);
}

function assertReplayOwner(owner: ModelAdapterReplayOwnerV1, path: string): void {
  assertExactKeys(owner, ['adapterKind', 'adapterProtocolVersion', 'ownerFingerprint'], path);
  assertRouteKind(owner.adapterKind, `${path}.adapterKind`);
  assertRouteKind(owner.adapterProtocolVersion, `${path}.adapterProtocolVersion`);
  assertDigest(owner.ownerFingerprint, `${path}.ownerFingerprint`);
}

function assertMessage(message: CanonicalModelMessageV1, path: string): void {
  assertExactKeys(message, ['role', 'content'], path);
  if (!Array.isArray(message.content)) fail('Canonical model message content must be an array.');
  if (message.role === 'user') {
    for (const [index, part] of message.content.entries()) {
      assertTextPart(part, `${path}.content[${index}]`);
    }
    return;
  }
  if (message.role === 'assistant') {
    for (const [index, part] of message.content.entries()) {
      const partPath = `${path}.content[${index}]`;
      assertObject(part, partPath);
      if (part.type === 'text') assertTextPart(part, partPath);
      else if (part.type === 'reasoning') assertReasoningPart(part, partPath);
      else if (part.type === 'tool_call') assertToolCallPart(part, partPath);
      else fail('Canonical assistant message contains an unsupported part.');
    }
    return;
  }
  if (message.role === 'tool') {
    for (const [index, part] of message.content.entries()) {
      assertToolResultPart(part, `${path}.content[${index}]`);
    }
    return;
  }
  fail('Canonical model message role is unsupported.');
}

function assertTextPart(part: unknown, path: string): void {
  assertExactKeys(part, ['type', 'text'], path);
  const record = part as Record<string, unknown>;
  if (record.type !== 'text') fail('Canonical user message contains a non-text part.');
  assertString(record.text, `${path}.text`);
}

function assertReasoningPart(part: unknown, path: string): void {
  assertExactKeys(part, ['type', 'text'], path);
  const record = part as Record<string, unknown>;
  if (record.type !== 'reasoning') fail('Canonical reasoning part is invalid.');
  assertString(record.text, `${path}.text`);
}

function assertToolCallPart(part: unknown, path: string): void {
  assertExactKeys(part, ['type', 'toolCallId', 'toolName', 'input'], path);
  const record = part as Record<string, unknown>;
  if (record.type !== 'tool_call') fail('Canonical tool call part is invalid.');
  assertBoundedString(record.toolCallId, `${path}.toolCallId`);
  assertBoundedString(record.toolName, `${path}.toolName`);
  canonicalModelJsonV1(record.input);
}

function assertToolResultPart(part: unknown, path: string): void {
  assertExactKeys(part, ['type', 'toolCallId', 'toolName', 'output'], path);
  const record = part as Record<string, unknown>;
  if (record.type !== 'tool_result') fail('Canonical tool result part is invalid.');
  assertBoundedString(record.toolCallId, `${path}.toolCallId`);
  assertBoundedString(record.toolName, `${path}.toolName`);
  assertExactKeys(record.output, ['type', 'value'], `${path}.output`);
  const output = record.output as Record<string, unknown>;
  if (output.type !== 'text') fail('Canonical tool result output is unsupported.');
  assertString(output.value, `${path}.output.value`);
}

function assertTool(tool: CanonicalToolDeclarationV1, path: string): void {
  assertExactKeys(tool, ['name', 'description', 'inputSchema'], path);
  assertBoundedString(tool.name, `${path}.name`);
  if (tool.description !== null) assertString(tool.description, `${path}.description`);
  assertObject(tool.inputSchema, `${path}.inputSchema`);
  canonicalModelJsonV1(tool.inputSchema);
}

function assertResolvedCapabilities(value: ResolvedModelCapabilitiesValueV1, path: string): void {
  assertExactKeys(
    value,
    [
      'providerName',
      'modelName',
      'contextWindowTokens',
      'contextWindowSource',
      'maxOutputTokens',
      'maxOutputTokensSource',
      'tokenizerFamily',
      'tokenizerSource',
      'supportsUsageMetadata',
      'supportsUsageMetadataSource',
      'supportsPromptCache',
      'supportsPromptCacheSource',
      'supportsToolCalls',
      'supportsToolCallsSource',
      'streaming',
      'streamingSource',
    ],
    path,
  );
  assertBoundedString(value.providerName, `${path}.providerName`);
  assertBoundedString(value.modelName, `${path}.modelName`);
  assertNullablePositiveInteger(value.contextWindowTokens, `${path}.contextWindowTokens`);
  assertCapabilitySource(value.contextWindowSource, `${path}.contextWindowSource`);
  assertNullablePositiveInteger(value.maxOutputTokens, `${path}.maxOutputTokens`);
  assertCapabilitySource(value.maxOutputTokensSource, `${path}.maxOutputTokensSource`);
  if (value.tokenizerFamily !== null) {
    assertBoundedString(value.tokenizerFamily, `${path}.tokenizerFamily`);
  }
  assertCapabilitySource(value.tokenizerSource, `${path}.tokenizerSource`);
  assertNullableBoolean(value.supportsUsageMetadata, `${path}.supportsUsageMetadata`);
  assertCapabilitySource(value.supportsUsageMetadataSource, `${path}.supportsUsageMetadataSource`);
  assertNullableBoolean(value.supportsPromptCache, `${path}.supportsPromptCache`);
  assertCapabilitySource(value.supportsPromptCacheSource, `${path}.supportsPromptCacheSource`);
  assertNullableBoolean(value.supportsToolCalls, `${path}.supportsToolCalls`);
  assertCapabilitySource(value.supportsToolCallsSource, `${path}.supportsToolCallsSource`);
  if (typeof value.streaming !== 'boolean') fail(`${path}.streaming must be a boolean.`);
  assertCapabilitySource(value.streamingSource, `${path}.streamingSource`);
}

function assertProviderOptions(options: CanonicalProviderOptionsV1): void {
  assertObject(options, '$.request.providerOptions');
  if (options.kind === 'inline') {
    assertExactKeys(options, ['kind', 'value', 'digest'], '$.request.providerOptions');
    assertDigest(options.digest, '$.request.providerOptions.digest');
    const expected = computeCanonicalProviderOptionsDigestV1(options.value);
    if (options.digest !== expected) {
      fail('Provider options digest does not match its canonical value.');
    }
    return;
  }
  if (options.kind === 'artifact') {
    assertExactKeys(options, ['kind', 'artifact', 'contentDigest'], '$.request.providerOptions');
    assertPrivateArtifactRef(
      options.artifact,
      'provider_options',
      '$.request.providerOptions.artifact',
    );
    assertDigest(options.contentDigest, '$.request.providerOptions.contentDigest');
    return;
  }
  fail('Provider options representation is unsupported.');
}

function providerOptionsDigest(options: CanonicalProviderOptionsV1): Sha256DigestV1 {
  assertObject(options, '$.request.providerOptions');
  if (options.kind === 'inline') return computeCanonicalProviderOptionsDigestV1(options.value);
  assertDigest(options.contentDigest, '$.request.providerOptions.contentDigest');
  return options.contentDigest;
}

function modelSurfaceDigestMaterial(surface: ModelSurfaceV1): unknown {
  return {
    schema: surface.schema,
    purpose: surface.purpose,
    route: surface.route,
    request: {
      ...surface.request,
      providerOptions: {
        contentDigest: providerOptionsDigest(surface.request.providerOptions),
      },
    },
  };
}

function assertPrivateArtifactRef(
  artifact: {
    artifactId: string;
    kind: string;
    integrityIdentifier: string;
    byteLength: number;
  },
  expectedKind: string,
  path: string,
): void {
  assertExactKeys(artifact, ['artifactId', 'kind', 'integrityIdentifier', 'byteLength'], path);
  assertSafeIdentifier(artifact.artifactId, `${path}.artifactId`);
  if (artifact.kind !== expectedKind) fail('Private artifact kind does not match its use.');
  assertSafeIdentifier(artifact.integrityIdentifier, `${path}.integrityIdentifier`);
  if (!Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 0) {
    fail(`${path}.byteLength must be a non-negative safe integer.`);
  }
}

function assertNoSecretBearingOptionKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertNoSecretBearingOptionKeys(entry);
    return;
  }
  if (typeof value === 'string') {
    if (containsCredentialOrEndpointMaterial(value)) {
      fail('Provider options contain credential- or endpoint-bearing material.');
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll('-', '').replaceAll('_', '');
    if (isForbiddenProviderOptionKey(normalized)) {
      fail('Provider options contain a credential- or endpoint-bearing field.');
    }
    assertNoSecretBearingOptionKeys(entry);
  }
}

function isForbiddenProviderOptionKey(normalized: string): boolean {
  return (
    FORBIDDEN_PROVIDER_OPTION_KEYS.has(normalized) ||
    normalized.includes('authorization') ||
    normalized.includes('authentication') ||
    normalized === 'auth' ||
    normalized.startsWith('auth') ||
    normalized.includes('bearer') ||
    normalized.includes('credential') ||
    normalized.includes('password') ||
    normalized.includes('secret') ||
    normalized.includes('apikey') ||
    (normalized.endsWith('token') && !normalized.endsWith('tokens')) ||
    normalized.includes('header') ||
    normalized.includes('baseurl') ||
    normalized.endsWith('url') ||
    normalized.includes('endpoint') ||
    normalized.includes('hostname') ||
    normalized.endsWith('host') ||
    normalized.includes('origin') ||
    normalized.includes('proxy') ||
    normalized.endsWith('dsn') ||
    normalized.includes('cookie')
  );
}

function containsCredentialOrEndpointMaterial(value: string): boolean {
  return (
    ENDPOINT_LIKE_ROUTE_PATTERN.test(value.trim()) ||
    SECRET_BEARING_VALUE_PATTERNS.some((pattern) => pattern.test(value))
  );
}

function assertExactKeys(value: unknown, expected: readonly string[], path: string): void {
  assertObject(value, path);
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    fail(`${path} contains unsupported or missing fields.`);
  }
}

function assertObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} must be an object.`);
  }
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string') fail(`${path} must be a string.`);
  assertValidUnicode(value, path);
}

function assertBoundedString(value: unknown, path: string): asserts value is string {
  assertString(value, path);
  if (value.length === 0 || value.length > 512 || hasControlCharacter(value)) {
    fail(`${path} must be a non-empty bounded string without control characters.`);
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function assertSafeIdentifier(value: unknown, path: string): asserts value is string {
  assertString(value, path);
  if (!SAFE_IDENTIFIER_PATTERN.test(value)) fail(`${path} must be a safe identifier.`);
}

function assertRouteKind(value: unknown, path: string): asserts value is string {
  assertString(value, path);
  if (!SAFE_ROUTE_KIND_PATTERN.test(value)) fail(`${path} must be a safe route identifier.`);
}

function assertModelName(value: unknown, path: string): asserts value is string {
  assertString(value, path);
  if (
    !SAFE_MODEL_NAME_PATTERN.test(value) ||
    value.includes('://') ||
    value.includes('?') ||
    value.includes('#') ||
    ENDPOINT_LIKE_ROUTE_PATTERN.test(value) ||
    containsCredentialOrEndpointMaterial(value)
  ) {
    fail(`${path} must be a secret-free model identifier.`);
  }
}

function assertDigest(value: unknown, path: string): asserts value is Sha256DigestV1 {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(`${path} must be a sha256 digest.`);
  }
}

function assertFiniteNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${path} must be a finite number.`);
  }
}

function assertPositiveInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(`${path} must be a positive safe integer.`);
  }
}

function assertNullablePositiveInteger(value: unknown, path: string): void {
  if (value !== null) assertPositiveInteger(value, path);
}

function assertNullableBoolean(value: unknown, path: string): void {
  if (value !== null && typeof value !== 'boolean') fail(`${path} must be boolean or null.`);
}

function assertCapabilitySource(value: unknown, path: string): void {
  if (
    value !== null &&
    value !== 'explicit_config' &&
    value !== 'adapter_runtime' &&
    value !== 'compatibility_config'
  ) {
    fail(`${path} is not a supported capability source.`);
  }
}

function digestPrivateModelEvidence(domain: string, input: Uint8Array): Sha256DigestV1 {
  if (!domain || domain.includes('\0')) fail('Model evidence digest domain is invalid.');
  const hash = createHash('sha256');
  hash.update(PRIVATE_MODEL_DIGEST_PREFIX);
  hash.update(domain);
  hash.update('\0');
  hash.update(input);
  return `sha256:${hash.digest('hex')}`;
}

function serializeCanonical(value: unknown, ancestors: Set<object>, path: string): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    assertValidUnicode(value, path);
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} contains a non-finite number.`);
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    fail(`${path} contains a non-JSON ${typeof value} value.`);
  }
  if (ancestors.has(value)) fail(`${path} contains a circular reference.`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return serializeArray(value, ancestors, path);

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(`${path} must be a plain JSON object.`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      fail(`${path} contains symbol keys.`);
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort(compareUtf16CodeUnits);
    const entries = keys.map((key) => {
      assertValidUnicode(key, `${path} key`);
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) fail(`${path} contains an accessor.`);
      if (!descriptor.enumerable) fail(`${path} contains a non-enumerable field.`);
      return `${JSON.stringify(key)}:${serializeCanonical(descriptor.value, ancestors, `${path}.${key}`)}`;
    });
    return `{${entries.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function serializeArray(value: unknown[], ancestors: Set<object>, path: string): string {
  if (Object.getOwnPropertySymbols(value).length > 0) fail(`${path} contains symbol keys.`);
  const allowedKeys = new Set(['length']);
  for (let index = 0; index < value.length; index += 1) allowedKeys.add(String(index));
  if (Object.getOwnPropertyNames(value).some((key) => !allowedKeys.has(key))) {
    fail(`${path} contains non-JSON array properties.`);
  }
  const entries: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor) fail(`${path}[${index}] is a sparse array entry.`);
    if (!descriptor.enumerable || !('value' in descriptor)) {
      fail(`${path}[${index}] must be an enumerable data value.`);
    }
    entries.push(serializeCanonical(descriptor.value, ancestors, `${path}[${index}]`));
  }
  return `[${entries.join(',')}]`;
}

function assertValidUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail(`${path} contains a lone high surrogate.`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail(`${path} contains a lone low surrogate.`);
    }
  }
}

function compareUtf16CodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function fail(message: string): never {
  throw new ModelSurfaceCanonicalizationError(message);
}
