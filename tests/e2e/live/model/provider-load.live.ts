import { providerLoadCases, runLiveProviderLoad } from './collaboration-provider-load.live';

// Independent explicitly named runner: no common 40HTTP harness cap is widened.
if (process.env.KITE_RUN_LIVE_COLLABORATION !== '1')
  throw Error('live_provider_load_requires_opt_in');
const args = new Map<string, string>();
for (const argument of process.argv.slice(2)) {
  const match = /^--(case|output)=(.+)$/.exec(argument);
  if (!match || args.has(match[1]!)) throw Error('live_provider_load_arguments_invalid');
  args.set(match[1]!, match[2]!);
}
const caseId = args.get('case'),
  output = args.get('output');
if (!providerLoadCases.includes(caseId as (typeof providerLoadCases)[number]) || !output)
  throw Error('live_provider_load_arguments_invalid');
const result = await runLiveProviderLoad({
  caseId: caseId as (typeof providerLoadCases)[number],
  output,
});
console.log(
  JSON.stringify({
    status: result.status,
    requestCount: result.requestCount,
    requestLimit: result.requestLimit,
    cleanupConfirmed: result.cleanupConfirmed,
  }),
);
if (result.status === 'failed') process.exitCode = 1;
else if (result.status === 'inconclusive') process.exitCode = 2;
