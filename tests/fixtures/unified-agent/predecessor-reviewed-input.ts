import { createHash } from 'node:crypto';

/** Exact approved blobs only. No manifest/lock normalization and no source rewriting. */
export const REVIEWED_PREDECESSOR_COMMITS = {
  compatible: '4a4c0e440b2098e5b4ec58c5831452773b39228f',
  terminal_legacy: 'a2b6441fde28d9c0f895a26e6a9d2471d2b1b242',
  windows_legacy: '837a2b8cde946d70d00920941a1a3e5e7c684f5d',
} as const;
export type ReviewedPredecessorKind = keyof typeof REVIEWED_PREDECESSOR_COMMITS;
const responsesCommit = 'eeea65f5f2cc14f7fab76218cb9e9506ebbbc58e';
const nativeCommit = '9ff6904a0f49213f06c483a08615ff69f099720a';
const titleCommit = 'bcf70ce843463194ab91ca3938b9fa1375cb22bc';
export const REVIEWED_LIVE_TOOL_SCRIPT =
  '    "test:model:tools:live": "bun run tests/e2e/live/model/model-tools.live.ts",\n';
const reviewedCollaborationLiveScript =
  '    "test:model:collaboration:live": "bun run tests/e2e/live/model/collaboration.live.ts",\n';

// These six final raw inputs include only the named commits and the two exact live scripts.
// Both new resolved OpenAI blocks, all old resolved packages and every whitespace byte are pinned.
const reviewedInputs: Readonly<
  Record<
    string,
    {
      currentSha256: string;
      previousSha256: Readonly<Record<ReviewedPredecessorKind, string>>;
    }
  >
> = {
  'bun.lock': {
    currentSha256: '88fc585823e3b1f8402a282d17ce8e7abb849db67488bb6a3465169a7ec8053a',
    previousSha256: {
      compatible: 'cc1b2b43f874bca59043e4c2090675c2b0c4c4033d9d1cd19da95b5ffc67d6d1',
      terminal_legacy: 'abad6bbc5cad8a0b2ac5e7c53edb15c5ae2e4d1b5167e75be24de028ba1a4d8f',
      windows_legacy: 'abad6bbc5cad8a0b2ac5e7c53edb15c5ae2e4d1b5167e75be24de028ba1a4d8f',
    },
  },
  'package.json': {
    currentSha256: '4c7e7320475e5c030c4221e30f408bb21b290de5a4c73fcd830f5efb4f0e4a14',
    previousSha256: {
      compatible: 'ec897a40fed5f88c2cab423797efb6837f7a8564feb0ce8152e42737cdd1dc88',
      terminal_legacy: 'b71511f0e48a943b42d4c7fa9283ca9fadce83d710193cf4c2edbf246bf24b37',
      windows_legacy: 'b71511f0e48a943b42d4c7fa9283ca9fadce83d710193cf4c2edbf246bf24b37',
    },
  },
  'packages/ai/package.json': {
    currentSha256: 'b512d768a1bcab9cf681cd29d45074dc2dbd44ad8c2569e29dd5c431376678da',
    previousSha256: {
      compatible: '23b2972e1c42da86b8514f5b69750f29016634299588a872ff67092946150f54',
      terminal_legacy: '23b2972e1c42da86b8514f5b69750f29016634299588a872ff67092946150f54',
      windows_legacy: '23b2972e1c42da86b8514f5b69750f29016634299588a872ff67092946150f54',
    },
  },
  'packages/agent/package.json': {
    currentSha256: '6a70589f6d4add80433d44a4bc69305b7f78e7504cc4e0e6aea484566e8b7083',
    previousSha256: {
      compatible: 'eeb75457d1fa24a49a6d806710c0de6eef76f8af4743e8086b20e2dfeea7a8be',
      terminal_legacy: 'c903f7fd9e8d8c6b4cb96f32c40842da46e24d412c71a017b1924892bafcfe43',
      windows_legacy: '04e6ded336ad8c621a95f7260c1f68ec6e81963c3ef950af1bf73a34278c86ee',
    },
  },
  'packages/ui/package.json': {
    currentSha256: 'fe81d519d0363dcf6fe1b1c34ad0193fa25786f6db298da3520facbd95fc1349',
    previousSha256: {
      compatible: 'f2ef2bdb1eca663e29c5f05b1fd595bab911287136a2a698956e3d2aa90b2411',
      terminal_legacy: '9ba1e4dbafb542ab2ff9644e90fbd2c2c63b5a5e306cf8b90b41344b07f2b81b',
      windows_legacy: '9ba1e4dbafb542ab2ff9644e90fbd2c2c63b5a5e306cf8b90b41344b07f2b81b',
    },
  },
  'apps/service/package.json': {
    currentSha256: '7af341bfecef16ea9e5622dce78060cf5f86bb18a55c81e6f9b2ecbd5ee57482',
    previousSha256: {
      compatible: '0c9db66f55edf4a10ae1e8ed8c782ee2b495030882d855fcfa970639a4ae11cf',
      terminal_legacy: '819e042418865e7035a2ff4e6e766f2593e128d114bbdf9e774383475cbba2bf',
      windows_legacy: '0c9db66f55edf4a10ae1e8ed8c782ee2b495030882d855fcfa970639a4ae11cf',
    },
  },
};
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function matchReviewedPredecessorInput(
  predecessor: ReviewedPredecessorKind,
  path: string,
  previous: Uint8Array,
  current: Uint8Array,
) {
  // SQL and unlisted inputs can never enter this exception; their existing guards own them.
  if (!Object.hasOwn(reviewedInputs, path)) return undefined;
  const input = reviewedInputs[path]!;
  const previousSha256 = sha256(previous),
    currentSha256 = sha256(current);
  if (previousSha256 !== input.previousSha256[predecessor] || currentSha256 !== input.currentSha256)
    return undefined;
  const commits =
    path === 'package.json'
      ? [nativeCommit]
      : path === 'bun.lock' || path === 'packages/ai/package.json'
        ? [responsesCommit, nativeCommit]
        : path === 'packages/agent/package.json'
          ? [nativeCommit, titleCommit]
          : [nativeCommit];
  const increments =
    path === 'package.json'
      ? ['native_build_scripts', 'model_tools_live_script', 'model_collaboration_live_script']
      : path === 'bun.lock'
        ? ['responses_exact_resolved_closure', 'ui_react_dom_peer']
        : path === 'packages/ai/package.json'
          ? ['responses_openai_dependency', 'bundled_build']
          : path === 'packages/agent/package.json'
            ? ['native_bundled_build', 'session_title_entry']
            : path === 'packages/ui/package.json'
              ? ['ui_bundled_build', 'ui_ink_entry', 'ui_react_dom_peer']
              : ['service_bundled_build'];
  return {
    match: 'reviewed_locked_input_increment' as const,
    // These reasons cover this additional review, not the legacy guard's earlier increments.
    reviewScope:
      path === 'package.json'
        ? ('approved_input_increments_2026_10_19' as const)
        : ('approved_input_increments_2026_10_18' as const),
    predecessorCommit: REVIEWED_PREDECESSOR_COMMITS[predecessor],
    previousSha256,
    currentSha256,
    commits,
    increments,
    ...(path === 'package.json'
      ? {
          liveScript: REVIEWED_LIVE_TOOL_SCRIPT,
          collaborationLiveScript: reviewedCollaborationLiveScript,
        }
      : {}),
  };
}
