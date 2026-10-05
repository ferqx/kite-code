import specification from '../generated/openapi.json';

const escapeMarkup = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** Read-only documentation from this Service build; no browser credentials or execution. */
export function apiDocumentationAssets() {
  const assets = new Map<string, { content: string; mediaType: string }>();
  const json = JSON.stringify(specification, null, 2);
  const routes = Object.entries(specification.paths)
    .flatMap(([path, methods]) =>
      Object.keys(methods).map(
        (method) =>
          `<li><code>${escapeMarkup(method.toUpperCase())} ${escapeMarkup(path)}</code></li>`,
      ),
    )
    .join('');
  assets.set('/openapi.json', { content: json, mediaType: 'application/json' });
  assets.set('/api-docs', {
    mediaType: 'text/html; charset=utf-8',
    content: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kite API Docs</title><style>body{font:16px system-ui;max-width:1000px;margin:2rem auto;padding:0 1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}li{margin:.4rem 0}</style></head><body><a href="/">Conversation</a><h1>Kite API Docs</h1><p>This specification belongs to the running Service build. The browser provides read-only access; Native authentication and capability requirements still apply.</p><p><a href="/openapi.json">OpenAPI JSON</a></p><ul>${routes}</ul><details><summary>Complete specification</summary><pre>${escapeMarkup(json)}</pre></details></body></html>`,
  });
  return assets;
}
