import { BookOpen, ChevronLeft, FileJson, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

const OPENAPI_PATH = '/api-docs/openapi.json';
const HTTP_METHODS = ['delete', 'get', 'patch', 'post', 'put'] as const;

interface OpenApiOperation {
  readonly operationId?: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
}

export interface AgentApiOpenApiDocument {
  readonly openapi: string;
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description?: string;
  };
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>;
  readonly components?: { readonly schemas?: Readonly<Record<string, unknown>> };
  readonly servers?: readonly { readonly url: string; readonly description?: string }[];
}

export interface ApiDocsProps {
  /** Test seam; production reads the immutable same-origin build artifact. */
  readonly loadSpec?: () => Promise<AgentApiOpenApiDocument>;
}

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly spec: AgentApiOpenApiDocument }
  | { readonly status: 'unavailable' };

export function ApiDocs({ loadSpec = loadBundledSpec }: ApiDocsProps = {}) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Kite Agent API reference';
    return () => {
      document.title = previousTitle;
    };
  }, []);
  useEffect(() => {
    let active = true;
    void loadSpec().then(
      (spec) => {
        if (active) setState({ status: 'ready', spec });
      },
      () => {
        if (active) setState({ status: 'unavailable' });
      },
    );
    return () => {
      active = false;
    };
  }, [loadSpec]);

  return (
    <main className="min-h-dvh bg-canvas text-foreground">
      <header className="sticky top-0 z-10 border-b border-border bg-canvas/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-5">
          <a
            href="/"
            className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
            Observer
          </a>
          <div className="h-5 w-px bg-border" />
          <BookOpen className="size-4 text-accent" />
          <div>
            <h1 className="text-sm font-semibold">Kite Agent API reference</h1>
            <p className="text-[11px] text-muted-foreground">Build-bundled, read-only OpenAPI</p>
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-5 py-8">
        <aside className="mb-8 grid gap-4 rounded-2xl border border-border bg-surface p-5 md:grid-cols-2">
          <div className="flex gap-3">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-accent" />
            <div>
              <h2 className="text-sm font-medium">Reference only</h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                This page has no execute or Try it controls. It never discovers a Worker, stores a
                credential, or sends an Agent API data-plane request.
              </p>
            </div>
          </div>
          <div className="flex gap-3">
            <FileJson className="mt-0.5 size-5 shrink-0 text-accent" />
            <div>
              <h2 className="text-sm font-medium">Availability is unconfirmed</h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                The contract includes planned routes. Clients must read the authenticated ServerInfo
                capabilities before assuming a resource is available.
              </p>
            </div>
          </div>
        </aside>
        {state.status === 'loading' ? <Status>Loading the bundled contract…</Status> : null}
        {state.status === 'unavailable' ? (
          <Status>The bundled OpenAPI artifact is unavailable for this build.</Status>
        ) : null}
        {state.status === 'ready' ? <Reference spec={state.spec} /> : null}
      </div>
    </main>
  );
}

function Reference({ spec }: { readonly spec: AgentApiOpenApiDocument }) {
  const operations = useMemo(
    () =>
      Object.entries(spec.paths)
        .flatMap(([path, item]) =>
          HTTP_METHODS.flatMap((method) => {
            const operation = item[method];
            return operation ? [{ path, method, operation }] : [];
          }),
        )
        .sort(
          (left, right) =>
            left.path.localeCompare(right.path) || left.method.localeCompare(right.method),
        ),
    [spec],
  );
  const schemaCount = Object.keys(spec.components?.schemas ?? {}).length;
  return (
    <section aria-label="OpenAPI reference">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-accent">
            OpenAPI {spec.openapi}
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight">{spec.info.title}</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            {spec.info.description ?? 'Stable local Agent API contract.'}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-surface px-4 py-3 text-xs text-muted-foreground">
          v{spec.info.version} · {operations.length} operations · {schemaCount} schemas
        </div>
      </div>
      <div className="mb-6 rounded-xl border border-border bg-terminal px-4 py-3 font-mono text-xs text-terminal-copy">
        {spec.servers?.[0]?.url ?? 'http://127.0.0.1:{port}'}
        <span className="ml-3 font-sans text-muted-foreground">
          placeholder, not a live endpoint
        </span>
      </div>
      <div className="grid gap-3">
        {operations.map(({ path, method, operation }) => (
          <article
            key={`${method}:${path}`}
            className="grid gap-3 rounded-xl border border-border bg-surface px-4 py-4 sm:grid-cols-[72px_minmax(0,1fr)]"
          >
            <span className="w-fit rounded-md border border-border-strong bg-canvas px-2 py-1 font-mono text-[11px] font-semibold uppercase text-accent">
              {method}
            </span>
            <div className="min-w-0">
              <code className="break-all text-xs text-copy">{path}</code>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {operation.summary ?? operation.operationId ?? 'Documented operation'}
              </p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function Status({ children }: { readonly children: string }) {
  return (
    <div
      role="status"
      className="rounded-xl border border-border bg-surface p-6 text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

export async function loadBundledSpec(): Promise<AgentApiOpenApiDocument> {
  const response = await fetch(OPENAPI_PATH, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  });
  if (
    response.status !== 200 ||
    response.headers.get('content-type') !== 'application/json; charset=utf-8'
  ) {
    throw new Error('Bundled Agent API contract is unavailable.');
  }
  const value = (await response.json()) as unknown;
  if (!isOpenApiDocument(value)) throw new Error('Bundled Agent API contract is invalid.');
  return value;
}

function isOpenApiDocument(value: unknown): value is AgentApiOpenApiDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const info = record.info;
  return (
    typeof record.openapi === 'string' &&
    Boolean(info) &&
    typeof info === 'object' &&
    !Array.isArray(info) &&
    typeof (info as Record<string, unknown>).title === 'string' &&
    typeof (info as Record<string, unknown>).version === 'string' &&
    Boolean(record.paths) &&
    typeof record.paths === 'object' &&
    !Array.isArray(record.paths)
  );
}
