import { Database } from 'bun:sqlite';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { RUNTIME_STATE_FORMAT_EPOCH, RUNTIME_STATE_SCHEMA_VERSION } from '@kite/agent-kernel';
import {
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjection,
} from '@kite/builtin-runtime';
import { createRuntimeHostStateStorageBinding } from '@kite/runtime-host';
import { createRuntimeModuleRegistry } from '@kite/runtime-spi';
import {
  createSqliteRuntimeStorage,
  createSqliteRuntimeStorageBoundary,
} from '@kite/runtime-storage-sqlite';
import ts from 'typescript';
import {
  canonicalJsonBytes,
  parseStrictJson,
  sha256Digest,
  sha256DomainSeparated,
} from '../release/canonical-json';

export const RUNTIME_MODULARIZATION_MANIFEST_FORMAT =
  'kite.runtime-modularization-manifest.v1' as const;
export const RUNTIME_MODULARIZATION_GENERATOR_REVISION =
  'runtime-modularization-generator-current' as const;
const RUNTIME_MODULARIZATION_GENERATOR_SOURCE =
  'scripts/runtime-modularization/manifest-generator.ts' as const;

const BUILTIN_RUNTIME_MODULES_ = Object.freeze(createBuiltinRuntimeModules());
const BUILTIN_RUNTIME_REGISTRY_ = createRuntimeModuleRegistry(BUILTIN_RUNTIME_MODULES_);
const BUILTIN_REGISTRY_SNAPSHOT_ = BUILTIN_RUNTIME_REGISTRY_.snapshot();
const BUILTIN_CATALOG_SNAPSHOT_ = createBuiltinToolCatalogProjection(BUILTIN_REGISTRY_SNAPSHOT_);

export interface RuntimeModularizationBuiltinFacts {
  readonly moduleCount: number;
  readonly operationCount: number;
  readonly operationIds: readonly string[];
  readonly catalogEntryCount: number;
  readonly modelVisibleCount: number;
  readonly internalCount: number;
  readonly modelToolNames: readonly string[];
}

/**
 * The manifest checker consumes this one frozen SPI snapshot and its one
 * Builtin projection.  It must not reconstruct a Core registry or maintain a
 * second operation list for manifest validation.
 */
export const RUNTIME_MODULARIZATION_BUILTIN_FACTS_: RuntimeModularizationBuiltinFacts =
  Object.freeze({
    moduleCount: BUILTIN_REGISTRY_SNAPSHOT_.modules.length,
    operationCount: BUILTIN_REGISTRY_SNAPSHOT_.capabilities.length,
    operationIds: Object.freeze(
      BUILTIN_REGISTRY_SNAPSHOT_.capabilities.map(({ definition }) => definition.capabilityId),
    ),
    catalogEntryCount: BUILTIN_CATALOG_SNAPSHOT_.entries.length,
    modelVisibleCount: BUILTIN_CATALOG_SNAPSHOT_.entries.filter(
      (entry) => entry.visibility === 'model',
    ).length,
    internalCount: BUILTIN_CATALOG_SNAPSHOT_.entries.filter(
      (entry) => entry.visibility === 'internal',
    ).length,
    modelToolNames: Object.freeze(
      BUILTIN_CATALOG_SNAPSHOT_.entries.flatMap((entry) =>
        entry.visibility === 'model' ? [entry.name] : [],
      ),
    ),
  });

function assertBuiltinManifestFacts(): void {
  const facts = RUNTIME_MODULARIZATION_BUILTIN_FACTS_;
  if (
    facts.moduleCount !== 6 ||
    facts.operationCount !== 29 ||
    facts.catalogEntryCount !== 29 ||
    facts.modelVisibleCount !== 20 ||
    facts.internalCount !== 9
  ) {
    throw new Error(
      `RM Builtin registry facts drifted (modules=${facts.moduleCount}, operations=${facts.operationCount}, entries=${facts.catalogEntryCount}, model=${facts.modelVisibleCount}, internal=${facts.internalCount}).`,
    );
  }
}

export const RUNTIME_MODULARIZATION_MANIFEST_DIRECTORY =
  'tests/reliability-harness/runtime-modularization/manifests' as const;

export const GENERATED_MANIFEST_FILES = Object.freeze([
  'runtime-state-shape.generated.json',
  'runtime-event-shape.generated.json',
  'store-schema.generated.json',
  'package-graph.generated.json',
  'public-exports.generated.json',
] as const);

export const MANUAL_MANIFEST_FILES = Object.freeze([
  'operation-owner.json',
  'legacy-delete.json',
  'source-migration.json',
  'architecture-exceptions.json',
] as const);

type JsonObject = { [key: string]: JsonValue };
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

interface SourceIdentity {
  path: string;
  sha256: `sha256:${string}`;
}

interface GeneratedManifest<T extends JsonValue> {
  format: typeof RUNTIME_MODULARIZATION_MANIFEST_FORMAT;
  generatorRevision: typeof RUNTIME_MODULARIZATION_GENERATOR_REVISION;
  kind: string;
  sources: SourceIdentity[];
  facts: T;
  digest: `sha256:${string}`;
}

export interface GeneratedRuntimeModularizationManifests {
  'runtime-state-shape.generated.json': GeneratedManifest<JsonObject>;
  'runtime-event-shape.generated.json': GeneratedManifest<JsonObject>;
  'store-schema.generated.json': GeneratedManifest<JsonObject>;
  'package-graph.generated.json': GeneratedManifest<JsonObject>;
  'public-exports.generated.json': GeneratedManifest<JsonObject>;
}

interface TypeShapeField {
  name: string;
  optional: boolean;
  type: string;
}

interface TypeDeclarationFact {
  id: string;
  path: string;
  kind: string;
  fields: TypeShapeField[];
  unionMembers: string[];
  declarationDigest: `sha256:${string}`;
}

interface PackageFact {
  name: string;
  path: string;
  private: boolean;
  type: string | null;
  module: string | null;
  exports: JsonValue;
  dependencies: Array<{ name: string; range: string; kind: string }>;
  internalDependencies: string[];
}

interface PublicExportFact {
  packageName: string;
  packagePath: string;
  entrypoint: string;
  exportedName: string;
  localName: string | null;
  source: string | null;
  typeOnly: boolean;
  kind: string;
}

interface EntrypointFact {
  packageName: string;
  packagePath: string;
  source: string;
  kind: 'module' | 'export' | 'bin' | 'script';
  name: string;
  resolved: boolean;
}

interface PackageGraphFacts {
  workspacePatterns: string[];
  packages: PackageFact[];
  internalEdges: Array<{ from: string; to: string; kind: 'declared' | 'observed' }>;
  entrypoints: EntrypointFact[];
  publicExports: PublicExportFact[];
}

export function generatedManifestPath(root: string, file: string): string {
  return join(root, RUNTIME_MODULARIZATION_MANIFEST_DIRECTORY, file);
}

export function serializeGeneratedManifest(
  value: JsonValue | GeneratedManifest<JsonObject>,
): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function generateRuntimeModularizationManifests(
  repositoryRoot: string,
): GeneratedRuntimeModularizationManifests {
  assertBuiltinManifestFacts();
  const root = resolve(repositoryRoot);
  const typeContext = createTypeContext(root);
  const state = generateRuntimeStateShape(root, typeContext);
  const events = generateRuntimeEventShape(root, typeContext);
  const store = generateRuntimeStoreShape();
  const packageGraph = collectPackageGraph(root);
  const packageSources = packageGraph.packages.map((entry) => join(entry.path, 'package.json'));
  const packageGraphSources = uniqueSorted([
    ...packageSources,
    ...packageGraph.entrypoints.filter((entry) => entry.resolved).map((entry) => entry.source),
  ]);
  const publicExportSources = uniqueSorted([
    ...packageSources,
    ...packageGraph.publicExports.map((entry) => entry.entrypoint),
  ]);

  return {
    'runtime-state-shape.generated.json': generatedManifest(
      root,
      'runtime-state-shape',
      state.sources,
      state.facts,
    ),
    'runtime-event-shape.generated.json': generatedManifest(
      root,
      'runtime-event-shape',
      events.sources,
      events.facts,
    ),
    'store-schema.generated.json': generatedManifest(
      root,
      'store-schema',
      [
        'packages/runtime-host/src/format/storage-binding.ts',
        'packages/runtime-storage-sqlite/src/index.ts',
        'packages/runtime-storage-sqlite/src/adapter.ts',
        'packages/runtime-storage-sqlite/src/preflight.ts',
        'packages/runtime-storage-sqlite/src/store.ts',
      ],
      store,
    ),
    'package-graph.generated.json': generatedManifest(
      root,
      'package-graph',
      packageGraphSources,
      packageGraph as unknown as JsonObject,
    ),
    'public-exports.generated.json': generatedManifest(
      root,
      'public-exports',
      publicExportSources,
      {
        packages: packageGraph.packages.map((entry) => ({
          name: entry.name,
          path: entry.path,
          exports: entry.exports,
          module: entry.module,
        })),
        exports: packageGraph.publicExports,
      } as unknown as JsonObject,
    ),
  };
}

function generatedManifest<T extends JsonValue>(
  root: string,
  kind: string,
  sourcePaths: readonly string[],
  facts: T,
): GeneratedManifest<T> {
  const sources = uniqueSorted([RUNTIME_MODULARIZATION_GENERATOR_SOURCE, ...sourcePaths]).map(
    (path) => sourceIdentity(root, path),
  );
  const unsigned = {
    format: RUNTIME_MODULARIZATION_MANIFEST_FORMAT,
    generatorRevision: RUNTIME_MODULARIZATION_GENERATOR_REVISION,
    kind,
    sources,
    facts,
  };
  return {
    ...unsigned,
    digest: sha256DomainSeparated(`runtime-modularization:${kind}`, canonicalJsonBytes(unsigned)),
  };
}

function sourceIdentity(root: string, path: string): SourceIdentity {
  const absolute = resolve(root, path);
  assertInsideRoot(root, absolute);
  if (!isRegularFile(absolute)) throw new Error(`Generated manifest source is not a file: ${path}`);
  const normalized = readFileSync(absolute, 'utf8').replaceAll('\r\n', '\n');
  return { path: normalizedRelative(root, absolute), sha256: sha256Digest(normalized) };
}

interface TypeContext {
  program: ts.Program;
  checker: ts.TypeChecker;
}

function createTypeContext(root: string): TypeContext {
  const configPath = join(root, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(formatDiagnostic(config.error));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath);
  if (parsed.errors.length > 0) throw new Error(parsed.errors.map(formatDiagnostic).join('\n'));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return { program, checker: program.getTypeChecker() };
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

function findTypeAlias(source: ts.SourceFile, name: string): ts.TypeAliasDeclaration {
  const declaration = source.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === name,
  );
  if (!declaration) throw new Error(`Missing type alias ${name} in ${source.fileName}`);
  return declaration;
}

function findInterface(source: ts.SourceFile, name: string): ts.InterfaceDeclaration {
  const declaration = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  );
  if (!declaration) throw new Error(`Missing interface ${name} in ${source.fileName}`);
  return declaration;
}

function generateRuntimeStateShape(
  root: string,
  context: TypeContext,
): { sources: string[]; facts: JsonObject } {
  const statePath = join(root, 'packages/agent-kernel/src/state.ts');
  const source = context.program.getSourceFile(statePath);
  if (!source) throw new Error('Runtime state source is missing from the TypeScript program.');
  const declaration = findInterface(source, 'AgentState');
  const stateType = context.checker.getTypeAtLocation(declaration.name);
  const fields = fieldsOfType(context.checker, stateType, declaration);
  const declarations = collectReachableTypeDeclarations(root, context.checker, stateType);
  const declarationSources = declarations.map((entry) => entry.path);

  if (RUNTIME_STATE_SCHEMA_VERSION !== 26) {
    throw new Error(`RA requires Runtime State schema 26, found ${RUNTIME_STATE_SCHEMA_VERSION}.`);
  }
  if (RUNTIME_STATE_FORMAT_EPOCH !== 'kite-runtime-modularization-v1-2026-08-19') {
    throw new Error(`RA requires the target epoch, found ${RUNTIME_STATE_FORMAT_EPOCH}.`);
  }

  return {
    sources: uniqueSorted(['packages/agent-kernel/src/state.ts', ...declarationSources]),
    facts: {
      schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
      formatEpoch: RUNTIME_STATE_FORMAT_EPOCH,
      rootType: 'RuntimeState',
      fieldCount: fields.length,
      fields,
      reachableDeclarationCount: declarations.length,
      reachableDeclarations: declarations,
    } as unknown as JsonObject,
  };
}

function fieldsOfType(
  checker: ts.TypeChecker,
  type: ts.Type,
  fallbackLocation: ts.Node,
): TypeShapeField[] {
  return type
    .getProperties()
    .map((property) => {
      const location = property.valueDeclaration ?? property.declarations?.[0] ?? fallbackLocation;
      return {
        name: property.name,
        optional: (property.flags & ts.SymbolFlags.Optional) !== 0,
        type: typeText(checker, checker.getTypeOfSymbolAtLocation(property, location), location),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function typeText(checker: ts.TypeChecker, type: ts.Type, location: ts.Node): string {
  return checker.typeToString(
    type,
    location,
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
  );
}

function collectReachableTypeDeclarations(
  root: string,
  checker: ts.TypeChecker,
  rootType: ts.Type,
): TypeDeclarationFact[] {
  const visitedTypes = new Set<ts.Type>();
  const declarations = new Map<string, TypeDeclarationFact>();
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

  const visit = (type: ts.Type): void => {
    if (visitedTypes.has(type)) return;
    visitedTypes.add(type);
    if (visitedTypes.size > 4_096) throw new Error('Runtime state type closure exceeds its bound.');

    if (type.isUnionOrIntersection()) {
      for (const member of type.types) visit(member);
    }

    const reference = type as ts.TypeReference;
    for (const argument of checker.getTypeArguments(reference) ?? []) visit(argument);

    for (const symbol of [type.aliasSymbol, type.getSymbol()]) {
      if (!symbol) continue;
      for (const candidate of symbol.declarations ?? []) {
        if (!isShapeDeclaration(candidate)) continue;
        const source = candidate.getSourceFile();
        if (
          !isInsideRoot(root, source.fileName) ||
          source.fileName.includes(`${sep}node_modules${sep}`)
        ) {
          continue;
        }
        const path = normalizedRelative(root, source.fileName);
        const name = candidate.name?.getText(source) ?? symbol.name;
        const id = `${path}#${name}`;
        if (!declarations.has(id)) {
          const declaredType = checker.getTypeAtLocation(candidate.name ?? candidate);
          const canonical = printer.printNode(ts.EmitHint.Unspecified, candidate, source);
          declarations.set(id, {
            id,
            path,
            kind: ts.SyntaxKind[candidate.kind] ?? 'Unknown',
            fields:
              (declaredType.flags & ts.TypeFlags.Object) !== 0
                ? fieldsOfType(checker, declaredType, candidate)
                : [],
            unionMembers: declaredType.isUnion()
              ? declaredType.types.map((member) => typeText(checker, member, candidate)).sort()
              : [],
            declarationDigest: sha256Digest(canonical),
          });
        }
      }
    }

    if ((type.flags & ts.TypeFlags.Object) === 0) return;
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      for (const argument of checker.getTypeArguments(type as ts.TypeReference)) visit(argument);
      return;
    }
    for (const property of type.getProperties()) {
      const location = property.valueDeclaration ?? property.declarations?.[0];
      if (location) visit(checker.getTypeOfSymbolAtLocation(property, location));
    }
    for (const indexKind of [ts.IndexKind.String, ts.IndexKind.Number]) {
      const indexType = checker.getIndexTypeOfType(type, indexKind);
      if (indexType) visit(indexType);
    }
  };

  visit(rootType);
  return [...declarations.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function isShapeDeclaration(
  node: ts.Declaration,
): node is ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration {
  return (
    ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)
  );
}

function generateRuntimeEventShape(
  root: string,
  context: TypeContext,
): { sources: string[]; facts: JsonObject } {
  const eventsPath = join(root, 'packages/agent-kernel/src/events.ts');
  const codecPath = eventsPath;
  const eventsSource = context.program.getSourceFile(eventsPath);
  const codecSource = context.program.getSourceFile(codecPath);
  if (!eventsSource || !codecSource) throw new Error('Runtime event sources are missing.');
  const runtimeEvent = findTypeAlias(eventsSource, 'RuntimeEvent');
  const runtimeEventType = context.checker.getTypeAtLocation(runtimeEvent.name);
  if (!runtimeEventType.isUnion())
    throw new Error('RuntimeEvent must remain a discriminated union.');
  const codec = eventCodecRequiredFields(codecSource);
  const declarationSources = new Set<string>(['packages/agent-kernel/src/events.ts']);

  const events = runtimeEventType.types
    .map((member) => {
      const discriminant = member.getProperty('type');
      if (!discriminant) throw new Error('RuntimeEvent member is missing a type discriminant.');
      const location =
        discriminant.valueDeclaration ?? discriminant.declarations?.[0] ?? runtimeEvent;
      const discriminantType = context.checker.getTypeOfSymbolAtLocation(discriminant, location);
      if (!discriminantType.isStringLiteral()) {
        throw new Error('RuntimeEvent discriminant must be a string literal.');
      }
      for (const declaration of member.aliasSymbol?.declarations ??
        member.getSymbol()?.declarations ??
        []) {
        if (isInsideRoot(root, declaration.getSourceFile().fileName)) {
          declarationSources.add(normalizedRelative(root, declaration.getSourceFile().fileName));
        }
      }
      const fields = fieldsOfType(context.checker, member, runtimeEvent).filter(
        (field) => field.name !== 'type',
      );
      const requiredFields = fields.filter((field) => !field.optional).map((field) => field.name);
      const codecFields = codec.get(discriminantType.value);
      if (!codecFields) throw new Error(`Event codec is missing ${discriminantType.value}.`);
      if (!sameStringSet(requiredFields, codecFields)) {
        throw new Error(
          `Event codec fields drifted for ${discriminantType.value}: union=${requiredFields.join(',')} codec=${codecFields.join(',')}`,
        );
      }
      return {
        type: discriminantType.value,
        declaration: member.aliasSymbol?.name ?? member.getSymbol()?.name ?? '<anonymous>',
        fields,
        requiredFields,
        codecRequiredFields: codecFields,
      };
    })
    .sort((left, right) => left.type.localeCompare(right.type));

  if (codec.size !== events.length) {
    throw new Error(`RuntimeEvent union/codec count mismatch: ${events.length}/${codec.size}.`);
  }

  return {
    sources: [...declarationSources].sort(),
    facts: {
      rootType: 'RuntimeEvent',
      eventCount: events.length,
      codecDiscriminantCount: codec.size,
      events,
    } as unknown as JsonObject,
  };
}

function eventCodecRequiredFields(source: ts.SourceFile): Map<string, string[]> {
  const declaration = source.statements
    .flatMap((statement) =>
      ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
    )
    .find(
      (candidate) =>
        ts.isIdentifier(candidate.name) &&
        candidate.name.text === 'CURRENT_RUNTIME_EVENT_REQUIRED_FIELDS',
    );
  if (!declaration?.initializer) throw new Error('Runtime event codec field manifest is missing.');
  const object = unwrapExpression(declaration.initializer);
  if (!ts.isObjectLiteralExpression(object))
    throw new Error('Event codec field manifest is invalid.');
  const result = new Map<string, string[]>();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property))
      throw new Error('Event codec entry must be an assignment.');
    const key = propertyName(property.name, source);
    const array = unwrapExpression(property.initializer);
    if (!ts.isArrayLiteralExpression(array))
      throw new Error(`Event codec entry ${key} is not an array.`);
    const fields = array.elements.map((element) => {
      if (!ts.isStringLiteralLike(element))
        throw new Error(`Event codec entry ${key} is not literal.`);
      return element.text;
    });
    if (result.has(key)) throw new Error(`Duplicate event codec entry: ${key}`);
    result.set(key, fields);
  }
  return result;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(name: ts.PropertyName, source: ts.SourceFile): string {
  if (ts.isStringLiteralLike(name) || ts.isIdentifier(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return name.getText(source);
}

function generateRuntimeStoreShape(): JsonObject {
  const boundary = createSqliteRuntimeStorageBoundary();
  if (
    boundary.adapterId !== 'sqlite' ||
    boundary.stateSchemaVersion !== 26 ||
    boundary.storeSchemaVersion !== 5 ||
    boundary.formatEpoch !== 'kite-runtime-modularization-v1-2026-08-19'
  ) {
    throw new Error(
      `RA requires SQLite adapter facts sqlite/26/5/kite-runtime-modularization-v1-2026-08-19, found ${JSON.stringify(boundary)}.`,
    );
  }
  const canonicalTemporaryParent = realpathSync(tmpdir());
  const temporaryRoot = mkdtempSync(join(canonicalTemporaryParent, 'kite-runtime-store-shape-'));
  const databasePath = join(temporaryRoot, 'runtime.db');
  let facts: JsonObject | undefined;
  let generationError: unknown;
  try {
    const state = createRuntimeHostStateStorageBinding();
    const store = createSqliteRuntimeStorage({
      databasePath,
      codec: state.codec,
      options: { journalMode: 'delete' },
    });
    if (
      store.adapterId !== boundary.adapterId ||
      store.stateSchemaVersion !== boundary.stateSchemaVersion ||
      store.storeSchemaVersion !== boundary.storeSchemaVersion ||
      store.formatEpoch !== boundary.formatEpoch
    ) {
      throw new Error('SQLite Runtime adapter facts disagree with its public boundary.');
    }
    store.close();
    // The adapter above is the sole Store 5 writer. This connection is a
    // read-only schema observer over the adapter-created database; it never
    // creates tables, commits, or becomes a second storage authority.
    const database = new Database(databasePath, { readonly: true });
    try {
      const schemaEntries = database
        .query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(
          "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all();
      const tables = schemaEntries
        .filter((entry) => entry.type === 'table')
        .map((entry) => {
          assertSqlIdentifier(entry.name);
          const columns = database
            .query<
              {
                cid: number;
                name: string;
                type: string;
                notnull: number;
                dflt_value: string | null;
                pk: number;
              },
              []
            >(`PRAGMA table_info(${quotedIdentifier(entry.name)})`)
            .all()
            .map((column) => ({
              position: column.cid,
              name: column.name,
              type: column.type,
              notNull: column.notnull === 1,
              default: column.dflt_value,
              primaryKeyPosition: column.pk,
            }));
          return { name: entry.name, sql: normalizeSql(entry.sql), columns };
        });
      const indexes = schemaEntries
        .filter((entry) => entry.type === 'index')
        .map((entry) => ({
          name: entry.name,
          table: entry.tbl_name,
          sql: normalizeSql(entry.sql),
        }));
      const markers = Object.fromEntries(
        database
          .query<{ key: string; value: string }, []>(
            'SELECT key, value FROM runtime_store_meta ORDER BY key',
          )
          .all()
          .map((entry) => [entry.key, entry.value]),
      );
      if (
        markers.format_version !== String(store.storeSchemaVersion) ||
        markers.runtime_format_epoch !== store.formatEpoch
      ) {
        throw new Error('Runtime Store marker does not match the RA frozen format.');
      }
      facts = {
        adapterId: store.adapterId,
        storeSchemaVersion: store.storeSchemaVersion,
        runtimeStateSchemaVersion: store.stateSchemaVersion,
        formatEpoch: store.formatEpoch,
        markers,
        tableCount: tables.length,
        tables,
        indexCount: indexes.length,
        indexes,
      } as unknown as JsonObject;
    } finally {
      database.close();
    }
  } catch (error) {
    generationError = error;
  }

  let cleanupError: unknown;
  try {
    const resolvedTemporaryRoot = resolve(temporaryRoot);
    const resolvedTmp = resolve(canonicalTemporaryParent);
    const temporaryRootStat = lstatSync(resolvedTemporaryRoot);
    if (
      resolvedTemporaryRoot === resolvedTmp ||
      !resolvedTemporaryRoot.startsWith(`${resolvedTmp}${sep}`) ||
      !temporaryRootStat.isDirectory() ||
      temporaryRootStat.isSymbolicLink()
    ) {
      throw new Error('Refusing to clean an invalid Runtime schema temporary directory.');
    }
    rmSync(resolvedTemporaryRoot, { recursive: true, force: false });
  } catch (error) {
    cleanupError = error;
  }

  if (generationError) throw generationError;
  if (cleanupError) throw cleanupError;
  if (!facts) throw new Error('Runtime Store schema generation produced no facts.');
  return facts;
}

function normalizeSql(sql: string | null): string | null {
  return sql?.replaceAll(/\s+/gu, ' ').trim() ?? null;
}

function quotedIdentifier(value: string): string {
  assertSqlIdentifier(value);
  return `"${value}"`;
}

function assertSqlIdentifier(value: string): void {
  if (!/^[a-z][a-z0-9_]{0,127}$/u.test(value)) throw new Error('Unsafe SQLite identifier.');
}

function collectPackageGraph(root: string): PackageGraphFacts {
  const rootManifest = readPackageManifest(join(root, 'package.json'));
  const workspacePatterns = workspacePatternsOf(rootManifest);
  const packagePaths = uniqueSorted([
    '.',
    ...workspacePatterns.flatMap((pattern) => expandWorkspacePattern(root, pattern)),
  ]);
  const packages = packagePaths.map((path) => packageFact(root, path));
  const packageNames = new Set(packages.map((entry) => entry.name));
  const declaredEdges = packages.flatMap((entry) =>
    entry.dependencies
      .filter((dependency) => packageNames.has(dependency.name))
      .map((dependency) => ({
        from: entry.name,
        to: dependency.name,
        kind: 'declared' as const,
      })),
  );
  const observedEdges = collectObservedInternalEdges(root, packages, packageNames);
  const entrypoints = packages.flatMap((entry) => packageEntrypoints(root, entry));
  const publicExports = entrypoints
    .filter((entry) => entry.kind === 'module' || entry.kind === 'export')
    .flatMap((entry) => collectPublicExports(root, entry));
  return {
    workspacePatterns,
    packages,
    internalEdges: uniqueBy(
      [...declaredEdges, ...observedEdges],
      (entry) => `${entry.from}\0${entry.to}\0${entry.kind}`,
    ).sort((left, right) =>
      `${left.from}:${left.to}:${left.kind}`.localeCompare(
        `${right.from}:${right.to}:${right.kind}`,
      ),
    ),
    entrypoints: uniqueBy(
      entrypoints,
      (entry) => `${entry.packageName}\0${entry.kind}\0${entry.name}\0${entry.source}`,
    ).sort((left, right) =>
      `${left.packageName}:${left.kind}:${left.name}:${left.source}`.localeCompare(
        `${right.packageName}:${right.kind}:${right.name}:${right.source}`,
      ),
    ),
    publicExports: uniqueBy(
      publicExports,
      (entry) => `${entry.packageName}\0${entry.entrypoint}\0${entry.exportedName}`,
    ).sort((left, right) =>
      `${left.packageName}:${left.entrypoint}:${left.exportedName}`.localeCompare(
        `${right.packageName}:${right.entrypoint}:${right.exportedName}`,
      ),
    ),
  };
}

function readPackageManifest(path: string): Record<string, unknown> {
  const parsed = parseStrictJson(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Package manifest is not an object: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

function workspacePatternsOf(manifest: Record<string, unknown>): string[] {
  const workspaces = manifest.workspaces;
  if (Array.isArray(workspaces))
    return workspaces.filter((entry): entry is string => typeof entry === 'string');
  if (workspaces && typeof workspaces === 'object' && !Array.isArray(workspaces)) {
    const packages = (workspaces as Record<string, unknown>).packages;
    if (Array.isArray(packages))
      return packages.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

function expandWorkspacePattern(root: string, pattern: string): string[] {
  const normalized = normalizeRepositoryPath(pattern);
  if (!normalized.includes('*')) {
    return existsSync(join(root, normalized, 'package.json')) ? [normalized] : [];
  }
  if (!normalized.endsWith('/*') || normalized.slice(0, -2).includes('*')) {
    throw new Error(`Unsupported workspace pattern: ${pattern}`);
  }
  const parent = normalized.slice(0, -2);
  const absoluteParent = join(root, parent);
  if (!existsSync(absoluteParent)) return [];
  return readdirSync(absoluteParent, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(join(absoluteParent, entry.name, 'package.json')),
    )
    .map((entry) => `${parent}/${entry.name}`)
    .sort();
}

function packageFact(root: string, path: string): PackageFact {
  const manifest = readPackageManifest(join(root, path, 'package.json'));
  if (typeof manifest.name !== 'string') throw new Error(`Package ${path} has no name.`);
  const dependencyKinds = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ];
  const dependencies = dependencyKinds.flatMap((kind) => {
    const entries = manifest[kind];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return [];
    return Object.entries(entries as Record<string, unknown>).map(([name, range]) => {
      if (typeof range !== 'string') throw new Error(`Invalid dependency ${name} in ${path}.`);
      return { name, range, kind };
    });
  });
  return {
    name: manifest.name,
    path: normalizeRepositoryPath(path),
    private: manifest.private === true,
    type: typeof manifest.type === 'string' ? manifest.type : null,
    module: typeof manifest.module === 'string' ? normalizeRepositoryPath(manifest.module) : null,
    exports: jsonValue(manifest.exports ?? null),
    dependencies: dependencies.sort((left, right) =>
      `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`),
    ),
    internalDependencies: dependencies
      .filter((dependency) => dependency.name.startsWith('@kite/'))
      .map((dependency) => dependency.name)
      .sort(),
  };
}

function jsonValue(value: unknown): JsonValue {
  canonicalJsonBytes(value);
  return value as JsonValue;
}

function collectObservedInternalEdges(
  root: string,
  packages: readonly PackageFact[],
  packageNames: ReadonlySet<string>,
): Array<{ from: string; to: string; kind: 'observed' }> {
  return packages.flatMap((entry) => {
    const sourceRoot = join(root, entry.path, 'src');
    if (!existsSync(sourceRoot)) return [];
    return sourceFiles(sourceRoot).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return ts.preProcessFile(source, true, true).importedFiles.flatMap((imported) => {
        const target = [...packageNames].find(
          (name) => imported.fileName === name || imported.fileName.startsWith(`${name}/`),
        );
        return target && target !== entry.name
          ? [{ from: entry.name, to: target, kind: 'observed' as const }]
          : [];
      });
    });
  });
}

function packageEntrypoints(root: string, entry: PackageFact): EntrypointFact[] {
  const manifest = readPackageManifest(join(root, entry.path, 'package.json'));
  const result: EntrypointFact[] = [];
  if (entry.module) {
    result.push({
      packageName: entry.name,
      packagePath: entry.path,
      source: normalizeRepositoryPath(join(entry.path, entry.module)),
      kind: 'module',
      name: '.',
      resolved: isRegularFile(join(root, entry.path, entry.module)),
    });
  }
  for (const target of exportTargets(manifest.exports)) {
    result.push({
      packageName: entry.name,
      packagePath: entry.path,
      source: normalizeRepositoryPath(join(entry.path, target.target)),
      kind: 'export',
      name: target.name,
      resolved: isRegularFile(join(root, entry.path, target.target)),
    });
  }
  if (typeof manifest.bin === 'string') {
    result.push({
      packageName: entry.name,
      packagePath: entry.path,
      source: normalizeRepositoryPath(join(entry.path, manifest.bin)),
      kind: 'bin',
      name: entry.name,
      resolved: isRegularFile(join(root, entry.path, manifest.bin)),
    });
  } else if (manifest.bin && typeof manifest.bin === 'object' && !Array.isArray(manifest.bin)) {
    for (const [name, target] of Object.entries(manifest.bin as Record<string, unknown>)) {
      if (typeof target === 'string') {
        result.push({
          packageName: entry.name,
          packagePath: entry.path,
          source: normalizeRepositoryPath(join(entry.path, target)),
          kind: 'bin',
          name,
          resolved: isRegularFile(join(root, entry.path, target)),
        });
      }
    }
  }
  if (
    manifest.scripts &&
    typeof manifest.scripts === 'object' &&
    !Array.isArray(manifest.scripts)
  ) {
    for (const [name, command] of Object.entries(manifest.scripts as Record<string, unknown>)) {
      if (typeof command !== 'string') continue;
      for (const source of scriptSourcePaths(command)) {
        const path = normalizeRepositoryPath(join(entry.path, source));
        result.push({
          packageName: entry.name,
          packagePath: entry.path,
          source: path,
          kind: 'script',
          name,
          resolved: isRegularFile(join(root, path)),
        });
      }
    }
  }
  return result;
}

function exportTargets(value: unknown, name = '.'): Array<{ name: string; target: string }> {
  if (typeof value === 'string') return [{ name, target: value }];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const childName = key.startsWith('.') ? key : name;
    return exportTargets(child, childName);
  });
}

function scriptSourcePaths(command: string): string[] {
  const result: string[] = [];
  const pattern = /(?:^|\s)(?:bun(?:\s+--watch)?\s+run|bun\s+test)\s+([^\s]+)/gu;
  for (const match of command.matchAll(pattern)) {
    const candidate = match[1]?.replace(/^['"]|['"]$/gu, '');
    if (candidate && /\.(?:ts|tsx|js|jsx)$/u.test(candidate)) result.push(candidate);
  }
  return result;
}

function collectPublicExports(root: string, entry: EntrypointFact): PublicExportFact[] {
  const absolute = join(root, entry.source);
  if (!isRegularFile(absolute) || !/\.(?:ts|tsx)$/u.test(absolute)) return [];
  const source = ts.createSourceFile(
    absolute,
    readFileSync(absolute, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    absolute.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const result: PublicExportFact[] = [];
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      const module =
        statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : null;
      if (!statement.exportClause) {
        result.push(publicExport(entry, '*', null, module, statement.isTypeOnly, 'star'));
      } else if (ts.isNamespaceExport(statement.exportClause)) {
        result.push(
          publicExport(
            entry,
            statement.exportClause.name.text,
            '*',
            module,
            statement.isTypeOnly,
            'namespace',
          ),
        );
      } else {
        for (const element of statement.exportClause.elements) {
          result.push(
            publicExport(
              entry,
              element.name.text,
              element.propertyName?.text ?? element.name.text,
              module,
              statement.isTypeOnly || element.isTypeOnly,
              'named',
            ),
          );
        }
      }
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const typeOnly = ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement);
    const named = declarationNames(statement);
    for (const name of named) {
      result.push(publicExport(entry, name, name, null, typeOnly, ts.SyntaxKind[statement.kind]));
    }
  }
  return result;
}

function publicExport(
  entry: EntrypointFact,
  exportedName: string,
  localName: string | null,
  source: string | null,
  typeOnly: boolean,
  kind: string,
): PublicExportFact {
  return {
    packageName: entry.packageName,
    packagePath: entry.packagePath,
    entrypoint: entry.source,
    exportedName,
    localName,
    source,
    typeOnly,
    kind,
  };
}

function declarationNames(statement: ts.Statement): string[] {
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    return statement.name ? [statement.name.text] : ['default'];
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    );
  }
  return [];
}

export interface ManualManifestValidationResult {
  operationCount: number;
  responsibilityCount: number;
  legacyRuleCount: number;
  sourceFileCount: number;
  testConsumerCount: number;
  publicExportCount: number;
  architectureExceptionCount: number;
}

export function validateRuntimeModularizationManualManifests(
  repositoryRoot: string,
  generated: GeneratedRuntimeModularizationManifests,
): ManualManifestValidationResult {
  const root = resolve(repositoryRoot);
  const operationOwner = readManualManifest(root, 'operation-owner.json');
  const legacyDelete = readManualManifest(root, 'legacy-delete.json');
  const sourceMigration = readManualManifest(root, 'source-migration.json');
  const architectureExceptions = readManualManifest(root, 'architecture-exceptions.json');
  const currentTasks = new Set(
    [operationOwner, legacyDelete, sourceMigration, architectureExceptions].map((manifest) =>
      requiredString(manifest.currentTask, 'manual manifest current task'),
    ),
  );
  if (currentTasks.size !== 1) throw new Error('Manual manifests disagree on the current RM task.');

  const operationResult = validateOperationOwner(root, operationOwner);
  const legacyRuleCount = validateLegacyDelete(root, legacyDelete);
  const sourceResult = validateSourceMigration(root, sourceMigration, generated);
  const architectureExceptionCount = validateArchitectureExceptions(architectureExceptions);
  return {
    ...operationResult,
    legacyRuleCount,
    ...sourceResult,
    architectureExceptionCount,
  };
}

function readManualManifest(root: string, file: string): Record<string, unknown> {
  const parsed = parseStrictJson(readFileSync(generatedManifestPath(root, file), 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Manual manifest ${file} must be an object.`);
  }
  const manifest = parsed as Record<string, unknown>;
  if (manifest.format !== RUNTIME_MODULARIZATION_MANIFEST_FORMAT) {
    throw new Error(`Manual manifest ${file} has the wrong format/current task.`);
  }
  requireRuntimeTask(manifest.currentTask, `${file} current task`);
  return manifest;
}

function validateOperationOwner(
  root: string,
  manifest: Record<string, unknown>,
): { operationCount: number; responsibilityCount: number } {
  assertBuiltinManifestFacts();
  const profiles = objectRecord(manifest.ownerProfiles, 'operation owner profiles');
  const dimensions = ['execution', 'state', 'persistence', 'receipt'];
  for (const [id, value] of Object.entries(profiles)) {
    const profile = objectRecord(value, `owner profile ${id}`);
    for (const dimension of dimensions) requiredString(profile[dimension], `${id}.${dimension}`);
  }
  const responsibilities = objectArray(manifest.responsibilities, 'responsibilities');
  const responsibilityIds = new Set<string>();
  for (const responsibility of responsibilities) {
    const id = requiredString(responsibility.id, 'responsibility id');
    if (responsibilityIds.has(id)) throw new Error(`Duplicate responsibility owner: ${id}`);
    responsibilityIds.add(id);
    requireOwnerProfile(profiles, responsibility.currentOwnerProfile, `${id} current owner`);
    requireOwnerProfile(profiles, responsibility.targetOwnerProfile, `${id} target owner`);
    requireRuntimeTask(responsibility.cutoverTask, `${id} cutover task`);
    const entry = requiredString(responsibility.currentProductionEntry, `${id} production entry`);
    assertSourceAnchorExists(root, entry);
  }
  const operationGroups = objectArray(manifest.operationGroups, 'operation groups');
  const operations = new Set<string>();
  for (const group of operationGroups) {
    const id = requiredString(group.id, 'operation group id');
    requireOwnerProfile(profiles, group.currentOwnerProfile, `${id} current owner`);
    requireOwnerProfile(profiles, group.targetOwnerProfile, `${id} target owner`);
    requireRuntimeTask(group.cutoverTask, `${id} cutover task`);
    assertSourceAnchorExists(
      root,
      requiredString(group.currentProductionEntry, `${id} production entry`),
    );
    for (const operation of stringArray(group.operations, `${id} operations`)) {
      if (operations.has(operation))
        throw new Error(`Operation has multiple production owners: ${operation}`);
      operations.add(operation);
    }
  }
  const expected = new Set(RUNTIME_MODULARIZATION_BUILTIN_FACTS_.operationIds);
  const missing = [...expected].filter((operation) => !operations.has(operation));
  const stale = [...operations].filter((operation) => !expected.has(operation));
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(
      `Builtin production operations drifted (missing=${missing.join(',')}, stale=${stale.join(',')}).`,
    );
  }
  return { operationCount: operations.size, responsibilityCount: responsibilities.length };
}

function requireOwnerProfile(
  profiles: Record<string, unknown>,
  value: unknown,
  label: string,
): void {
  const id = requiredString(value, label);
  if (!profiles[id]) throw new Error(`${label} references missing profile ${id}.`);
}

function validateLegacyDelete(root: string, manifest: Record<string, unknown>): number {
  const rules = objectArray(manifest.rules, 'legacy delete rules');
  const ids = new Set<string>();
  for (const rule of rules) {
    const id = requiredString(rule.id, 'legacy rule id');
    if (ids.has(id)) throw new Error(`Duplicate legacy rule: ${id}`);
    ids.add(id);
    const status = requiredString(rule.status, `${id} status`);
    if (!['present', 'planned', 'deleted'].includes(status))
      throw new Error(`Invalid legacy status: ${id}`);
    requireRuntimeTask(rule.deleteTask, `${id} delete task`);
    const matches = legacyRuleMatches(root, rule);
    if (status === 'present' && matches === 0)
      throw new Error(`Registered legacy rule no longer matches: ${id}`);
    if (status === 'planned' && matches !== 0)
      throw new Error(`Planned legacy rule is already reachable and must change status: ${id}`);
    if (status === 'deleted' && matches !== 0)
      throw new Error(`Deleted legacy rule is still reachable: ${id}`);
  }
  const discoveries = discoverLegacyFacts(root);
  for (const discovery of discoveries) {
    if (!rules.some((rule) => legacyRuleCoversDiscovery(rule, discovery))) {
      throw new Error(
        `Unregistered legacy ${discovery.kind}: ${discovery.file} ${discovery.value}`,
      );
    }
  }
  return rules.length;
}

interface LegacyDiscovery {
  kind: 'import' | 'symbol' | 'file' | 'text';
  file: string;
  value: string;
}

function discoverLegacyFacts(root: string): LegacyDiscovery[] {
  const discoveries: LegacyDiscovery[] = [];
  for (const file of [
    ...sourceFiles(join(root, 'src/app')),
    ...sourceFiles(join(root, 'apps/kite/src')),
    join(root, 'src/index.ts'),
  ].filter(isRegularFile)) {
    const path = normalizedRelative(root, file);
    const source = parsedSource(file);
    for (const statement of source.statements) {
      if (
        (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier &&
        ts.isStringLiteralLike(statement.moduleSpecifier)
      ) {
        const specifier = statement.moduleSpecifier.text;
        const runtimeEdge =
          specifier === 'bun:sqlite' ||
          specifier.startsWith('@/core/runtime/') ||
          (path === 'src/index.ts' && specifier.includes('/core/runtime/'));
        if (runtimeEdge) discoveries.push({ kind: 'import', file: path, value: specifier });
      }
    }
  }
  for (const [file, symbol] of [
    ['src/core/runtime/scheduler.ts', 'PARALLEL_READ_TOOL_NAMES'],
    ['src/core/runtime/agent.ts', 'RuntimeKernelControl'],
    ['src/core/runtime/agent.ts', 'executeRuntimeTurn'],
  ] as const) {
    if (sourceDeclaresSymbol(join(root, file), symbol)) {
      discoveries.push({ kind: 'symbol', file, value: symbol });
    }
  }
  for (const file of [
    'src/core/controllers/tool-controller.ts',
    'src/core/harness/tool-runner.ts',
  ]) {
    if (isRegularFile(join(root, file))) discoveries.push({ kind: 'file', file, value: file });
  }
  return discoveries;
}

function legacyRuleCoversDiscovery(
  rule: Record<string, unknown>,
  discovery: LegacyDiscovery,
): boolean {
  if (rule.status === 'deleted') return false;
  const kind = requiredString(rule.kind, 'legacy rule kind');
  const filePattern = requiredString(rule.file, 'legacy rule file');
  if (!matchesPattern(discovery.file, filePattern)) return false;
  if (kind === 'file') return discovery.kind === 'file';
  if (kind === 'symbol') return discovery.kind === 'symbol' && rule.symbol === discovery.value;
  if (kind === 'import') {
    if (discovery.kind !== 'import') return false;
    const specifier = requiredString(rule.specifier, 'legacy import specifier');
    return rule.match === 'prefix'
      ? discovery.value.startsWith(specifier)
      : discovery.value === specifier;
  }
  if (kind === 'text') {
    return discovery.kind === 'text' && rule.contains === discovery.value;
  }
  return false;
}

function legacyRuleMatches(root: string, rule: Record<string, unknown>): number {
  const kind = requiredString(rule.kind, 'legacy rule kind');
  const files = filesMatching(root, requiredString(rule.file, 'legacy rule file'));
  if (kind === 'file') return files.length;
  if (kind === 'symbol') {
    const symbol = requiredString(rule.symbol, 'legacy symbol');
    return files.filter((file) => sourceDeclaresSymbol(file, symbol)).length;
  }
  if (kind === 'import') {
    const specifier = requiredString(rule.specifier, 'legacy import specifier');
    const prefix = rule.match === 'prefix';
    return files.reduce(
      (count, file) =>
        count +
        importedSpecifiers(file).filter((value) =>
          prefix ? value.startsWith(specifier) : value === specifier,
        ).length,
      0,
    );
  }
  if (kind === 'text') {
    const contains = requiredString(rule.contains, 'legacy text matcher');
    return files.reduce(
      (count, file) => count + (readFileSync(file, 'utf8').includes(contains) ? 1 : 0),
      0,
    );
  }
  throw new Error(`Unknown legacy rule kind: ${kind}`);
}

function validateSourceMigration(
  root: string,
  manifest: Record<string, unknown>,
  generated: GeneratedRuntimeModularizationManifests,
): { sourceFileCount: number; testConsumerCount: number; publicExportCount: number } {
  const sourceRules = objectArray(manifest.sourceRules, 'source migration rules');
  const consumerRules = objectArray(manifest.consumerRules, 'consumer migration rules');
  validateMigrationRules(sourceRules, 'source');
  validateMigrationRules(consumerRules, 'consumer');
  const sourcePaths = sourceFiles(join(root, 'src')).map((file) => normalizedRelative(root, file));
  for (const path of sourcePaths) requireExactlyOneRule(path, sourceRules, 'source migration');
  const testPaths = sourceFiles(join(root, 'tests')).map((file) => normalizedRelative(root, file));
  for (const path of testPaths)
    requireExactlyOneRule(path, consumerRules, 'test consumer migration');

  const dispositions = objectArray(manifest.publicExports, 'public export dispositions');
  const dispositionKeys = new Set<string>();
  for (const disposition of dispositions) {
    const packageName = requiredString(disposition.packageName, 'public export package');
    const entrypoint = requiredString(disposition.entrypoint, 'public export entrypoint');
    requireRuntimeTask(disposition.cutoverTask, 'public export cutover task');
    for (const name of stringArray(disposition.symbols, 'public export symbols')) {
      const key = `${packageName}\0${entrypoint}\0${name}`;
      if (dispositionKeys.has(key)) throw new Error(`Duplicate public export disposition: ${key}`);
      dispositionKeys.add(key);
    }
  }
  const generatedExports = (
    generated['public-exports.generated.json'].facts.exports as unknown as PublicExportFact[]
  ).map((entry) => `${entry.packageName}\0${entry.entrypoint}\0${entry.exportedName}`);
  const missingExports = generatedExports.filter((key) => !dispositionKeys.has(key));
  const staleExports = [...dispositionKeys].filter((key) => !generatedExports.includes(key));
  if (missingExports.length > 0 || staleExports.length > 0) {
    throw new Error(
      `Public export migration is incomplete (missing=${missingExports.join(',')} stale=${staleExports.join(',')}).`,
    );
  }
  return {
    sourceFileCount: sourcePaths.length,
    testConsumerCount: testPaths.length,
    publicExportCount: generatedExports.length,
  };
}

function validateMigrationRules(rules: Record<string, unknown>[], label: string): void {
  const ids = new Set<string>();
  for (const rule of rules) {
    const id = requiredString(rule.id, `${label} rule id`);
    if (ids.has(id)) throw new Error(`Duplicate ${label} migration rule: ${id}`);
    ids.add(id);
    requiredString(rule.source, `${id} source`);
    requireRuntimeTask(rule.cutoverTask, `${id} cutover task`);
    const targets = stringArray(rule.targetPackages, `${id} target packages`);
    if (targets.length === 0) throw new Error(`${id} has no target package.`);
  }
}

function requireExactlyOneRule(
  path: string,
  rules: Record<string, unknown>[],
  label: string,
): void {
  const matches = rules.filter((rule) =>
    matchesPattern(path, requiredString(rule.source, 'source rule')),
  );
  if (matches.length !== 1) {
    throw new Error(`${label} must match exactly once: ${path} matched ${matches.length}.`);
  }
}

function validateArchitectureExceptions(manifest: Record<string, unknown>): number {
  const exceptions = objectArray(manifest.exceptions, 'architecture exceptions');
  const ids = new Set<string>();
  for (const exception of exceptions) {
    const id = requiredString(exception.id, 'architecture exception id');
    if (ids.has(id)) throw new Error(`Duplicate architecture exception: ${id}`);
    ids.add(id);
    requiredString(exception.owner, `${id} owner`);
    requiredString(exception.reason, `${id} reason`);
    requiredString(exception.importer, `${id} importer`);
    requiredString(exception.imported, `${id} imported`);
    requireRuntimeTask(exception.expiresAtTask, `${id} expiry task`);
  }
  return exceptions.length;
}

function requireRuntimeTask(value: unknown, label: string): string {
  const task = requiredString(value, label);
  if (!/^(?:RM-(?:0[1-9]|1[0-6])|RA-0[0-6])$/u.test(task)) {
    throw new Error(`${label} is not a Runtime Modularization task.`);
  }
  return task;
}

function assertSourceAnchorExists(root: string, anchor: string): void {
  const [path, symbol] = anchor.split('#', 2);
  if (!path || !isRegularFile(join(root, path)))
    throw new Error(`Missing production entry: ${anchor}`);
  if (symbol && !sourceDeclaresSymbol(join(root, path), symbol)) {
    throw new Error(`Missing production symbol: ${anchor}`);
  }
}

function sourceDeclaresSymbol(path: string, symbol: string): boolean {
  if (!isRegularFile(path)) return false;
  const source = parsedSource(path);
  return source.statements.some((statement) => {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name?.text === symbol
    ) {
      return true;
    }
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === symbol,
      )
    ) {
      return true;
    }
    if (!ts.isExportDeclaration(statement) || !statement.exportClause) return false;
    if (!ts.isNamedExports(statement.exportClause)) return false;
    return statement.exportClause.elements.some(
      (element) => element.name.text === symbol || element.propertyName?.text === symbol,
    );
  });
}

function parsedSource(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function importedSpecifiers(path: string): string[] {
  const source = parsedSource(path);
  const imports: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

function filesMatching(root: string, pattern: string): string[] {
  if (pattern.endsWith('/**')) {
    const directory = join(root, pattern.slice(0, -3));
    return sourceFiles(directory);
  }
  const path = join(root, pattern);
  return isRegularFile(path) ? [path] : [];
}

function matchesPattern(path: string, pattern: string): boolean {
  const normalizedPath = normalizeRepositoryPath(path);
  const normalizedPattern = normalizeRepositoryPath(pattern);
  return normalizedPattern.endsWith('/**')
    ? normalizedPath.startsWith(normalizedPattern.slice(0, -2))
    : normalizedPath === normalizedPattern;
}

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) return sourceFiles(path);
      return entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name) ? [path] : [];
    })
    .sort();
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function objectArray(value: unknown, label: string): Record<string, unknown>[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))
  ) {
    throw new Error(`${label} must be an object array.`);
  }
  return value as Record<string, unknown>[];
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be a string array.`);
  }
  return value as string[];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeRepositoryPath))].sort();
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const result = new Map<string, T>();
  for (const value of values) result.set(key(value), value);
  return [...result.values()];
}

function normalizeRepositoryPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//u, '');
  return normalized === '' ? '.' : normalized;
}

function normalizedRelative(root: string, path: string): string {
  const result = normalizeRepositoryPath(relative(root, path));
  if (result === '..' || result.startsWith('../')) throw new Error('Path escaped repository root.');
  return result;
}

function assertInsideRoot(root: string, path: string): void {
  if (!isInsideRoot(root, path)) throw new Error('Path escaped repository root.');
}

function isInsideRoot(root: string, path: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

function isRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}
