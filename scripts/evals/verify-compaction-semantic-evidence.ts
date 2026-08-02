import { readFileSync, writeFileSync } from 'node:fs';
import {
  semanticEvaluationProducerInputV1Schema,
  semanticExpectedIdentityV1,
  semanticSourceIdentityFromEnvironmentV1,
  verifySemanticEvaluationEvidenceV1,
  verifyTrackedSemanticInputSnapshotV1,
} from './contracts/compaction-semantic-evidence';

const evidencePath = requiredArgument('--evidence');
const expectationInputPath = requiredArgument('--expectation-input');
const outputPath = requiredArgument('--output');
const evidence: unknown = JSON.parse(readFileSync(evidencePath, 'utf8'));
const producerInput = semanticEvaluationProducerInputV1Schema.parse(
  JSON.parse(readFileSync(expectationInputPath, 'utf8')),
);
const sourceIdentity = semanticSourceIdentityFromEnvironmentV1(process.env);
verifyTrackedSemanticInputSnapshotV1(expectationInputPath, sourceIdentity);
const expected = semanticExpectedIdentityV1({ producerInput, sourceIdentity });
const verification = verifySemanticEvaluationEvidenceV1({ evidence, expected });

writeFileSync(outputPath, `${JSON.stringify(verification, null, 2)}\n`, {
  encoding: 'utf8',
  flag: 'wx',
});
process.stdout.write(`${JSON.stringify(verification)}\n`);

function requiredArgument(name: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`Missing required argument: ${name}`);
  return value;
}
