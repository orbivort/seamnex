import { afterEach, describe, expect, it } from 'vitest';
import * as barrel from '../../src/index';
import * as cnModule from '../../src/cn';
import * as downloadModule from '../../src/download';
import * as formatModule from '../../src/format';
import * as paginationModule from '../../src/pagination';

/**
 * `src/index.ts` is the only entry point the workspace resolves (`package.json` has a single `.`
 * export), so a symbol that exists in `src/` but is missing here is unreachable in production even
 * when every per-module suite passes. The barrel itself compiles to re-export bindings and has no
 * statements of its own, which means "test the barrel" can only mean one thing: the published
 * surface, and the identity of every binding on it.
 *
 * The module list is written out rather than discovered so that a new module has to be added to
 * both places — the barrel and this table. Discovery would make the completeness assertion
 * vacuous.
 */
const MODULES = [
  ['cn', cnModule],
  ['download', downloadModule],
  ['format', formatModule],
  ['pagination', paginationModule],
] as const satisfies readonly (readonly [string, Record<string, unknown>])[];

type Published = Map<string, { module: string; value: unknown }>;

/**
 * Every runtime symbol the modules publish, keyed by name. A name published by two modules is an
 * error: `export *` would silently drop it from the barrel (the two `export *` statements make the
 * name ambiguous, and TypeScript omits it), so the barrel would lose an export without any test
 * failing on the module itself.
 */
function published(): Published {
  const seen: Published = new Map();
  for (const [module, namespace] of MODULES) {
    for (const [name, value] of Object.entries(namespace)) {
      const previous = seen.get(name);
      expect(
        previous?.module,
        `${name} is published by both ${previous?.module} and ${module}`,
      ).toBeUndefined();
      seen.set(name, { module, value });
    }
  }
  return seen;
}

const barrelKeys = Object.keys(barrel).sort();

describe('@seamnex/utils entry point', () => {
  it('re-exports every symbol its modules publish, as the same binding', () => {
    for (const [name, { module, value }] of published()) {
      expect(barrel, `${name} from ${module} is missing from the barrel`).toHaveProperty(name);
      expect((barrel as Record<string, unknown>)[name], `${name} is not the same binding`).toBe(
        value,
      );
    }
  });

  it('publishes nothing the modules do not publish', () => {
    const known = new Set(published().keys());

    expect(barrelKeys.filter((key) => !known.has(key))).toEqual([]);
  });

  it('publishes no runtime key for a type-only export', () => {
    // Types are erased; a key here would mean a value was exported under a type's name.
    expect(barrelKeys).not.toContain('FormattingConfig');
    expect(barrelKeys).not.toContain('CursorPage');
  });

  it('publishes the names the package documents', () => {
    for (const name of [
      'cn',
      'DEFAULT_FORMATTING',
      'configureFormatting',
      'formatBytes',
      'formatDate',
      'formatDateTime',
      'formatDuration',
      'formatLatency',
      'formatNumber',
      'formatPercent',
      'formatRelative',
      'formattingConfig',
      'ordinal',
      'truncateMiddle',
      'sliceByCursor',
      'downloadJson',
    ]) {
      expect(barrelKeys, `barrel is missing ${name}`).toContain(name);
    }
  });
});

/**
 * Identity above already implies the behaviour, so these cases are the edge cases rather than a
 * second copy of each module suite: a value the formatter has to defend against, a boundary, and
 * the sentinel the caller relies on.
 */
afterEach(() => {
  barrel.configureFormatting(barrel.DEFAULT_FORMATTING);
});

describe('the entry point is usable as the only import', () => {
  it('formats bytes at and below the unit boundaries', () => {
    expect(barrel.formatBytes(0)).toBe('0 B');
    expect(barrel.formatBytes(-1)).toBe('0 B');
    expect(barrel.formatBytes(Number.NaN)).toBe('0 B');
    expect(barrel.formatBytes(1023)).toBe('1023 B');
    expect(barrel.formatBytes(1024)).toBe('1.0 KB');
    expect(barrel.formatBytes(1024 ** 2)).toBe('1.0 MB');
  });

  it('renders a latency in the unit that keeps its precision', () => {
    expect(barrel.formatLatency(-1)).toBe('unknown');
    expect(barrel.formatLatency(Number.POSITIVE_INFINITY)).toBe('unknown');
    expect(barrel.formatLatency(42)).toBe('42 ms');
    expect(barrel.formatLatency(1_000)).toBe('1 s');
  });

  it('formats durations across the hour and day boundaries', () => {
    expect(barrel.formatDuration(Number.NaN)).toBe('unknown');
    expect(barrel.formatDuration(59)).toBe('59 min');
    expect(barrel.formatDuration(60)).toBe('1 h');
    expect(barrel.formatDuration(90)).toBe('1 h 30 min');
    expect(barrel.formatDuration(1_440)).toBe('1 d');
  });

  it('renders an unparseable instant as the sentinel, not as an exception', () => {
    expect(barrel.formatDateTime('not-a-date')).toBe('unknown');
    expect(barrel.formatDate('not-a-date')).toBe('unknown');
    expect(barrel.formatRelative('not-a-date', new Date('2026-11-05T12:00:00Z'))).toBe('unknown');
  });

  it('ordinalises the teens separately from the units', () => {
    expect(barrel.ordinal(1)).toBe('1st');
    expect(barrel.ordinal(2)).toBe('2nd');
    expect(barrel.ordinal(3)).toBe('3rd');
    expect(barrel.ordinal(4)).toBe('4th');
    expect(barrel.ordinal(11)).toBe('11th');
    expect(barrel.ordinal(12)).toBe('12th');
    expect(barrel.ordinal(13)).toBe('13th');
    expect(barrel.ordinal(21)).toBe('21st');
  });

  it('only truncates when the value is longer than both halves plus the ellipsis', () => {
    const exact = 'a'.repeat(12 + 8 + 1);

    expect(barrel.truncateMiddle(exact)).toBe(exact);
    // One character over the budget is enough to cut; the tail keeps the last eight characters.
    expect(barrel.truncateMiddle(`${exact}b`)).toBe(`${'a'.repeat(12)}…${'a'.repeat(7)}b`);
  });

  it('clamps a cursor page limit instead of trusting it', () => {
    const items = Array.from({ length: 150 }, (_, index) => index);

    expect(barrel.sliceByCursor(items, null, 0).items).toEqual([0]);
    expect(barrel.sliceByCursor(items, null, 1_000).items).toHaveLength(100);
    // An unparseable cursor starts at the beginning rather than throwing.
    expect(barrel.sliceByCursor(items, 'abc', 2).items).toEqual([0, 1]);
    expect(barrel.sliceByCursor(items, '-5', 2).items).toEqual([0, 1]);
  });

  it('reports the next cursor as null once the last page is served', () => {
    const page = barrel.sliceByCursor([1, 2, 3], '2', 2);

    expect(page).toEqual({ items: [3], nextCursor: null, total: 3 });
    expect(barrel.sliceByCursor([1, 2, 3], null, 2).nextCursor).toBe('2');
  });

  it('resolves conflicting utilities through cn', () => {
    expect(barrel.cn('p-2', 'p-4')).toBe('p-4');
    expect(barrel.cn('p-2', undefined, false, { hidden: false })).toBe('p-2');
  });
});
