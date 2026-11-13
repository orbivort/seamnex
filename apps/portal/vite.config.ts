import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createAppConfig } from '@seamnex/config/vite/app';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Only what the portal owns: its directory, its ports and its transform plugins.
 *
 * Everything else — the `mock`/`live` seam and the `@seamnex/mocks` alias, the `__SEAMNEX_*` flags, the
 * `/api/v1` proxy, `allowedHosts`, `strictPort`, chunk groups and source maps — is policy shared
 * with the console and lives in `@seamnex/config/vite/app`. A fix there reaches both apps at once.
 */
export default createAppConfig({
  root: here,
  port: 5173,
  previewPort: 4173,
  plugins: [react(), tailwindcss()],
});
