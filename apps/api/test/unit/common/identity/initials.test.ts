import { describe, expect, it } from 'vitest';
import { initialsOf } from '../../../../src/common/identity/initials';

describe('initialsOf', () => {
  it('takes the first and last initial of a multi-word name', () => {
    expect(initialsOf('Platform Administrator')).toBe('PA');
    expect(initialsOf('CRM Administrator')).toBe('CA');
    expect(initialsOf('Alice B. Cooper')).toBe('AC');
  });

  it('uses the first two characters of a single word', () => {
    expect(initialsOf('alice')).toBe('AL');
    expect(initialsOf('A')).toBe('A');
  });

  it('treats a dot, an underscore and a dash as word separators', () => {
    expect(initialsOf('alice.bob')).toBe('AB');
    expect(initialsOf('alice_bob')).toBe('AB');
    expect(initialsOf('alice-bob')).toBe('AB');
  });

  it('ignores repeated and surrounding separators', () => {
    expect(initialsOf('  alice   bob  ')).toBe('AB');
    expect(initialsOf('alice..bob')).toBe('AB');
  });

  it('upper-cases the result whatever the input casing', () => {
    expect(initialsOf('alice BOB')).toBe('AB');
  });

  it('answers a placeholder for an empty or separator-only name', () => {
    for (const name of ['', '   ', '...', '_-_']) expect(initialsOf(name)).toBe('?');
  });

  it('always fits the badge schema, which allows one to four characters', () => {
    for (const name of ['a', 'ab', 'Alice Cooper', 'x y', '?']) {
      const initials = initialsOf(name);
      expect(initials.length).toBeGreaterThanOrEqual(1);
      expect(initials.length).toBeLessThanOrEqual(4);
    }
  });
});
