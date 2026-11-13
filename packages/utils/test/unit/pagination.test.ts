import { describe, expect, it } from 'vitest';
import { sliceByCursor } from '../../src/pagination';

const items = ['a', 'b', 'c', 'd', 'e'];

describe('sliceByCursor', () => {
  it('returns the first page and the cursor that follows it', () => {
    expect(sliceByCursor(items, null, 2)).toEqual({
      items: ['a', 'b'],
      nextCursor: '2',
      total: 5,
    });
  });

  it('continues from the cursor it handed out', () => {
    expect(sliceByCursor(items, '2', 2)).toEqual({
      items: ['c', 'd'],
      nextCursor: '4',
      total: 5,
    });
  });

  it('ends with a null cursor exactly when the list is exhausted', () => {
    expect(sliceByCursor(items, '4', 2).nextCursor).toBeNull();
    // A page that lands exactly on the last item is still the end.
    expect(sliceByCursor(items, '3', 2).nextCursor).toBeNull();
  });

  it('clamps the limit to the range the API serves', () => {
    expect(sliceByCursor(items, null, 0).items).toEqual(['a']);
    expect(sliceByCursor(items, null, 500).items).toEqual(items);
  });

  it('treats a malformed or negative cursor as the start rather than throwing', () => {
    expect(sliceByCursor(items, 'not-a-cursor', 2).items).toEqual(['a', 'b']);
    expect(sliceByCursor(items, '-5', 2).items).toEqual(['a', 'b']);
  });

  it('reports the total independently of the page size', () => {
    expect(sliceByCursor(items, '0', 1).total).toBe(5);
    expect(sliceByCursor([], null, 10)).toEqual({ items: [], nextCursor: null, total: 0 });
  });
});
