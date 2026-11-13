import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, loadEnv, type Plugin, type PluginOption, type UserConfigExport } from 'vite';

/**
 * The Vite configuration both SPAs share.
 *
 * The portal and the console are the same build — React 19, Tailwind 4, the MSW seam, the same
 * chunk groups and the same bundle budget — and differ only in ports. Keeping the policy here
 * means a security or mode fix cannot reach one app and miss the other; an app file contributes
 * only what it owns: its directory and its transform plugins.
 */

/**
 * Hostnames the dev and preview servers answer to when `VITE_DEV_ALLOWED_HOSTS` is unset.
 *
 * `localhost`, its subdomains and every IP address are allowed by Vite without appearing here.
 * These two suffixes cover the documented dev flow (browsers reach the SPAs on `localhost`) and
 * the edge's product zone. A container hostname or an external proxy adds its own name through
 * the variable — the alternative, `allowedHosts: true`, accepts any `Host` header and is a DNS
 * rebinding hole, which matters because `host` is `0.0.0.0` and `/api/v1` is proxied.
 */
const defaultAllowedHosts = ['.localhost', '.seamnex.local'];

/** The boot graph every app pre-transforms before the browser asks for it. */
const defaultWarmup = ['./src/main.tsx', './src/app.tsx', './src/session-gate.tsx'];

export interface AppViteConfigOptions {
  /** Absolute path of the app package: the directory holding `vite.config.ts`. */
  root: string;
  /** Dev-server port. `APP_ORIGINS` and the edge name it, so it may not drift. */
  port: number;
  /** Port for `vite preview` of a production or demo bundle. */
  previewPort: number;
  /** Transform plugins the app owns, in order — they carry the framework dependencies. */
  plugins: PluginOption[];
  /** Entry points handed to `server.warmup`, relative to `root`. */
  warmup?: string[];
}

function parseAllowedHosts(value: string | undefined): string[] {
  const hosts = (value ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);

  return hosts.length > 0 ? hosts : defaultAllowedHosts;
}

/** The token the shells print when the root manifest carries no usable version. */
const UNKNOWN_VERSION = 'unknown';

/**
 * The product version the two SPAs display, read from the root manifest on every config build.
 *
 * It is injected rather than imported because the clients run in a browser: they cannot read
 * `package.json` at request time, and serving the manifest from the edge would hand a build file to
 * every visitor. Reading it here means the value is taken from the file each time the dev server
 * starts or a bundle is built, so the console sidebar and the portal footer cannot drift from it or
 * from each other.
 *
 * A manifest that is absent, unparsable, or carries an empty/non-string `version` is not a failure
 * of this step: the value resolves to `unknown` and the shells render "version unavailable".
 * Inventing a number, or dropping the line and leaving a reviewer to guess, would both be worse
 * than saying that the build could not report its own identity.
 */
function readProductVersion(repoRoot: string): string {
  try {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    const version = typeof manifest.version === 'string' ? manifest.version.trim() : '';
    if (version.length === 0) {
      console.warn(
        'package.json carries no usable "version"; the shells will report it as unavailable.',
      );
      return UNKNOWN_VERSION;
    }
    return version;
  } catch (error) {
    // Said out loud: "version unavailable" in the footer is otherwise an unexplained defect.
    console.warn(
      `Cannot read the product version from package.json (${String(error)}); ` +
        'the shells will report it as unavailable.',
    );
    return UNKNOWN_VERSION;
  }
}

/**
 * A production bundle must never contain the mock service worker or the simulation-only
 * scenario endpoint. The demo build runs in `--mode demo`, so it is not affected.
 *
 * The mode check lives in `apply` rather than in a `configResolved` flag: the plugin is then never
 * registered for the demo build at all, instead of running its check on every chunk and returning.
 * `enforce: 'post'` puts the guard after the plugins that still emit into the bundle, so it reads
 * the finished output rather than a snapshot of it.
 */
function assertNoMocksInProduction(): Plugin {
  return {
    name: 'seamnex-no-mocks-in-production',
    apply: (_config, env) => env.command === 'build' && env.mode === 'production',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue;
        if (
          file.code.includes('mockServiceWorker') ||
          file.code.includes('/api/v1/prototype/scenario')
        ) {
          this.error(
            `Mock code reached the production bundle (${file.fileName}). Build the demo with "pnpm build:demo".`,
          );
        }
      }
    },
  };
}

export function createAppConfig({
  root,
  port,
  previewPort,
  plugins,
  warmup = defaultWarmup,
}: AppViteConfigOptions): UserConfigExport {
  const repoRoot = path.resolve(root, '../..');
  const mocksStub = path.resolve(root, 'src/production-mocks-stub.ts');

  return defineConfig(({ mode }) => {
    const production = mode === 'production';
    // Vitest sets `mode` to `test`. Tests always run against the mock platform, whatever the `.env`
    // says: the suites import `@seamnex/mocks` for fixtures and state, so a local `VITE_API_MODE=live`
    // that is convenient for `pnpm dev` must not reach them. This lives here — with the flags and
    // the alias it decides — instead of being restated in `vitest.config.ts`.
    const testing = mode === 'test';
    // The demo build is the reviewer-facing artifact, so it is pinned to the mock platform in code
    // rather than left to whatever `VITE_API_MODE` a developer's untracked `.env` happens to hold.
    // `--mode demo` used to inherit that value, which silently shipped a demo without the mock
    // platform it exists to show.
    const demo = mode === 'demo';
    // One `.env` at the repository root configures the API and both SPAs (see `.env.example`).
    // The explicit prefix is what keeps the rest of that file — database URLs, the root key path —
    // out of the values this config could ever inline into the client bundle.
    const env = loadEnv(mode, repoRoot, 'VITE_');
    const mocks =
      testing || demo || (!production && env.VITE_API_MODE?.trim().toLowerCase() !== 'live');
    // `||`, not `??`: `VITE_API_BASE_URL=` is an origin that was cleared, not one that was omitted,
    // and an empty proxy target fails at request time instead of at startup.
    const apiTarget = env.VITE_API_BASE_URL?.trim() || 'http://localhost:8080';
    const allowedHosts = parseAllowedHosts(env.VITE_DEV_ALLOWED_HOSTS);
    /**
     * The client keeps its relative `/api/v1` base in development, so cookies stay same-origin and
     * no client code changes when the mock adapter is switched off — this proxy is the entire seam
     * swap. `preview` gets the same rule: a production or demo bundle served by `vite preview` has
     * no other way to reach `/api/v1`.
     */
    const apiProxy = {
      '/api/v1': {
        target: apiTarget,
        changeOrigin: false,
      },
    };

    return {
      envDir: repoRoot,
      // Stated rather than inherited from the default: the root `.env` holds secrets, and only this
      // prefix may reach the client bundle.
      envPrefix: 'VITE_',
      // Literals, not expressions: `if (false)` lets the bundler drop the guarded branches.
      define: {
        __SEAMNEX_MOCKS__: JSON.stringify(mocks),
        // Request-side contract validation duplicates the API in production; see `http.ts`.
        __SEAMNEX_CONTRACT_CHECKS__: JSON.stringify(!production),
        // The build's own identity, printed in both footers; see `ProductVersion` in `@seamnex/shell`.
        __SEAMNEX_VERSION__: JSON.stringify(readProductVersion(repoRoot)),
      },
      // The guard is last: it is the only plugin that must see the final bundle.
      plugins: [...plugins, assertNoMocksInProduction()],
      resolve: {
        // Deterministic removal, independent of dead-code elimination.
        alias: mocks
          ? []
          : [
              { find: /^@seamnex\/mocks$/, replacement: mocksStub },
              { find: /^@seamnex\/mocks\/browser$/, replacement: mocksStub },
            ],
      },
      optimizeDeps: {
        /**
         * Both are reachable only through modules the `index.html` scan does not follow: `lucide-react`
         * from lazily imported screens, `@tanstack/react-query` from the linked `@seamnex/api-client`
         * package. Declared here, they are pre-bundled at server start instead of being discovered
         * mid-session, which costs a full page reload on the first navigation to a screen.
         */
        include: ['lucide-react', '@tanstack/react-query'],
      },
      server: {
        host: '0.0.0.0',
        port,
        /**
         * A taken port must fail the start, not shift to the next one: the edge routes this exact
         * port, and the console's 5174 is also the portal's fallback — drifting by one silently
         * swaps the two apps.
         */
        strictPort: true,
        allowedHosts,
        /**
         * Pre-transform the boot graph before the browser requests it. Without this the first paint
         * waits on a per-module request waterfall, which is the bulk of a cold start on a large
         * component library.
         */
        warmup: {
          clientFiles: warmup,
        },
        proxy: apiProxy,
      },
      preview: {
        host: '0.0.0.0',
        port: previewPort,
        strictPort: true,
        allowedHosts,
        proxy: apiProxy,
      },
      build: {
        outDir: 'dist',
        /**
         * `hidden` in production: the maps exist for the error tracker, but they are not referenced
         * from the bundle, so a production deploy does not hand the browser the original TypeScript
         * sources (and does not pay for their transfer on a debugging session). The demo build keeps
         * full maps, because a reviewer reading a stack trace is exactly its audience.
         */
        sourcemap: production ? 'hidden' : true,
        /**
         * Dependencies that never change between deploys get their own chunks, so a screen edit does
         * not invalidate those bytes in the browser cache. `scripts/check-bundle-budget.mjs` guards
         * the result.
         */
        rolldownOptions: {
          output: {
            /**
             * Rolldown's chunking API. `output.manualChunks` is the deprecated Rollup-compatibility
             * shim and is ignored as soon as `codeSplitting` is set.
             *
             * `priority` decides ownership: React is claimed first, so a group that only depends on it
             * (`@tanstack/react-query`'s peer) cannot pull it into its own chunk. `[\\/]` matches both
             * separators, because a module id is not guaranteed to use `/` on Windows.
             *
             * `lucide-react` is deliberately not grouped: a group is one chunk, so every icon any
             * lazily imported screen uses would be hoisted into whatever chunk the entry pulls. The
             * icon set stays with the screens that need it.
             */
            codeSplitting: {
              groups: [
                {
                  name: 'react',
                  test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
                  priority: 30,
                },
                { name: 'router', test: /node_modules[\\/]react-router[\\/]/, priority: 20 },
                {
                  name: 'ui',
                  test: /node_modules[\\/](?:@radix-ui|radix-ui|class-variance-authority|tailwind-merge)[\\/]/,
                  priority: 15,
                },
                { name: 'query', test: /node_modules[\\/]@tanstack[\\/]/, priority: 10 },
              ],
            },
          },
        },
      },
    };
  });
}
