import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  callerDigest,
  callerTarget,
  callerTextDigest,
  canonicalNativeCallerRequest,
} from '../electron/caller-journal';
import { openPrivateData } from '../electron/private-data';
import { acquireDesktopProfileAccess } from '../electron/profile-access';
import type { NativeCallerCommandRequest } from '../src/native-bridge';

const [profilePath, runtime, runtimeHash, helper, helperHash, storeId, sessionId] =
  process.argv.slice(2) as [string, string, string, string, string, string, string];
const access = await acquireDesktopProfileAccess({
  profile: { dataRoot: join(profilePath, '..'), profile: 'default' },
  bunExecutable: runtime,
  bunSha256: runtimeHash,
  helperPath: helper,
  helperSha256: helperHash,
});
const data = openPrivateData(profilePath, access);
try {
  const scope = { storeId, sessionId, workspaceId: 'native-version-workspace' };
  const request: NativeCallerCommandRequest = {
    kind: 'extension.invoke',
    expectedStoreId: storeId,
    commandId: 'legacy-db9-original',
    extensionId: 'fixture.mini-review',
    actionId: 'fixture.mini-review.analyze',
    definitionVersion: '1',
    input: {
      businessKey: 'legacy-db9-unknown',
      sourceRunId: 'not-dispatched',
      sourceExecutionId: 'not-dispatched',
    },
  };
  const result = data.beginCaller({
    intent: {
      scope,
      subjectId: 'local-user',
      request,
      target: callerTarget(scope, request),
      bodyDigest: callerDigest(request),
      requestDigest: callerTextDigest(canonicalNativeCallerRequest(request)),
    },
    phase: 'submitting',
  });
  assert.equal(result.created, true);
  data.finishCaller(request.commandId, 'unknown');
  assert.equal(data.callers()[0]!.phase, 'unknown');
} finally {
  data.close();
  access.close();
}
assert.equal(readFileSync(join(profilePath, 'desktop-private/data.sqlite')).readUInt32BE(60), 9);
console.log(JSON.stringify({ privateVersion: 9, dispatched: false }));
