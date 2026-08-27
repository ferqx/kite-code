import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  currentOssReleaseTarget,
  type OssReleaseTarget,
  ossCandidateManifestSchema,
  writeOssCandidateArchive,
} from '../../../scripts/release/oss-candidate';

export async function createOssCandidateFixture(
  version: string,
  target: OssReleaseTarget = currentOssReleaseTarget(),
  stopOutcome: 'applied' | 'service_busy' = 'applied',
) {
  const root = mkdtempSync(join(tmpdir(), 'kite-oss-candidate-test-'));
  const archivePath = join(root, 'candidate.tar.gz');
  const cli = await fixtureCliBytes(root, target, stopOutcome);
  const suffix = target.executableSuffix;
  const files = new Map<string, Uint8Array>([
    [`bin/kite${suffix}`, cli],
    [`bin/kite-tui${suffix}`, bytes('#!/bin/sh\necho Kite TUI\n')],
    [`bin/kite-service${suffix}`, bytes('#!/bin/sh\necho Kite Service\n')],
    ['docs/MAINTAINER_CHECKLIST.md', bytes('# Checklist\n')],
    ['docs/KNOWN_LIMITATIONS.md', bytes('# Limitations\n')],
    ['docs/RELEASE_NOTES.md', bytes('# Notes\n')],
  ]);
  const manifest = ossCandidateManifestSchema.parse({
    schema: 'KiteCodeOssCandidateManifest',
    version: 1,
    productVersion: version,
    commitSha: 'a'.repeat(40),
    sourceDate: '2026-08-04T00:00:00.000Z',
    sourceDirty: false,
    bunVersion: '1.4.0',
    target: {
      id: target.id,
      os: target.os,
      arch: target.arch,
      compileMode: 'native',
    },
    integrity: 'sha256-only-unsigned',
    defaultCapabilities: {
      autoCompaction: 'off',
      effectfulCapabilities: 'off',
      remoteTelemetry: 'off',
    },
    files: [...files]
      .map(([path, value]) => ({ path, size: value.byteLength, sha256: digest(value) }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  });
  await writeOssCandidateArchive({ archivePath, manifest, files });
  return { root, archivePath, manifest, files };
}

async function fixtureCliBytes(
  root: string,
  target: OssReleaseTarget,
  stopOutcome: 'applied' | 'service_busy',
): Promise<Uint8Array> {
  if (target.os !== 'win32' || process.platform !== 'win32') {
    return bytes(
      stopOutcome === 'applied'
        ? '#!/bin/sh\nif [ "$1" = "service" ] && [ "$2" = "status" ]; then echo \'{"outcome":"applied","state":"absent"}\'; elif [ "$1" = "service" ] && [ "$2" = "stop" ]; then echo stopped; else echo Kite; fi\n'
        : '#!/bin/sh\nif [ "$1" = "service" ] && [ "$2" = "status" ]; then echo \'{"outcome":"service_busy","state":"ready"}\'; elif [ "$1" = "service" ] && [ "$2" = "stop" ]; then echo busy; exit 1; else echo Kite; fi\n',
    );
  }

  const entrypoint = join(root, 'fixture-cli.ts');
  const executable = join(root, 'fixture-kite.exe');
  writeFileSync(
    entrypoint,
    `const args = process.argv.slice(1);\nif (args.includes('status')) console.log(${JSON.stringify(
      JSON.stringify(
        stopOutcome === 'applied'
          ? { outcome: 'applied', state: 'absent' }
          : { outcome: 'service_busy', state: 'ready' },
      ),
    )});\nelse if (args.includes('stop')) { console.log('${stopOutcome === 'applied' ? 'stopped' : 'busy'}'); process.exit(${stopOutcome === 'applied' ? 0 : 1}); }\nelse console.log('Kite');\n`,
  );
  const built = await Bun.build({
    entrypoints: [entrypoint],
    compile: { outfile: executable, autoloadDotenv: false, autoloadBunfig: false },
    minify: true,
  });
  if (!built.success) throw new Error('Windows release fixture CLI compilation failed.');
  return new Uint8Array(readFileSync(executable));
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function digest(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
