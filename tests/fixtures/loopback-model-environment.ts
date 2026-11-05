/** Route an owned HTTP Provider directly while overriding inherited proxy settings. */
export function loopbackModelEnvironment(provider: URL) {
  if (
    provider.protocol !== 'http:' ||
    provider.hostname !== '127.0.0.1' ||
    provider.username ||
    provider.password
  )
    throw Error('loopback_model_provider_required');
  return {
    HTTP_PROXY: provider.origin,
    http_proxy: provider.origin,
    HTTPS_PROXY: provider.origin,
    https_proxy: provider.origin,
    ALL_PROXY: provider.origin,
    all_proxy: provider.origin,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
}
