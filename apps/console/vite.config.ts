import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createAppConfig } from '@seamnex/config/vite/app';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Only what the console owns: its directory, its ports and its transform plugins.
 *
 * Everything else — the `mock`/`live` seam and the `@seamnex/mocks` alias, the `__SEAMNEX_*` flags, the
 * `/api/v1` proxy, `allowedHosts`, `strictPort`, chunk groups and source maps — is policy shared
 * with the portal and lives in `@seamnex/config/vite/app`. A fix there reaches both apps at once.
 */
export default createAppConfig({
  root: here,
  // 5174 is the portal's fallback, so `strictPort` in the preset is what keeps the two apart.
  port: 5174,
  previewPort: 4174,
  plugins: [react(), tailwindcss()],
});
