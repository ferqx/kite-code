import { analyzeRuntimePackages } from './runtime-packages/check-runtime-packages';

const analysis = analyzeRuntimePackages(process.cwd());
if (analysis.violations.length > 0) {
  console.error('runtime package gate failed');
  for (const violation of analysis.violations) {
    console.error(
      `[${violation.code}]${violation.path ? ` ${violation.path}:` : ''} ${violation.message}`,
    );
  }
  process.exit(1);
}

console.log('runtime package gate passed');
console.log(`packages=${analysis.packages.length}`);
console.log(`packageEdges=${analysis.packageEdges.length}`);
console.log(`compositionRoots=${analysis.compositionRoots.join(',')}`);
