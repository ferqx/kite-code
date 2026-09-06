import { Navigate, Route, Routes } from 'react-router';
import { ApiDocs } from '@/api-docs/api-docs';
import { App } from '@/app/app';
import type { WebRestTransport } from '@/transport/client';

export function KiteRoutes({ transport }: { readonly transport?: WebRestTransport }) {
  return (
    <Routes>
      <Route path="/" element={<App transport={transport} />}>
        <Route index element={<RouteEndpoint />} />
        <Route path="sessions/:sessionId" element={<RouteEndpoint />} />
      </Route>
      <Route path="/api-docs" element={<ApiDocs />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function RouteEndpoint() {
  return null;
}
