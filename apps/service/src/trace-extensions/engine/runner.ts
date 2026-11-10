import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from 'quickjs-emscripten-core';
import { runnerRequestSchema, type TraceEngineBudgets } from './protocol';

// This file is a private executable, never loaded by Service as an in-process extension.
let generation = '',
  maxMessage = 768 * 1024;
let vm: QuickJSContext | undefined, extension: QuickJSHandle | undefined;
let invoke: QuickJSHandle | undefined, budgets: TraceEngineBudgets | undefined;
let active:
  | { id: number; deadline: number; calls: number; pending: Map<number, QuickJSDeferredPromise> }
  | undefined;
let nextCall = 0;
const send = (value: unknown) => {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > maxMessage) process.exit(70);
  process.stdout.write(`${encoded}\n`);
};
function fail(
  code:
    | 'evaluation_failed'
    | 'message_limit'
    | 'invalid_extension'
    | 'broker_limit'
    | 'timeout'
    | 'protocol_error',
): never {
  send({ type: 'failed', generation, id: active?.id ?? 0, code });
  process.exit(70);
}
function stringValue(handle: QuickJSHandle, maxCharacters: number): string {
  if (vm?.typeof(handle) !== 'string') throw Error('protocol');
  // The injected bootstrap bounds this string before crossing the compartment.
  const value = vm.getString(handle);
  if (value.length > maxCharacters) throw Error('message_limit');
  return value;
}
function pump(): void {
  if (!vm || !active) return;
  if (Date.now() >= active.deadline) fail('timeout');
  const jobs = vm.runtime.executePendingJobs(32);
  if (jobs.error) {
    jobs.dispose();
    fail('evaluation_failed');
  }
  jobs.dispose();
  if (vm.runtime.hasPendingJob()) setImmediate(pump);
}
async function initialize(
  request: Extract<ReturnType<typeof runnerRequestSchema.parse>, { type: 'initialize' }>,
) {
  if (vm || generation) fail('protocol_error');
  generation = request.generation;
  budgets = request.budgets;
  maxMessage = budgets.messageBytes;
  const wasm = readFileSync(request.wasmPath);
  const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
  if (hash(wasm) !== request.wasmDigest || hash(request.source) !== request.digest)
    fail('protocol_error');
  const module = await newQuickJSWASMModuleFromVariant(
    newVariant(variant, {
      wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
    }),
  );
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(budgets.heapBytes);
  runtime.setMaxStackSize(budgets.stackBytes);
  const sourceDeadline = Date.now() + budgets.callbackMs;
  runtime.setInterruptHandler(() => Date.now() >= (active?.deadline ?? sourceDeadline));
  runtime.removeModuleLoader();
  vm = runtime.newContext();
  // Capture builtins before untrusted code can replace globals/prototypes. The host
  // function is held by a guest closure; it is never exposed as a raw host object.
  const maxCharacters = Math.floor((maxMessage - 1024) / 3);
  const brokerHost = vm.newFunction('broker', (methodHandle, jsonHandle) => {
    if (!active || !budgets || !vm) throw Error('no_callback');
    if (++active.calls > budgets.brokerCalls || active.pending.size >= budgets.brokerConcurrency)
      fail('broker_limit');
    const method = stringValue(methodHandle!, 64);
    const json = stringValue(jsonHandle!, maxCharacters);
    const deferred = vm.newPromise();
    const callId = ++nextCall;
    active.pending.set(callId, deferred);
    send({ type: 'broker', generation, id: active.id, callId, method, input: JSON.parse(json) });
    return deferred.handle;
  });
  const brokerFactory = vm.unwrapResult(
    vm.evalCode(
      `(function(host){const parse=JSON.parse,stringify=JSON.stringify;return Object.freeze({request:async function(method,input){if(typeof method!=='string'||method.length<1||method.length>64)throw Error('method');const json=stringify(input??null);if(typeof json!=='string'||json.length>${maxCharacters})throw Error('message_limit');return parse(await host(method,json));}});})`,
    ),
  );
  const broker = vm.unwrapResult(vm.callFunction(brokerFactory, vm.undefined, brokerHost));
  vm.setProp(vm.global, 'trace', broker);
  broker.dispose();
  brokerFactory.dispose();
  brokerHost.dispose();
  invoke = vm.unwrapResult(
    vm.evalCode(
      `(function(){const parse=JSON.parse,stringify=JSON.stringify;return async function(extension,method,input){const fn=extension[method];if(typeof fn!=='function'){if(method==='onEvents')throw Error('missing_onEvents');return 'null';}const value=await fn.call(extension,parse(input));const json=stringify(value??null);if(typeof json!=='string'||json.length>${maxCharacters})throw Error('message_limit');return json;};})()`,
    ),
  );
  const define = vm.newFunction('defineTraceExtension', (value) => {
    if (extension || !value || vm!.typeof(value) !== 'object') fail('invalid_extension');
    extension = value.dup();
    return vm!.undefined;
  });
  vm.setProp(vm.global, 'defineTraceExtension', define);
  define.dispose();
  const result = vm.evalCode(request.source, 'extension.js', { type: 'global' });
  if (result.error) {
    result.dispose();
    fail('evaluation_failed');
  }
  result.dispose();
  if (!extension) fail('invalid_extension');
  send({ type: 'ready', generation });
}
function startInvocation(
  request: Extract<ReturnType<typeof runnerRequestSchema.parse>, { type: 'invoke' }>,
): void {
  if (!vm || !extension || !invoke || !budgets || active) fail('protocol_error');
  active = {
    id: request.id,
    deadline: Date.now() + budgets.callbackMs,
    calls: 0,
    pending: new Map(),
  };
  nextCall = 0;
  const method = vm.newString(request.method),
    input = vm.newString(JSON.stringify(request.input));
  const result = vm.callFunction(invoke, vm.undefined, extension, method, input);
  method.dispose();
  input.dispose();
  if (result.error) {
    result.dispose();
    fail('evaluation_failed');
  }
  const promise = result.value;
  void vm
    .resolvePromise(promise)
    .then((settled) => {
      if (settled.error) {
        settled.dispose();
        fail(Date.now() >= active!.deadline ? 'timeout' : 'evaluation_failed');
      }
      if (!active || active.id !== request.id || active.pending.size) fail('protocol_error');
      const text = stringValue(settled.value, Math.floor((maxMessage - 1024) / 3));
      settled.dispose();
      promise.dispose();
      active = undefined;
      send({ type: 'result', generation, id: request.id, value: JSON.parse(text) });
    })
    .catch(() => fail('evaluation_failed'));
  pump();
}
function brokerResult(
  request: Extract<ReturnType<typeof runnerRequestSchema.parse>, { type: 'broker_result' }>,
): void {
  if (!vm || !active || request.id !== active.id) fail('protocol_error');
  const deferred = active.pending.get(request.callId);
  if (!deferred) fail('protocol_error');
  active.pending.delete(request.callId);
  const value = request.error
    ? vm.newError('broker_rejected')
    : vm.newString(JSON.stringify(request.value ?? null));
  if (request.error) deferred.reject(value);
  else deferred.resolve(value);
  value.dispose();
  deferred.dispose();
  pump();
}
let buffer = Buffer.alloc(0),
  chain = Promise.resolve();
process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer.byteLength > maxMessage) fail('message_limit');
  for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10)) {
    const bytes = buffer.subarray(0, end);
    buffer = buffer.subarray(end + 1);
    chain = chain
      .then(async () => {
        const request = runnerRequestSchema.parse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        );
        if (request.type === 'initialize') await initialize(request);
        else if (request.type === 'invoke') startInvocation(request);
        else brokerResult(request);
      })
      .catch(() => fail('protocol_error'));
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(70));
