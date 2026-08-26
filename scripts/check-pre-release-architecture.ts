import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dir, '..');
const violations: string[] = [];
const packageSources = readdirSync(join(root, 'packages'))
  .map((name) => join(root, 'packages', name, 'src'))
  .filter(existsSync);
const productionRoots = [
  join(root, 'apps/kite-cli/src'),
  ...packageSources,
  join(root, 'native'),
].filter(existsSync);
const versionedPath = /(?:^|[/_.-])(?:v\d+|state\d+|store\d+|rmv\d+|rav\d+)(?:[/_.-]|$)/iu;
const versionedEntity = /(?:V\d+|State\d+|Store\d+|RMV\d+|RAV\d+)/iu;
const historicalReadEntity = /(?:Legacy|Compat)/u;
const oldRuntimePath = /\.runtime-(?:v\d+|state\d+-store\d+)\.db/iu;
const sqliteFormatBranch = /\b(?:targetFormat|formatProfile|compatibilityMode|legacyStore)\b/u;
const removedProductionNames =
  /\b(?:promptContract|project_legacy|user_legacy|project_mcp_json|project_kite_code|migrate_legacy|ClientPresentationEvent|localMcpConfigPath|LegacyToolContractSection|RuntimeSessionStoragePort|StateSessionStorage)\b/u;
const implementationTaskIdentity = /\b(?:rmv\d+|rav\d+)\b/iu;

function directNamedExports(path: string): ReadonlySet<string> {
  const source = readFileSync(join(root, path), 'utf8');
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const specifier of statement.exportClause.elements) names.add(specifier.name.text);
    }
  }
  return names;
}

const builtinDomainImports = new Map<string, ReadonlySet<string>>([
  [
    '@kite-ai/builtin-runtime/skills',
    new Set([
      'SkillActivationEvaluation',
      'SkillActivationRequest',
      'evaluateSkillActivation',
      'skillFrameInvalidationReason',
      'CompiledCapabilitySchema',
      'canonicalizeCapabilityArguments',
      'compileCapabilitySchema',
      'createCapabilitySnapshot',
      'RefreshSkillCatalogOptions',
      'SkillCatalogEntry',
      'SkillCatalogSnapshot',
      'createSkillCapabilityResolver',
      'refreshSkillCatalog',
      'SkillActivationContext',
      'SkillLifecycleContext',
      'SkillLifecycleEmission',
      'activateSkillLifecycle',
      'completeSkillLifecycle',
      'readSkillReference',
      'SkillRuntimeEvent',
      'verificationRequestForSkill',
      'SkillManifest',
      'SkillScanOptions',
      'CompiledSkillWorkflow',
      'CompileSkillWorkflowInput',
      'SkillWorkflowContract',
      'compileSkillWorkflow',
    ]),
  ],
  [
    '@kite-ai/builtin-runtime/verification',
    new Set([
      'BuiltinCapabilityVerificationRequest',
      'createBuiltinCapabilityVerificationRequest',
      'validateBuiltinVerificationSpec',
      'BuiltinDeterministicVerificationDependencies',
      'BuiltinVerificationDispatchError',
      'BuiltinVerificationMcpPort',
      'BuiltinVerificationReceiptView',
      'BuiltinVerificationShellPort',
      'BuiltinVerificationStateView',
      'executeDeterministicVerificationChecks',
      'BuiltinModelExecutionMechanism',
      'VerificationExecutionMechanisms',
      'VerificationOperationId',
      'createVerificationRuntimeModule',
      'VERIFICATION_CAPABILITY_REVISIONS_',
      'VERIFICATION_EXECUTOR_REVISIONS_',
      'VERIFICATION_OPERATION_IDS_',
      'VERIFICATION_PROVIDER_ID_',
    ]),
  ],
  [
    '@kite-ai/builtin-runtime/subagent',
    directNamedExports('packages/builtin-runtime/src/subagent/index.ts'),
  ],
]);
const runtimeHostKernelAdapterExports = directNamedExports(
  'packages/runtime-host/src/kernel-adapter/index.ts',
);

function declarationName(node: ts.Node): ts.Identifier | undefined {
  if (
    ts.isVariableDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node)
  ) {
    return node.name && ts.isIdentifier(node.name) ? node.name : undefined;
  }
  return undefined;
}

function isVersionedEntity(name: string): boolean {
  const withoutAlgorithmNames = name.replace(/IPv[46]|SHA(?:1|256|512)/giu, '');
  return versionedEntity.test(withoutAlgorithmNames);
}

function ownsHistoricalSessionReadBoundary(relativePath: string): boolean {
  return (
    relativePath === 'packages/agent-kernel/src/state-migration.ts' ||
    relativePath === 'packages/agent-kernel/src/state-codec.ts' ||
    relativePath === 'packages/agent-kernel/src/index.ts' ||
    relativePath === 'packages/runtime-host/src/storage/index.ts' ||
    relativePath === 'packages/runtime-host/src/format/storage-binding.ts' ||
    relativePath === 'packages/runtime-storage-sqlite/src/compatibility.ts' ||
    relativePath === 'packages/runtime-storage-sqlite/src/index.ts' ||
    relativePath === 'apps/kite-cli/src/bootstrap/runtime/state-store-compatibility.ts' ||
    relativePath === 'apps/kite-cli/src/runtime-client/history-adapter.ts' ||
    relativePath === 'apps/kite-cli/src/bootstrap.ts'
  );
}

function inspectSource(path: string): void {
  const relativePath = relative(root, path);
  const source = readFileSync(path, 'utf8');
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const visitNode = (node: ts.Node): void => {
    const name = declarationName(node);
    if (
      name &&
      (isVersionedEntity(name.text) || historicalReadEntity.test(name.text)) &&
      !ownsHistoricalSessionReadBoundary(relativePath)
    ) {
      const position = sourceFile.getLineAndCharacterOfPosition(name.getStart(sourceFile));
      violations.push(
        `${relativePath}:${position.line + 1}: versioned production entity ${name.text}`,
      );
    }
    if (
      relativePath.startsWith('apps/kite-cli/src/runtime/') &&
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /(?:^|[/#])tui(?:[/]|$)/u.test(node.moduleSpecifier.text)
    ) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push(`${relativePath}:${position.line + 1}: App Runtime imports TUI`);
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === '@kite-ai/builtin-runtime' &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const specifier of node.importClause.namedBindings.elements) {
        const imported = specifier.propertyName?.text ?? specifier.name.text;
        const domain = [...builtinDomainImports].find(([, names]) => names.has(imported))?.[0];
        if (!domain) continue;
        const position = sourceFile.getLineAndCharacterOfPosition(specifier.getStart(sourceFile));
        violations.push(
          `${relativePath}:${position.line + 1}: import ${imported} from ${domain} instead of the root barrel`,
        );
      }
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === '@kite-ai/runtime-host' &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const specifier of node.importClause.namedBindings.elements) {
        const imported = specifier.propertyName?.text ?? specifier.name.text;
        if (!runtimeHostKernelAdapterExports.has(imported)) continue;
        const position = sourceFile.getLineAndCharacterOfPosition(specifier.getStart(sourceFile));
        violations.push(
          `${relativePath}:${position.line + 1}: import ${imported} from @kite-ai/runtime-host/kernel-adapter instead of the root barrel`,
        );
      }
    }
    ts.forEachChild(node, visitNode);
  };
  visitNode(sourceFile);
  if (oldRuntimePath.test(source)) violations.push(`${relativePath}: obsolete Runtime Store path`);
  if (removedProductionNames.test(source)) {
    violations.push(`${relativePath}: removed compatibility name is present`);
  }
  if (implementationTaskIdentity.test(source)) {
    violations.push(`${relativePath}: implementation task identity is present`);
  }
  if (
    relativePath.startsWith('packages/runtime-storage-sqlite/src/') &&
    sqliteFormatBranch.test(source)
  ) {
    violations.push(`${relativePath}: SQLite format-selection or compatibility branch`);
  }
  if (
    relativePath.startsWith('apps/kite-cli/src/') &&
    /\.sessions\.deleteSession\s*\(/u.test(source)
  ) {
    violations.push(`${relativePath}: App may not delete Runtime Store sessions directly`);
  }
}

function visit(path: string): void {
  const entry = statSync(path);
  if (entry.isDirectory()) {
    for (const child of readdirSync(path)) {
      if (child === 'node_modules' || child === 'dist' || child === 'test' || child === 'tests') {
        continue;
      }
      visit(join(path, child));
    }
    return;
  }
  const relativePath = relative(root, path);
  if (versionedPath.test(relativePath)) {
    violations.push(`${relativePath}: versioned production path`);
  }
  if (/\.(?:ts|tsx|js|jsx)$/.test(path)) inspectSource(path);
}

for (const path of productionRoots) visit(path);

const activeDocsRoot = join(root, 'docs/active');
for (const name of readdirSync(activeDocsRoot)) {
  if (!name.endsWith('.md')) continue;
  const source = readFileSync(join(activeDocsRoot, name), 'utf8');
  if (/\b(?:State|Store|RMV|RAV)\d+\b/u.test(source)) {
    violations.push(`docs/active/${name}: versioned entity in active documentation`);
  }
  if (oldRuntimePath.test(source)) {
    violations.push(`docs/active/${name}: obsolete Runtime Store path in active documentation`);
  }
}

const compositionRoots = ['apps/kite-cli/src/bootstrap.ts'].filter((path) =>
  existsSync(join(root, path)),
);
if (compositionRoots.length !== 1) violations.push('composition root count is not exactly one');

const requiredDomainFiles = [
  'packages/runtime-contract/src/commands.ts',
  'packages/runtime-contract/src/queries.ts',
  'packages/runtime-contract/src/notifications.ts',
  'packages/runtime-contract/src/projections.ts',
  'packages/runtime-protocol/src/codecs.ts',
  'packages/runtime-protocol/src/limits.ts',
  'packages/runtime-protocol/src/mappers.ts',
  'packages/runtime-server/src/server.ts',
  'packages/runtime-server/src/in-process.ts',
  'packages/runtime-client/src/index.ts',
  'packages/runtime-client/src/store.ts',
  'packages/runtime-spi/src/capability.ts',
  'packages/runtime-spi/src/execution.ts',
  'packages/runtime-spi/src/model.ts',
  'packages/runtime-spi/src/modules.ts',
  'packages/agent-kernel/src/domains/planning/state.ts',
  'packages/agent-kernel/src/domains/context/state.ts',
  'packages/agent-kernel/src/domains/context/events.ts',
  'packages/agent-kernel/src/domains/verification/state.ts',
  'packages/agent-kernel/src/domains/verification/events.ts',
  'packages/agent-kernel/src/approval-queue.ts',
  'packages/agent-kernel/src/core/authorization/reducer.ts',
  'packages/runtime-host/src/host/runtime-host.ts',
  'packages/runtime-host/src/host/session-registry.ts',
  'packages/runtime-host/src/execution/tool-pipeline-coordinator.ts',
  'packages/runtime-host/src/kernel-adapter/tool-governance.ts',
  'packages/runtime-host/src/kernel-adapter/index.ts',
  'packages/runtime-host/src/format/storage-binding.ts',
  'packages/runtime-host/src/process/posix-supervisor.ts',
  'packages/builtin-runtime/src/git/runtime-module.ts',
  'packages/builtin-runtime/src/model/runtime-module.ts',
  'packages/builtin-runtime/src/planning/runtime-module.ts',
  'packages/builtin-runtime/src/subagent/runtime-module.ts',
  'packages/builtin-runtime/src/subagent/index.ts',
  'packages/builtin-runtime/src/verification/runtime-module.ts',
  'apps/kite-cli/src/runtime/session/session-registry.ts',
  'apps/kite-cli/src/runtime/session/session-lifecycle.ts',
  'apps/kite-cli/src/runtime/session/rewind-service.ts',
  'apps/kite-cli/src/runtime/session/planning-mode-service.ts',
  'apps/kite-cli/src/runtime/session/context-compaction-service.ts',
  'apps/kite-cli/src/runtime/session/session-projection.ts',
  'apps/kite-cli/src/adapters/tui/session-adapter.ts',
  'apps/kite-cli/src/runtime/tool-execution/router.ts',
  'apps/kite-cli/src/runtime/tool-execution/builtin-executor.ts',
  'apps/kite-cli/src/runtime/tool-execution/mcp-executor.ts',
  'apps/kite-cli/src/runtime/tool-execution/subagent-executor.ts',
  'apps/kite-cli/src/runtime/tool-execution/skill-executor.ts',
  'apps/kite-cli/src/runtime/tool-execution/terminal-projection.ts',
  'apps/kite-cli/src/runtime/tool-persistence/attempt-recorder.ts',
  'apps/kite-cli/src/runtime/tool-persistence/acknowledgement-validator.ts',
  'apps/kite-cli/src/runtime/tool-persistence/receipt-committer.ts',
  'apps/kite-cli/src/runtime/tool-persistence/filesystem-evidence.ts',
  'apps/kite-cli/src/runtime/tool-persistence/filesystem-mutation.ts',
  'apps/kite-cli/src/runtime/tool-persistence/subagent-suspension.ts',
  'apps/kite-cli/src/runtime/tool-persistence/terminal-event-projector.ts',
  'apps/kite-cli/src/runtime/tool-persistence/recovery-committer.ts',
  'packages/runtime-storage-sqlite/src/schema.ts',
  'packages/runtime-storage-sqlite/src/connection.ts',
  'packages/runtime-storage-sqlite/src/event-store.ts',
  'packages/runtime-storage-sqlite/src/session-store.ts',
  'packages/runtime-storage-sqlite/src/snapshot-store.ts',
  'packages/runtime-storage-sqlite/src/artifact-store.ts',
  'packages/runtime-storage-sqlite/src/effect-leases.ts',
  'packages/runtime-storage-sqlite/src/authority-ledger.ts',
  'packages/runtime-storage-sqlite/src/transaction.ts',
];
for (const path of requiredDomainFiles) {
  if (!existsSync(join(root, path))) violations.push(`${path}: required domain module is missing`);
}

if (violations.length > 0) {
  console.error('pre-release architecture gate failed');
  for (const violation of violations) console.error(`[ARCHITECTURE] ${violation}`);
  process.exit(1);
}
console.log('pre-release architecture gate passed');
