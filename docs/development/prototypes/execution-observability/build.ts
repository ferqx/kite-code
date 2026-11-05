import { readFile, writeFile } from 'node:fs/promises';
import { createLoopOverview } from './loop-flows';

const directory = new URL('./', import.meta.url);
const [template, snapshot] = await Promise.all([
  readFile(new URL('prototype.template.html', directory), 'utf8'),
  readFile(new URL('evidence.json', directory), 'utf8'),
]);
const evidence = JSON.parse(snapshot);
if (evidence.schemaVersion !== 1 || !Array.isArray(evidence.cases) || !evidence.cases.length)
  throw new Error('Invalid execution evidence snapshot');
const marker = '"__EVIDENCE_JSON__"';
if (template.split(marker).length !== 2) throw new Error('Expected one evidence placeholder');
// JSON stays inert in a script data block, including user-controlled message text.
const safeJson = JSON.stringify(evidence).replace(/</g, '\\u003c');
const flowMarker = '/*__LOOP_FLOW_FACTORY__*/';
const flowSource = createLoopOverview.toString();
if (template.split(flowMarker).length !== 2 || /<\/script/i.test(flowSource))
  throw new Error('Invalid Loop flow factory embedding');
const output = new URL('index.html', directory);
await writeFile(
  output,
  template.replace(marker, () => safeJson).replace(flowMarker, () => flowSource),
);
console.log(`Built ${output.pathname}: ${evidence.cases.length} readonly evidence cases`);
