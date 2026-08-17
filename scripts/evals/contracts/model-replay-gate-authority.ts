/**
 * Review anchor kept outside the parser whose digest is bound by the manifest.
 * Changing this value is the explicit approval step for a new manifest revision.
 */
export const MODEL_REPLAY_GATE_MANIFEST_DIGEST_V1 =
  'sha256:99fbfb7255230b61cf8cc5d7812a4b9315afe687b0c8be73f735d5d6bd9c3c1c' as const;
