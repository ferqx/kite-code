import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Violation {
  check: string;
  file: string;
  line: number;
  text: string;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function find(
  check: string,
  root: string,
  pattern: RegExp,
  except: (file: string) => boolean = () => false,
): Violation[] {
  return sourceFiles(root).flatMap((file) => {
    if (except(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((text, index) =>
        pattern.test(text) ? [{ check, file, line: index + 1, text: text.trim() }] : [],
      );
  });
}

const root = process.cwd();
const violations = [
  ...find('core must not import app', join(root, 'src/core'), /from\s+['"]@\/app\//),
  ...find(
    'tool execution must use an approved entry point',
    join(root, 'src/core'),
    /\brunApprovedTool\(/,
    (file) =>
      file.endsWith('/harness/tool-runner.ts') ||
      file.endsWith('/controllers/tool-controller.ts') ||
      file.endsWith('/subagent/runner.ts'),
  ),
  ...find(
    'planning state is reducer-owned',
    join(root, 'src/core'),
    /state\.planning\s*=/,
    (file) => file.endsWith('/runtime/reducer.ts') || file.endsWith('/runtime/state.ts'),
  ),
];

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`${violation.check}: ${violation.file}:${violation.line} ${violation.text}`);
  }
  process.exitCode = 1;
} else {
  console.log('Core boundary checks passed.');
}
