import {
  discoverOAuthServerInfo,
  type OAuthClientProvider,
  selectClientAuthMethod,
} from '@modelcontextprotocol/sdk/client/auth.js';

export async function revokeMcpOAuthToken(
  provider: OAuthClientProvider,
  serverUrl: URL,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  const tokens = await provider.tokens();
  if (!tokens) return false;
  const cached = await provider.discoveryState?.();
  const serverInfo = cached ?? (await discoverOAuthServerInfo(serverUrl, { fetchFn }));
  const endpoint = (
    serverInfo.authorizationServerMetadata as
      | (typeof serverInfo.authorizationServerMetadata & { revocation_endpoint?: string })
      | undefined
  )?.revocation_endpoint;
  if (!endpoint) return false;

  const client = await provider.clientInformation();
  if (!client) return false;
  const token = tokens.refresh_token ?? tokens.access_token;
  const params = new URLSearchParams({
    token,
    token_type_hint: tokens.refresh_token ? 'refresh_token' : 'access_token',
    client_id: client.client_id,
  });
  const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded' });
  const supported = serverInfo.authorizationServerMetadata?.token_endpoint_auth_methods_supported;
  const method = selectClientAuthMethod(client, supported ?? ['none']);
  if (method === 'client_secret_basic' && client.client_secret) {
    headers.set(
      'Authorization',
      `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}`,
    );
    params.delete('client_id');
  } else if (method === 'client_secret_post' && client.client_secret) {
    params.set('client_secret', client.client_secret);
  }

  const response = await fetchFn(endpoint, { method: 'POST', headers, body: params });
  if (!response.ok) throw new Error('OAuth token revocation failed.');
  return true;
}
