import { readFileSync, writeFileSync } from 'node:fs';
import {
  produceSemanticEvaluationEvidenceV1,
  semanticEvaluationProducerInputV1Schema,
  semanticSourceIdentityFromEnvironmentV1,
  verifyTrackedSemanticInputSnapshotV1,
} from './contracts/compaction-semantic-evidence';

const inputPath = requiredArgument('--input');
const outputPath = requiredArgument('--output');
const producerInput = semanticEvaluationProducerInputV1Schema.parse(
  JSON.parse(readFileSync(inputPath, 'utf8')),
);
const sourceIdentity = semanticSourceIdentityFromEnvironmentV1(process.env);
verifyTrackedSemanticInputSnapshotV1(inputPath, sourceIdentity);
const evidence = produceSemanticEvaluationEvidenceV1({ producerInput, sourceIdentity });

writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
  encoding: 'utf8',
  flag: 'wx',
});
process.stdout.write(
  `${JSON.stringify({
    status: 'candidate_created',
    evidenceEligible: false,
    outputPath,
    payloadDigest: evidence.payloadDigest,
  })}\n`,
);

function requiredArgument(name: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`Missing required argument: ${name}`);
  return value;
}
