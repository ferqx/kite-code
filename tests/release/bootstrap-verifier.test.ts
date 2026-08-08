import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RELEASE_MANIFEST_FILE,
  RELEASE_PAYLOAD_FILE,
  RELEASE_SIGNATURE_FILE,
  ReleaseArtifactError,
} from '../../scripts/release/artifact-layout';
import {
  verifyBeforePayloadExecution,
  verifyBootstrapArtifact,
} from '../../scripts/release/bootstrap-verifier';
import { buildSyntheticArtifact } from '../../scripts/release/build-artifact';
import { canonicalJsonBytes } from '../../scripts/release/canonical-json';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bootstrap release verifier', () => {
  test('reaches payload execution only after schema, signature, and digest verification', () => {
    const directory = builtFixture();
    let executions = 0;

    const result = verifyBeforePayloadExecution(directory, (artifact) => {
      executions += 1;
      expect(artifact.signature.distributable).toBe(false);
      expect(artifact.signature.realSigstoreSigningEnabled).toBe(false);
      return new TextDecoder().decode(artifact.payloadBytes);
    });

    expect(executions).toBe(1);
    expect(result).toContain('synthetic release payload fixture');
  });

  test('fails closed before execution when payload bytes drift', () => {
    const directory = builtFixture();
    writeFileSync(join(directory, RELEASE_PAYLOAD_FILE), 'tampered payload');
    let executed = false;

    expect(() =>
      verifyBeforePayloadExecution(directory, () => {
        executed = true;
      }),
    ).toThrow('Payload sha256');
    expect(executed).toBe(false);
  });

  test('fails closed on canonical manifest drift before reading payload as code', () => {
    const directory = builtFixture();
    const path = join(directory, RELEASE_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    manifest.productVersion = '0.0.0-tampered';
    writeFileSync(path, canonicalJsonBytes(manifest));
    let executed = false;

    expect(() =>
      verifyBeforePayloadExecution(directory, () => {
        executed = true;
      }),
    ).toThrow('subject digest');
    expect(executed).toBe(false);
  });

  test('rejects non-canonical and unknown manifest schema values', () => {
    const nonCanonical = builtFixture();
    const nonCanonicalPath = join(nonCanonical, RELEASE_MANIFEST_FILE);
    writeFileSync(nonCanonicalPath, `${readFileSync(nonCanonicalPath, 'utf8')}\n`);
    expectArtifactCode(() => verifyBootstrapArtifact(nonCanonical), 'canonical_invalid');

    const unknownSchema = builtFixture();
    const unknownPath = join(unknownSchema, RELEASE_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(unknownPath, 'utf8')) as Record<string, unknown>;
    manifest.unknownSecurityField = false;
    writeFileSync(unknownPath, canonicalJsonBytes(manifest));
    expectArtifactCode(() => verifyBootstrapArtifact(unknownSchema), 'schema_invalid');
  });

  test('rejects signature tampering and production-looking bundle substitution', () => {
    const badSignature = builtFixture();
    const badSignaturePath = join(badSignature, RELEASE_SIGNATURE_FILE);
    const signature = JSON.parse(readFileSync(badSignaturePath, 'utf8')) as Record<string, unknown>;
    signature.signatureBase64 = Buffer.alloc(64).toString('base64');
    writeFileSync(badSignaturePath, canonicalJsonBytes(signature));
    expectArtifactCode(() => verifyBootstrapArtifact(badSignature), 'signature_invalid');

    const substituted = builtFixture();
    const substitutedPath = join(substituted, RELEASE_SIGNATURE_FILE);
    const productionLooking = JSON.parse(readFileSync(substitutedPath, 'utf8')) as Record<
      string,
      unknown
    >;
    productionLooking.kind = 'sigstore-keyless-v1';
    productionLooking.distributable = true;
    productionLooking.realSigstoreSigningEnabled = true;
    writeFileSync(substitutedPath, canonicalJsonBytes(productionLooking));
    expectArtifactCode(() => verifyBootstrapArtifact(substituted), 'schema_invalid');
  });

  test('rejects payload symlinks instead of reopening unverified targets', () => {
    if (process.platform === 'win32') return;
    const directory = builtFixture();
    const outside = join(directory, 'outside-payload');
    const payload = join(directory, RELEASE_PAYLOAD_FILE);
    writeFileSync(outside, readFileSync(payload));
    rmSync(payload);
    symlinkSync(outside, payload);

    expectArtifactCode(() => verifyBootstrapArtifact(directory), 'layout_invalid');
  });
});

function builtFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'kite-bootstrap-verifier-'));
  roots.push(directory);
  buildSyntheticArtifact({ directory });
  return directory;
}

function expectArtifactCode(run: () => unknown, code: ReleaseArtifactError['code']): void {
  try {
    run();
    throw new Error('Expected release artifact verification to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(ReleaseArtifactError);
    expect((error as ReleaseArtifactError).code).toBe(code);
  }
}
