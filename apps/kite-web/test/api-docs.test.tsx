// @vitest-environment jsdom

import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { type AgentApiOpenApiDocument, ApiDocs, loadBundledSpec } from '@/api-docs/api-docs';

const spec: AgentApiOpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Kite Agent Server API',
    version: '1.0.0',
    description: 'Stable local Agent API contract.',
  },
  servers: [{ url: 'http://127.0.0.1:{port}' }],
  paths: {
    '/v1/sessions': {
      get: { operationId: 'listSessions', summary: 'List Sessions' },
    },
  },
  components: { schemas: { Session: {} } },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Agent API reference', () => {
  test('renders the bundled contract without interactive request controls', async () => {
    const view = render(
      <MemoryRouter initialEntries={['/api-docs']}>
        <ApiDocs loadSpec={async () => spec} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(view.getByText('Kite Agent Server API')).toBeTruthy());

    expect(view.getByText('Reference only')).toBeTruthy();
    expect(view.getByText('Availability is unconfirmed')).toBeTruthy();
    expect(view.getByText('/v1/sessions')).toBeTruthy();
    expect(document.title).toBe('Kite Agent API reference');
    expect(view.container.querySelector('button, form, input, select, textarea')).toBeNull();
    view.unmount();
  });

  test('reports only local artifact unavailability when the contract cannot be loaded', async () => {
    const view = render(
      <MemoryRouter initialEntries={['/api-docs']}>
        <ApiDocs loadSpec={async () => Promise.reject(new Error('artifact missing'))} />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(
        view.getByText('The bundled OpenAPI artifact is unavailable for this build.'),
      ).toBeTruthy(),
    );

    expect(view.queryByText(/Worker unavailable/iu)).toBeNull();
    view.unmount();
  });

  test('loads only the fixed same-origin artifact without credentials', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(spec), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
    );
    vi.stubGlobal('fetch', fetch);

    await expect(loadBundledSpec()).resolves.toEqual(spec);
    expect(fetch).toHaveBeenCalledWith('/api-docs/openapi.json', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  });
});
