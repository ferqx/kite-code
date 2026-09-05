import type { NativeProviderCredentialRequest, NativeProviderCredentialResult } from './codecs';

/** Fixed provider credential mutation capability exposed by an App Server connection. */
export interface NativeProviderCredentialClient {
  writeProviderCredential(
    request: NativeProviderCredentialRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<NativeProviderCredentialResult>;
}
