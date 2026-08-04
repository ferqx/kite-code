import { buildOssCandidate } from './oss-candidate';

const archiveIndex = process.argv.indexOf('--archive');
const archivePath = archiveIndex >= 0 ? process.argv[archiveIndex + 1] : undefined;
const built = await buildOssCandidate({ archivePath });
console.log(
  JSON.stringify({
    status: 'built',
    archive: built.archivePath,
    archiveSha256: built.archiveSha256,
    candidateId: built.candidateId,
    target: built.manifest.target.id,
    sourceDirty: built.manifest.sourceDirty,
    signed: false,
    published: false,
  }),
);
