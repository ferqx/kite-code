import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

const DENIAL = 'MODEL_REPLAY_REQUIRED_NETWORK_DENIED';
const INSTALLATION_MARKER = '__KITE_MODEL_REPLAY_NETWORK_DENY_V1__';
const runtimeRequire = createRequire(import.meta.url);

// Defense in depth for selected mutable runtime entry points only. Bun's ESM builtin
// bindings are not treated as patchable authority; the outer OS isolation and
// known-reachable loopback denial probe are the no-egress boundary.

function deny(): never {
  throw new Error(DENIAL);
}

function replace(target: object, key: PropertyKey, value: unknown = deny): void {
  if (!Reflect.set(target, key, value) || Reflect.get(target, key) !== value) {
    throw new Error('MODEL_REPLAY_REQUIRED_NETWORK_GUARD_INVALID');
  }
}

replace(globalThis, 'fetch');
replace(
  globalThis,
  'WebSocket',
  class ReplayDeniedWebSocket {
    constructor() {
      deny();
    }
  },
);
for (const target of [http, runtimeRequire('node:http')]) {
  replace(target, 'request');
  replace(target, 'get');
}
for (const target of [https, runtimeRequire('node:https')]) {
  replace(target, 'request');
  replace(target, 'get');
}
for (const target of [http2, runtimeRequire('node:http2')]) replace(target, 'connect');
for (const target of [net, runtimeRequire('node:net')]) {
  replace(target, 'connect');
  replace(target, 'createConnection');
  replace(target.Socket.prototype, 'connect');
}
for (const target of [tls, runtimeRequire('node:tls')]) {
  replace(target, 'connect');
  replace(target.TLSSocket.prototype, 'connect');
}
for (const target of [dgram, runtimeRequire('node:dgram')]) replace(target, 'createSocket');

for (const key of [
  'lookup',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCaa',
  'resolveCname',
  'resolveMx',
  'resolveNaptr',
  'resolveNs',
  'resolvePtr',
  'resolveSoa',
  'resolveSrv',
  'resolveTxt',
  'reverse',
] as const) {
  for (const target of [dns, runtimeRequire('node:dns')]) {
    replace(target, key);
    replace(target.promises, key, async () => deny());
  }
}

replace(Bun, 'connect');
replace(Bun, 'udpSocket');

syncBuiltinESMExports();
replace(globalThis, INSTALLATION_MARKER, true);
