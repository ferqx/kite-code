import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { ownedUserConfiguration } from '../../../service/test/fixtures/user-configuration-fixture';
import type { CLIServiceArtifact } from '../../host';
import { buildOwnedDaemon } from './daemon-host-build';

/** Built ordinary host fixture; Planning tests supply their own controlled model. */
export async function planningProfile() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-planning-profile-')));
  const workspace = join(root, 'workspace');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  const userConfiguration = ownedUserConfiguration(join(root, 'home'));
  mkdirSync(workspace);
  privateDirectory(join(profile.profilePath, 'ui'));
  writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
    mode: 0o600,
  });
  const requests: Record<string, unknown>[] = [],
    titleRequests: Record<string, unknown>[] = [];
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as Record<string, unknown>);
      throw Error('planning_fixture_requires_its_original_model');
    },
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    provider.stop(true);
    if (realpathSync(root) !== root) throw Error('planning_profile_cleanup_scope_changed');
    rmSync(root, { recursive: true });
  };
  try {
    writeFileSync(
      userConfiguration.path,
      JSON.stringify({
        modelId: 'fixed',
        tools: [],
        models: [
          {
            id: 'fixed',
            provider: 'compatible',
            model: 'fixed',
            baseURL: `${provider.url.href}v1`,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const artifactRoot = join(root, 'artifact');
    await buildOwnedDaemon(artifactRoot);
    const entrypoint = join(artifactRoot, 'node_modules/@kite-ai/service/main.js');
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const artifact: CLIServiceArtifact = {
      entrypoint,
      entrypointSha256: hash(entrypoint),
      executable: realpathSync(process.execPath),
      executableSha256: hash(process.execPath),
      buildId: 'owned-planning',
      apiMajor: 1,
    };
    return {
      root,
      workspace,
      profile,
      artifact,
      requests,
      titleRequests,
      userConfiguration,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
