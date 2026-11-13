import base from '@seamnex/config/eslint/base';
import nodeConfig from '@seamnex/config/eslint/node';
import reactConfig from '@seamnex/config/eslint/react';

/**
 * The composition root. The presets describe a *kind* of code; this file is the only place that
 * says which directories hold that kind, so `apps/api` cannot pick up the Hooks rules by
 * accident and no file can be reached by two presets at once.
 *
 * `base` is spread exactly once. It used to arrive twice — through both the React and the Node
 * preset — which re-evaluated `js.configs.recommended` and the TypeScript preset for every
 * frontend file.
 */
const FRONTEND = [
  'apps/portal/**/*.{ts,tsx}',
  'apps/console/**/*.{ts,tsx}',
  'packages/{api-client,domain,mocks,shell,ui,utils}/**/*.{ts,tsx}',
];

/**
 * A config that only carries `ignores` is a global ignore, and adding `files` to it would
 * demote that ignore to a local one. Everything else gets the frontend scope.
 */
function frontend(config) {
  if (config.ignores !== undefined && config.files === undefined) return config;
  return { ...config, files: FRONTEND };
}

export default [...base, ...reactConfig.map(frontend), ...nodeConfig];
