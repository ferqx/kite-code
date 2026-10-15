/** Same ordinary Service/UI composition, with bounded observation of existing public reads. */
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const dataRoot = args[args.indexOf('--data-root') + 1];
if (!dataRoot) throw Error('original_interrupt_observation_root_missing');
const actual = globalThis.fetch;
const observations: string[] = [];
globalThis.fetch = Object.assign(
  async (...input: Parameters<typeof fetch>) => {
    const response = await actual(...input);
    const path = new URL(String(input[0])).pathname;
    if (path === '/v1/server' || /^\/v1\/sessions\/[^/]+\/view$/.test(path)) {
      const body = await response.clone().json();
      observations.push(
        JSON.stringify({
          path,
          status: response.status,
          ...(path === '/v1/server'
            ? { storeId: body.storeId, instanceId: body.instanceId }
            : {
                storeId: body.storeId,
                sessionId: body.session?.id,
                ownerInstanceId: body.session?.ownerInstanceId,
                activityOwner: body.activityOwner,
                activeRuns: body.runs
                  ?.filter((run: { isActive: boolean }) => run.isActive)
                  .map((run: { id: string; status: string }) => ({
                    id: run.id,
                    status: run.status,
                  })),
              }),
        }),
      );
      if (observations.length > 32) observations.shift();
      writeFileSync(`${dataRoot}-interrupt-owner.jsonl`, observations.join('\n') + '\n');
    }
    return response;
  },
  { preconnect: actual.preconnect },
);
await import('./current-tui');
