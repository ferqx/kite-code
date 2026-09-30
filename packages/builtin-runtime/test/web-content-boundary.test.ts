import { describe, expect, test } from 'bun:test';
import { createRuntimeModuleRegistry, type RuntimeJsonValue } from '@kite-ai/runtime-spi';
import { createBuiltinRuntimeModules, isBuiltinOperationExecutionValue } from '../src';
import { MODEL_CAPABILITY_REVISIONS_ } from '../src/model/runtime-module';
import { fetchAndExtract } from '../src/web';

function responseFetch(body: string, contentType = 'text/plain'): typeof fetch {
  return (async (input: RequestInfo | URL) =>
    String(input).endsWith('/robots.txt')
      ? new Response('User-agent: *\nDisallow:', {
          headers: { 'content-type': 'text/plain' },
        })
      : new Response(body, { headers: { 'content-type': contentType } })) as typeof fetch;
}

test('web deadline includes robots and domain queue before the page fetch', async () => {
  const host = `deadline-${Date.now()}.example.com`;
  let pageCalls = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/robots.txt')) return new Response('User-agent: *\n');
    pageCalls++;
    return new Response('content', { headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;
  const started = performance.now();
  const result = await fetchAndExtract(`https://${host}/page`, {
    timeoutMs: 100,
    fetch: fetchImpl,
  });
  expect(result.ok).toBe(false);
  expect(result.error).toContain('timed out');
  expect(pageCalls).toBe(0);
  expect(performance.now() - started).toBeLessThan(300);
});

test('web deadline interrupts a slow robots request even when a fetch stub ignores abort', async () => {
  const host = `robots-deadline-${Date.now()}.example.com`;
  let pageCalls = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/robots.txt')) {
      await new Promise((resolve) => setTimeout(resolve, 650));
      return new Response('User-agent: *\n');
    }
    pageCalls++;
    return new Response('content');
  }) as typeof fetch;
  const started = performance.now();
  const result = await fetchAndExtract(`https://${host}/page`, {
    timeoutMs: 500,
    fetch: fetchImpl,
  });
  expect(result.ok).toBe(false);
  expect(pageCalls).toBe(0);
  expect(performance.now() - started).toBeLessThan(630);
});

test('robots parsing honors a disallow rule after the former 100-rule cutoff', async () => {
  const host = `robots-rules-${Date.now()}.example.com`;
  let pageCalls = 0;
  const rules = Array.from({ length: 150 }, (_, index) => `Disallow: /other-${index}`).join('\n');
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/robots.txt')) {
      return new Response(`User-agent: *\n${rules}\nDisallow: /blocked`);
    }
    pageCalls++;
    return new Response('content');
  }) as typeof fetch;
  const result = await fetchAndExtract(`https://${host}/blocked`, { fetch: fetchImpl });
  expect(result.ok).toBe(false);
  expect(result.error).toContain('Blocked by robots.txt');
  expect(pageCalls).toBe(0);
});

test('same-domain web requests keep their throttle order under concurrency', async () => {
  const host = `throttle-${Date.now()}.example.com`;
  const pageStarts: number[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/robots.txt')) return new Response('User-agent: *\n');
    pageStarts.push(performance.now());
    return new Response('content', { headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;
  const results = await Promise.all(
    [1, 2, 3].map((index) =>
      fetchAndExtract(`https://${host}/page-${index}`, { timeoutMs: 2500, fetch: fetchImpl }),
    ),
  );
  expect(results.every((result) => result.ok)).toBe(true);
  expect(pageStarts).toHaveLength(3);
  expect(pageStarts[1]! - pageStarts[0]!).toBeGreaterThan(400);
  expect(pageStarts[2]! - pageStarts[1]!).toBeGreaterThan(400);
});

async function executeWeb(
  input: Readonly<Record<string, RuntimeJsonValue>>,
  fetchImpl: typeof fetch,
) {
  const executor = createRuntimeModuleRegistry(createBuiltinRuntimeModules()).executor(
    'builtin:web_fetch',
  );
  if (!executor) throw new Error('Web executor missing');
  const receipt = await executor.execute(
    {
      invocationId: 'web-content-test',
      capabilityId: 'builtin:web_fetch',
      capabilityRevision: MODEL_CAPABILITY_REVISIONS_['builtin:web_fetch'],
      input,
    },
    {
      grant: {
        grantId: 'web-content-grant',
        capabilityId: 'builtin:web_fetch',
        capabilityRevision: MODEL_CAPABILITY_REVISIONS_['builtin:web_fetch'],
        authority: {},
      },
      requestDigest: 'web-content-digest',
      signal: new AbortController().signal,
      environment: {
        environmentId: 'web-content-environment',
        kind: 'in_process',
        mechanisms: Object.freeze({ web: Object.freeze({ fetch: fetchImpl }) }),
      },
      attempt: { invocationId: 'web-content-test', attemptId: 'web-content-attempt' },
    },
  );
  expect(receipt.status).toBe('succeeded');
  if (!isBuiltinOperationExecutionValue(receipt.value)) throw new Error('Invalid Web result');
  return receipt.value;
}

describe('complete governed Web content', () => {
  test('returns all extracted text through the real Builtin result projection', async () => {
    const content = `${'完整正文🙂\n'.repeat(5000)}最后一行`;
    const result = await executeWeb(
      { url: 'https://complete-web-content.example/article' },
      responseFetch(content),
    );
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain(content);
    expect(result.stdout.endsWith('最后一行')).toBe(true);
    expect(result.resultMeta).toMatchObject({ truncated: false });
  });

  test('honors an explicit caller content limit without imposing the old minimum', async () => {
    const result = await executeWeb(
      { url: 'https://selected-web-content.example/article', max_chars: 20 },
      responseFetch('x'.repeat(200)),
    );
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('x'.repeat(20));
    expect(result.stdout).not.toContain('x'.repeat(21));
    expect(result.resultMeta).toMatchObject({ truncated: true });
  });

  test('HTML extraction preserves the full article when no content limit is selected', async () => {
    const paragraph = 'This article describes the complete execution workflow in detail. ';
    const result = await fetchAndExtract('https://complete-html-content.example/article', {
      fetch: responseFetch(
        `<html><head><title>Complete article</title></head><body><article><h1>Complete article</h1>${`<p>${paragraph.repeat(20)}</p>`.repeat(
          20,
        )}<p>FINALARTICLECONTENT</p></article></body></html>`,
        'text/html',
      ),
    });
    expect(result.ok).toBe(true);
    expect(result.content!.length).toBeGreaterThan(16000);
    expect(result.content).toContain('FINALARTICLECONTENT');
    expect(result.truncated).toBe(false);
  });

  test('cancels an unbounded response stream at the actual byte parsing boundary', async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode('界'.repeat(1_000_000));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk);
        if (pulled === 8) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await fetchAndExtract('https://oversized-web-content.example/article', {
      fetch: (async (input: RequestInfo | URL) =>
        String(input).endsWith('/robots.txt')
          ? new Response('')
          : new Response(body, {
              headers: { 'content-type': 'text/plain' },
            })) as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('5000000 byte parsing safety limit');
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(8);
  });

  test('continues to reject private network targets before fetching', async () => {
    let fetched = false;
    const result = await fetchAndExtract('http://127.0.0.1/private', {
      fetch: (async (_input: RequestInfo | URL) => {
        fetched = true;
        return new Response('private');
      }) as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(fetched).toBe(false);
  });

  test('permits a valid redirect chain beyond three hops and rejects a cycle', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/robots.txt') return new Response('');
      const hop = Number(url.pathname.slice(1));
      return hop < 5
        ? new Response(null, { status: 302, headers: { location: `/${hop + 1}` } })
        : new Response('Complete redirected content', {
            headers: { 'content-type': 'text/plain' },
          });
    }) as typeof fetch;
    const result = await fetchAndExtract('https://redirect-content.example/0', {
      fetch: fetchImpl,
      timeoutMs: 3_000_000_000,
    });
    expect(result.ok).toBe(true);
    expect(result.content).toBe('Complete redirected content');
    expect(result.finalUrl).toBe('https://redirect-content.example/5');

    const cycle = await fetchAndExtract('https://redirect-cycle.example/a', {
      fetch: (async (input: RequestInfo | URL) =>
        String(input).endsWith('/robots.txt')
          ? new Response('')
          : new Response(null, {
              status: 302,
              headers: { location: String(input).endsWith('/a') ? '/b' : '/a' },
            })) as typeof fetch,
    });
    expect(cycle.ok).toBe(false);
    expect(cycle.error).toBe('Redirect loop detected.');
  });
});
