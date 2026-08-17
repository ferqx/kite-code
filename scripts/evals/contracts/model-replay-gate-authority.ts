/**
 * Review anchor kept outside the parser whose digest is bound by the manifest.
 * Changing this value is the explicit approval step for a new manifest revision.
 */
export const MODEL_REPLAY_GATE_MANIFEST_DIGEST_V1 =
  'sha256:de61fc12cd6249ed5ddf4f5eb848ddf4798ca0f62039fc5c2e9f4c4e9fb9e79d' as const;
