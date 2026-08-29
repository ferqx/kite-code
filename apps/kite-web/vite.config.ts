import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const canonicalOpenApi = fileURLToPath(
  new URL('../../packages/agent-api-contract/generated/openapi.json', import.meta.url),
);

function bundleAgentApiSpec(): Plugin {
  return {
    name: 'bundle-agent-api-spec',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'api-docs/openapi.json',
        source: readFileSync(canonicalOpenApi),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), bundleAgentApiSpec()],
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: { strictPort: false },
});
