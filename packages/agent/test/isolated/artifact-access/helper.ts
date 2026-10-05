import { fstatSync } from 'node:fs';
import {
  acquireArtifactAccess,
  acquireInheritedArtifactAccess,
} from '../../../src/artifact-access';

const [mode, root] = process.argv.slice(2);
try {
  const lock =
    mode === 'exclusive'
      ? acquireArtifactAccess({ root: root!, mode: 'exclusive' })
      : acquireInheritedArtifactAccess({ root: root!, fd: 3 });
  const identity = { path: lock.path, mode: lock.mode };
  if (mode === 'hold') {
    console.log(JSON.stringify({ ok: true, ...identity }));
    setInterval(() => {}, 1000);
  } else {
    lock.release();
    lock.release();
    let closed = true;
    if (mode !== 'exclusive') {
      try {
        fstatSync(3);
        closed = false;
      } catch {}
    }
    console.log(JSON.stringify({ ok: true, closed, ...identity }));
  }
} catch (error) {
  let closed = true;
  if (mode !== 'exclusive') {
    try {
      fstatSync(3);
      closed = false;
    } catch {}
  }
  console.log(
    JSON.stringify({
      ok: false,
      closed,
      code: (error as { code?: string }).code ?? (error as Error).message,
    }),
  );
  process.exitCode = 75;
}
