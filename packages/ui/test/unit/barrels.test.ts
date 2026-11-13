import { describe, expect, it } from 'vitest';
import * as root from '../../src/index';
import * as charts from '../../src/charts/index';
import * as layout from '../../src/layout/index';
import * as patterns from '../../src/patterns/index';
import * as primitives from '../../src/primitives/index';

/**
 * The subpath barrels exist so a screen that wants two primitives does not widen its module graph
 * to the charts and the shell. They are additive, which means the only thing that can go wrong is
 * drift: a name exported from the root and forgotten in a subpath (or the reverse). That is what
 * these tests check — every export of every barrel is the same binding the root barrel publishes.
 */
const BARRELS: [name: string, barrel: Record<string, unknown>][] = [
  ['primitives', primitives],
  ['patterns', patterns],
  ['charts', charts],
  ['layout', layout],
];

describe('barrels', () => {
  it('re-export every subpath name from the root barrel, as the same binding', () => {
    for (const [name, barrel] of BARRELS) {
      const missing = Object.keys(barrel).filter((key) => !(key in root));
      expect(missing, `${name} exports missing from the root barrel`).toEqual([]);
      for (const key of Object.keys(barrel)) {
        expect(barrel[key], `${name}.${key} differs from the root export`).toBe(
          (root as Record<string, unknown>)[key],
        );
      }
    }
  });

  it('publishes the components the package documents', () => {
    expect(primitives.Button).toBeTypeOf('function');
    expect(primitives.DataTable).toBeTypeOf('function');
    expect(primitives.ErrorBoundary).toBeTypeOf('function');
    expect(primitives.toneBox).toBeTypeOf('function');
    expect(patterns.FilterBar).toBeTypeOf('function');
    expect(charts.Sparkline).toBeTypeOf('function');
    expect(layout.AppShell).toBeTypeOf('function');
  });

  it('keeps the root barrel complete', () => {
    // A sample across every module the root barrel re-exports from.
    for (const name of [
      'Button',
      'IconButton',
      'Field',
      'Input',
      'Badge',
      'StatusPill',
      'Panel',
      'Stat',
      'TableToolbar',
      'defineColumns',
      'Tabs',
      'TabPanel',
      'ConfirmDialog',
      'Drawer',
      'Alert',
      'ProgressBar',
      'Splash',
      'Countdown',
      'useNow',
      'Tooltip',
      'TooltipProvider',
      'isChunkLoadError',
      'Stepper',
      'Avatar',
      'CopyButton',
      'Pagination',
      'Grid',
      'SearchField',
      'toneBar',
      'AppShell',
      'PageHeader',
      'FilterChip',
      'CapacityRuler',
      'Meter',
    ]) {
      expect(
        (root as Record<string, unknown>)[name],
        `root barrel is missing ${name}`,
      ).toBeDefined();
    }
  });
});
