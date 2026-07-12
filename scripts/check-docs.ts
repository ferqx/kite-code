import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const activeDir = join(root, 'docs', 'active');
const requiredMetadata = ['状态：active', '读取时机：', '验证：'];
let failed = false;

function fail(message: string): void {
  failed = true;
  console.error(message);
}

if (!existsSync(activeDir)) {
  fail('docs/active/ is missing.');
} else {
  for (const entry of readdirSync(activeDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const path = join(activeDir, entry.name);
    const source = readFileSync(path, 'utf8');
    for (const field of requiredMetadata) {
      if (!source.includes(field)) fail(`${relative(root, path)} is missing ${field}`);
    }
  }
}

for (const directory of ['design', 'deprecated', 'adr']) {
  if (!existsSync(join(root, 'docs', directory))) fail(`docs/${directory}/ is missing.`);
}

if (failed) process.exitCode = 1;
else console.log('Documentation structure checks passed.');
