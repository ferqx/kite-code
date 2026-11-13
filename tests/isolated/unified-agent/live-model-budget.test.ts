import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '#kite-test';
import { spawn as spawnFixtureProcess } from '../../../scripts/tooling/process';
import { testNodeCommand } from '../../../scripts/tooling/test-command';

// Each child owns its HOME/config and an unauthenticated loopback provider. The
// real shared fixture and SDK run without consulting user settings or credentials.
const probe = String.raw`
import { expect } from '#kite-test';
import { setTimeout as sleep } from 'node:timers/promises';
import { serve } from ${JSON.stringify(new URL('../../../scripts/tooling/http.ts', import.meta.url).href)};
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLiveModelFixture } from ${JSON.stringify(new URL('../../e2e/live/model/live-model-fixture.ts', import.meta.url).href)};
const scenario = process.env.LIVE_BUDGET_SCENARIO;
const timers = [];
const originalTimeout = AbortSignal.timeout;
AbortSignal.timeout = (ms) => { timers.push(ms); return originalTimeout(ms); };
let delay = 0, hits = 0, abortedFetches = 0;
let entered;
let providerEntered = new Promise(resolve => { entered = resolve; });
const provider = await serve({ hostname:'127.0.0.1', port:0, async fetch(request) {
  hits++;
  expect(request.headers.get('authorization')).toBeNull();
  expect((await request.json()).model).toBe('fixture-model');
  entered();
  if (delay) await sleep(delay);
  const chunk = (delta, finish_reason) => 'data: '+JSON.stringify({id:'budget-response',object:'chat.completion.chunk',model:'fixture-model',choices:[{index:0,delta,finish_reason}]})+'\n\n';
  return new Response(chunk({content:'fixture result'},null)+chunk({},'stop')+'data: [DONE]\n\n', {headers:{'content-type':'text/event-stream'}});
}});
const configuration = join(process.env.HOME, '.kite-code');
mkdirSync(configuration, {recursive:true});
writeFileSync(join(configuration,'kite-code.jsonc'), JSON.stringify({modelId:'owned',models:[{id:'owned',provider:'compatible',model:'fixture-model',baseURL:provider.url.href+'v1',protocol:'chat-completions'}]}), {mode:0o600});
const actualFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input, init) => {
  if (!String(input instanceof Request ? input.url : input).startsWith(provider.url.href)) throw Error('nonlocal_provider_forbidden');
  init?.signal?.addEventListener('abort',()=>{abortedFetches++;},{once:true});
  return actualFetch(input,init);
}, {});
const consume = async (fixture, signal = new AbortController().signal) => {
  let text = '', finished = false;
  for await (const event of fixture.model.stream({modelId:fixture.modelId,requestId:'request-'+fixture.requests.length,messages:[{role:'user',content:'Return fixture result.'}],tools:[]},{signal})) {
    if (event.type==='text_delta') text+=event.text;
    if (event.type==='finish') finished=true;
  }
  expect(text).toBe('fixture result');
  expect(finished).toBe(true);
};
try {
  if (scenario==='unbounded') {
    delay = 60;
    const fixture = await createLiveModelFixture({requestTimeoutMs:null});
    for (let i=0;i<4;i++) await consume(fixture);
    expect(fixture.requests).toHaveLength(4);
    expect(fixture.wire).toHaveLength(4);
    expect(fixture.attemptFailures).toHaveLength(0);
    expect(fixture.signal.aborted).toBe(false);
    expect(timers).toEqual([]);
  } else if (scenario==='bounded') {
    const fixture = await createLiveModelFixture({requestLimit:2,timeoutMs:2000,requestTimeoutMs:null});
    await consume(fixture);
    await consume(fixture);
    await expect(consume(fixture)).rejects.toThrow('live_model_request_budget_exhausted');
    expect(hits).toBe(2);
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.wire).toHaveLength(2);
    expect(timers).toContain(2000);
  } else if (scenario==='whole-timeout') {
    const fixture = await createLiveModelFixture({timeoutMs:20,requestTimeoutMs:null});
    await sleep(60);
    expect(fixture.signal.aborted).toBe(true);
    await expect(consume(fixture)).rejects.toBeInstanceOf(Error);
    expect(hits).toBe(0);
    expect(fixture.requests).toHaveLength(0);
    expect(timers).toEqual([20]);
  } else if (scenario==='request-timeout') {
    delay = 100;
    const fixture = await createLiveModelFixture({requestTimeoutMs:30});
    await expect(consume(fixture)).rejects.toBeInstanceOf(Error);
    expect(hits).toBe(1);
    expect(abortedFetches).toBe(1);
    expect(fixture.signal.aborted).toBe(false);
    expect(fixture.attemptFailures).toHaveLength(1);
    expect(timers).toContain(30);
    delay = 0;
    await consume(fixture);
    expect(fixture.requests).toHaveLength(2);
  } else if (scenario==='default-request-timeout') {
    const fixture = await createLiveModelFixture({});
    await consume(fixture);
    expect(timers).toContain(60000);
    expect(fixture.signal.aborted).toBe(false);
    expect(hits).toBe(1);
  } else if (scenario==='caller-cancel' || scenario==='fixture-cancel') {
    delay = 100;
    const controller = new AbortController();
    const fixture = await createLiveModelFixture({requestTimeoutMs:null,...(scenario==='fixture-cancel'?{signal:controller.signal}:{})});
    const attempt = consume(fixture,scenario==='caller-cancel'?controller.signal:undefined).then(()=>null,error=>error);
    await providerEntered;
    controller.abort(new Error('owned_test_cancelled'));
    expect(await attempt).toBeInstanceOf(Error);
    expect(abortedFetches).toBe(1);
    expect(fixture.attemptFailures).toHaveLength(1);
    expect(fixture.signal.aborted).toBe(scenario==='fixture-cancel');
    expect(timers).toEqual([]);
    if (scenario==='caller-cancel') {
      delay=0;
      await consume(fixture);
      expect(hits).toBe(2);
    } else {
      await expect(consume(fixture)).rejects.toBeInstanceOf(Error);
      expect(hits).toBe(1);
    }
  } else if (scenario==='invalid') {
    for (const [field,code] of [['requestLimit','limit_invalid'],['timeoutMs','timeout_invalid'],['requestTimeoutMs','request_timeout_invalid']]) {
      for (const value of [0,-1,1.5,Infinity,NaN,'30'])
        await expect(createLiveModelFixture({[field]:value})).rejects.toThrow('live_model_'+code);
    }
    for (const field of ['requestLimit','timeoutMs'])
      await expect(createLiveModelFixture({[field]:null})).rejects.toBeInstanceOf(Error);
    expect(hits).toBe(0);
    expect(timers).toEqual([]);
  } else throw Error('unknown_budget_scenario');
  console.log(JSON.stringify({scenario,hits,abortedFetches,passed:true}));
} finally {
  provider.stop(true);
  globalThis.fetch=actualFetch;
  AbortSignal.timeout=originalTimeout;
}
`;

for (const scenario of [
  'unbounded',
  'bounded',
  'whole-timeout',
  'request-timeout',
  'default-request-timeout',
  'caller-cancel',
  'fixture-cancel',
  'invalid',
])
  test(`shared live fixture preserves real SDK budget and cancellation behavior: ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-live-budget-'));
    const child = spawnFixtureProcess(testNodeCommand('--input-type=module', ['--eval', probe]), {
      cwd: process.cwd(),
      env: {
        HOME: root,
        USERPROFILE: root,
        PATH: process.env.PATH ?? '',
        LIVE_BUDGET_SCENARIO: scenario,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stderr).toBe(0);
      expect(stderr).toBe('');
      expect(JSON.parse(stdout)).toMatchObject({ scenario, passed: true });
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
      rmSync(root, { recursive: true, force: true });
    }
  });
