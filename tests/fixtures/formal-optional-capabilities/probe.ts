import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, mode, identityPath] = process.argv.slice(2);
assert(root && mode);
const resolve = createRequire(join(root, 'package.json'));
const configPath = resolve.resolve('@kite-ai/agent/config');
const config = await import(pathToFileURL(configPath).href);
const native = createRequire(configPath)('@napi-rs/keyring');
assert.equal(typeof native.AsyncEntry, 'function');
if (mode === 'load') {
  let entries = 0;
  config.createOsCredentialBackend({ service: 'kite-unified-load', accountNamespace: 'zero-io' });
  config.createOsCredentialBackend({
    service: 'kite-unified-load',
    accountNamespace: 'sentinel',
    nativeFactory() {
      entries++;
      throw Error('must_not_initialize');
    },
  });
  assert.equal(entries, 0);
  console.log(
    JSON.stringify({
      nativeLoaded: true,
      entryCalls: entries,
      platform: process.platform,
      arch: process.arch,
    }),
  );
} else {
  assert.equal(process.env.KITE_RUN_UNIFIED_KEYRING_SMOKE, '1', 'native_smoke_gate_closed');
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'native_smoke_gate_closed');
  assert(identityPath);
  const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
  assert(typeof identity.service === 'string' && typeof identity.namespace === 'string');
  const vault = config.createCredentialVault({
    backend: config.createOsCredentialBackend({
      service: identity.service,
      accountNamespace: identity.namespace,
    }),
  });
  if (mode === 'put') {
    identity.reference = await vault.put(identity.secret);
    assert.equal(identity.reference.persistence, 'os');
    writeFileSync(identityPath, JSON.stringify(identity), { mode: 0o600 });
  } else if (mode === 'resolve') {
    assert(
      (await vault.resolve(identity.reference)) === identity.secret,
      'credential_value_mismatch',
    );
  } else if (mode === 'remove') {
    await vault.revoke(identity.reference);
  } else if (mode === 'missing') {
    let denied = false;
    try {
      await vault.resolve(identity.reference);
    } catch (error) {
      denied = String(error) === 'Error: credential_unavailable';
    }
    assert(denied);
  } else throw Error('invalid_probe_mode');
  console.log(JSON.stringify({ mode, passed: true }));
}
