import {
  currentOssReleaseTarget,
  defaultOssCandidateArchivePath,
  verifyOssCandidate,
} from './oss-candidate';

const archiveIndex = process.argv.indexOf('--archive');
const archivePath =
  archiveIndex >= 0
    ? process.argv[archiveIndex + 1]
    : defaultOssCandidateArchivePath(currentOssReleaseTarget());
if (!archivePath) throw new Error('--archive requires a path.');
const verified = await verifyOssCandidate(archivePath, currentOssReleaseTarget().id);
if (process.argv.includes('--require-clean-source') && verified.manifest.sourceDirty) {
  throw new Error('Candidate was built from a dirty source tree.');
}
const expectedCommit = process.env.KITE_EXPECTED_CANDIDATE_COMMIT;
if (expectedCommit && verified.manifest.commitSha !== expectedCommit) {
  throw new Error(
    `Candidate commit ${verified.manifest.commitSha} does not match expected ${expectedCommit}.`,
  );
}
console.log(
  JSON.stringify({
    status: 'verified',
    archive: verified.archivePath,
    archiveSha256: verified.archiveSha256,
    candidateId: verified.candidateId,
    target: verified.manifest.target.id,
    sourceDirty: verified.manifest.sourceDirty,
    integrity: verified.manifest.integrity,
  }),
);
