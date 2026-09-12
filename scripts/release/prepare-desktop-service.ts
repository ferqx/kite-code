import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { kiteAppServerVersion } from '@kite-ai/kite-local-runtime/client';
import { selectKiteServiceEnvironmentSource } from './local-service-client';
import { buildOssCandidate, verifyOssCandidate } from './oss-candidate';

// Keep candidate construction and verification with the release owner. The
// macOS stdio service needs no Web payload, CLI, TUI or daemon launcher.
if (process.platform !== 'darwin')
  throw new Error('Desktop service packaging is currently implemented only for macOS development.');
process.chdir(resolve(import.meta.dir, '../..'));
const archive = process.argv[2];
const candidate = archive ? await verifyOssCandidate(resolve(archive)) : await buildOssCandidate();
if (
  candidate.manifest.target.os !== process.platform ||
  candidate.manifest.target.arch !== process.arch
)
  throw new Error('Desktop service target must match this host.');
const entry = candidate.manifest.releaseSlots.service;
if (!entry.entrypoint || !entry.identity) throw new Error('Candidate has no paired service.');
const bytes = candidate.files.get(entry.entrypoint);
if (!bytes) throw new Error('Verified candidate service is missing.');
const directory = resolve('apps/kite-desktop/service');
mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory, 'kite-service'), bytes);
chmodSync(resolve(directory, 'kite-service'), 0o755);
writeFileSync(
  resolve(directory, 'desktop.json'),
  `${JSON.stringify(
    {
      buildId: candidate.candidateId,
      environmentKeys: Object.keys(selectKiteServiceEnvironmentSource({})),
      executableSha256: entry.identity.replace(/^sha256:/, ''),
      expectedServerVersion: kiteAppServerVersion(candidate.candidateId),
    },
    null,
    2,
  )}\n`,
);
console.log(`Prepared verified service candidate ${candidate.candidateId}.`);
