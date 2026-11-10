/** Controlled frozen request data. No user's real Profile or files are read. */
export function trajectoryInputContextData(pasteExactHost = false) {
  const hostDirectory = '/fixture-host-private/profile/a/session-files';
  const hostPath = `${hostDirectory}/internal.txt`;
  const runId = 'semantic-run';
  const runtimeSourceContent = [
    `run: ${runId}`,
    'plan_requirement: {"status":"not_required"}',
    'This is Runtime-generated observation, not a user request or execution grant.',
  ].join('\n');
  const hostJson = JSON.stringify({
    kind: 'session_files',
    outputDirectory: hostDirectory,
    complete: true,
    files: [{ path: hostPath, state: 'saved' }],
  });
  const pastedJson = pasteExactHost
    ? hostJson
    : JSON.stringify({
        kind: 'session_files',
        outputDirectory: '/user-pasted/example',
        complete: true,
        files: [{ path: '/user-pasted/example/user-owned.txt', state: 'saved' }],
      });
  return {
    sourceId: 'builtin.files:session-files:a',
    runId,
    runtimeSourceId: `builtin.planning:runtime:${runId}`,
    runtimeSourceContent,
    runtimeMessageContent: `<runtime-state source="runtime.kernel">\n${runtimeSourceContent}\n</runtime-state>`,
    inputVersion: `sha256:${'e4'.repeat(32)}`,
    hostPath,
    hostDirectory,
    hostJson,
    pastedJson,
    image: {
      mediaType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGBcAAAAASUVORK5CYII=',
    },
  };
}
