import { describe, expect, it } from 'vitest';
import { initialsOf } from '../../../../src/common/identity/initials';

/**
 * The initials are a *rendering* of a display name, so the cases that matter are the ones a real
 * directory produces: a one-character surname, an accented name (the badge must upper-case it, not
 * keep it lower-case), and a name that starts with a separator. Every result has to stay inside the
 * schema's 1–4 character window, because the badge is what renders it.
 */
describe('names a directory actually contains', () => {
  it('takes both letters from a two-word name whose surname is one character', () => {
    expect(initialsOf('Alice B')).toBe('AB');
    expect(initialsOf('Li Wu')).toBe('LW');
  });

  it('upper-cases an accented name rather than leaving it as typed', () => {
    expect(initialsOf('émile zola')).toBe('ÉZ');
  });

  it('ignores a leading separator and uses the first word that has letters', () => {
    expect(initialsOf('  alice cooper')).toBe('AC');
    expect(initialsOf('_.-alice cooper')).toBe('AC');
  });

  it('treats a digit in a username as a word, so a login name still gets a badge', () => {
    expect(initialsOf('release 42')).toBe('R4');
  });

  it('uses the first and last word, not the first two', () => {
    expect(initialsOf('Alice B. Cooper')).toBe('AC');
    expect(initialsOf('alice b cooper dee')).toBe('AD');
  });
});

describe('the schema window', () => {
  it('never returns more than two characters, whatever the separator mix', () => {
    for (const name of ['a.b_c-d e', '  ', 'x', 'alice.bob.cooper']) {
      expect(initialsOf(name).length).toBeLessThanOrEqual(4);
    }
  });

  it('is stable: the same display name always renders the same badge', () => {
    expect(initialsOf('Crm Administrator')).toBe(initialsOf('Crm Administrator'));
  });
});
