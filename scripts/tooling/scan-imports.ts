import ts from 'typescript';

export interface ScannedImport {
  readonly kind: 'import-statement' | 'dynamic-import' | 'require-call';
  readonly path: string;
}

/** Scan literal runtime specifiers. Type-only statements do not belong to the emitted graph. */
export function scanImports(source: string | Uint8Array, loader: 'js' | 'ts' | 'tsx' = 'js') {
  const text = typeof source === 'string' ? source : new TextDecoder().decode(source);
  const file = ts.createSourceFile(
    `input.${loader}`,
    text,
    ts.ScriptTarget.Latest,
    false,
    loader === 'js' ? ts.ScriptKind.JS : loader === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const imports: ScannedImport[] = [];
  const record = (kind: ScannedImport['kind'], value: ts.Node | undefined) => {
    if (value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)))
      imports.push({ kind, path: value.text });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly)
      record('import-statement', node.moduleSpecifier);
    else if (ts.isExportDeclaration(node) && !node.isTypeOnly)
      record('import-statement', node.moduleSpecifier);
    else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      record('require-call', node.moduleReference.expression);
    else if (ts.isCallExpression(node)) {
      const call = node.expression;
      if (call.kind === ts.SyntaxKind.ImportKeyword) record('dynamic-import', node.arguments[0]);
      else if (ts.isIdentifier(call) && call.text === 'require')
        record('require-call', node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return imports;
}
