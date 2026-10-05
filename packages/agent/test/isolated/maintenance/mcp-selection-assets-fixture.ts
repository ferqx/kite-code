import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  acquireProfileAccess,
  acquireProfileDataLock,
  selectProfile,
} from '../../../src/platform/profile';

const repository = new URL('../../../../../', import.meta.url).pathname;
export type SelectionRecord = {
  intent: {
    sessionId: string;
    workspaceId: string;
    workspaceIdentity: string;
    request: {
      expectedStoreId: string;
      commandId: string;
      kind: string;
      extensionId: string;
      actionId: string;
      definitionVersion: string;
      input: {
        serverId: string;
        enabled: boolean;
        scope: string;
        queryAdmission: string;
        expectedReadSet: {
          userEtag: string;
          workspaceEtag: string | null;
          explicitDigest: string;
          registryDigest: string;
          registryRevision: string;
          scopeDigest: string;
        };
      };
    };
  };
  subjectId: string;
  bodySha256: string;
  requestSha256: string;
  phase: string;
};
export async function seedMcpSelectionAssets(
  profile: { dataRoot: string; profile: string },
  storeId: string,
  count = 2,
): Promise<SelectionRecord[]> {
  // Test-only dynamic owner imports do not enter Agent's production dependency graph.
  const { openMcpSelectionJournal } = await import(
    join(repository, 'apps/cli/host/mcp-selection-journal.ts')
  );
  const { createMcpSelectionRecord } = await import(
    join(repository, 'apps/cli/host/mcp-selection-intents.ts')
  );
  const access = acquireProfileAccess(profile);
  let journal: ReturnType<typeof openMcpSelectionJournal> | undefined;
  try {
    journal = openMcpSelectionJournal({
      access,
      acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
    });
    for (let i = 0; i < count; i++) {
      const scope = count === 2 && i === 0 ? 'user' : 'workspace';
      const record = createMcpSelectionRecord(
        {
          sessionId: 'original_session',
          workspaceId: `original_workspace_${i}`,
          workspaceIdentity: '{"root":"/owned/原目录😀\\r\\n","dev":"1","ino":"2"}',
          request: {
            expectedStoreId: storeId,
            commandId: `original_mcp_${i}`,
            kind: 'extension.invoke',
            extensionId: 'builtin.mcp.management',
            actionId: 'mcp.server.select',
            definitionVersion: '1',
            input: {
              serverId: `original_server_${i}`,
              enabled: i % 2 === 0,
              scope,
              expectedReadSet: {
                userEtag: 'a'.repeat(64),
                workspaceEtag: scope === 'workspace' ? 'b'.repeat(64) : null,
                explicitDigest: 'c'.repeat(64),
                registryDigest: 'd'.repeat(64),
                scopeDigest: 'e'.repeat(64),
                registryRevision: '原快照 é e\u0301 😀\r\nEND',
              },
            },
          },
        },
        'original_subject_原主体😀',
      );
      journal.prepare(record);
      journal.record(record, scope === 'user' ? 'failed' : 'outcome_unknown');
    }
    return journal.list() as SelectionRecord[];
  } finally {
    try {
      journal?.close();
    } finally {
      access.lock.release();
    }
  }
}
export async function coldNodeMcpAssets(
  root: string,
  profile: { dataRoot: string; profile: string },
  currentStoreId: string,
) {
  const directory = join(root, 'node-mcp-assets');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const source = join(directory, 'reader.ts');
  writeFileSync(
    source,
    `
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseMcpSelectionRecord} from ${JSON.stringify(join(repository, 'apps/cli/host/mcp-selection-intents.ts'))};
const input=JSON.parse(process.argv[2]);
let getRequests=0,postRequests=0;
globalThis.fetch=async(_url,init)=>{if((init?.method??'GET')==='GET')getRequests++;else postRequests++;throw Error('owned_metadata_http_forbidden');};
const bytes=readFileSync(input.path);
const doc=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
if(doc.version!==1||!Array.isArray(doc.records))throw Error('owned_document_invalid');
const records=doc.records.map(parseMcpSelectionRecord);
// This cold metadata fixture rejects foreign scope before any GET. It is not a receipt verifier.
const foreign=records.some(r=>r.intent.request.expectedStoreId!==input.currentStoreId);
const queryAdmission=foreign?'unavailable_foreign_store':'unattempted';
console.log(JSON.stringify({records,scope:foreign?'foreign':'original',queryAdmission,getRequests,postRequests,byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}));
`,
    { mode: 0o600 },
  );
  const build = await Bun.build({
    entrypoints: [source],
    target: 'node',
    packages: 'bundle',
    outdir: directory,
    naming: 'reader.mjs',
  });
  if (!build.success) throw new AggregateError(build.logs, 'owned_mcp_node_reader_build');
  const node = Bun.which('node');
  if (!node) throw Error('owned_node_unavailable');
  const access = acquireProfileAccess(profile);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const holder = Bun.spawn(
      [
        node,
        join(directory, 'reader.mjs'),
        JSON.stringify({
          path: join(selectProfile(profile).profilePath, 'ui/mcp-selection-intents.json'),
          currentStoreId,
        }),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    child = holder;
    timer = setTimeout(() => holder.kill('SIGKILL'), 10000);
    const [exit, stdout, stderr] = await Promise.all([
      holder.exited,
      new Response(holder.stdout).text(),
      new Response(holder.stderr).text(),
    ]);
    if (exit !== 0) throw Error(`owned_mcp_node_reader_failed:${stderr}`);
    return JSON.parse(stdout) as {
      records: SelectionRecord[];
      scope: string;
      queryAdmission: string;
      getRequests: number;
      postRequests: number;
      byteLength: number;
      sha256: string;
    };
  } finally {
    if (timer) clearTimeout(timer);
    try {
      if (child?.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
    } finally {
      access.lock.release();
    }
  }
}
