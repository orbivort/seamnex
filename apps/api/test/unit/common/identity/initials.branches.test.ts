import { describe, expect, it } from 'vitest';
import { initialsOf } from '../../../../src/common/identity/initials';

/**
 * The branch table for `initialsOf`, one suite per decision in the function.
 *
 * The other two suites answer "what does a real directory name render as"; this one walks each
 * decision the function makes so a broken guard or a swapped arm fails here first, with a name that
 * says which decision it was. The decisions are:
 *
 * 1. `first === undefined` — no word survived the split.
 * 2. `words.length >= 2` — one word or many.
 * 3. the separator class used by `split`.
 * 4. `toUpperCase()` on the assembled letters.
 *
 * Each of these is a branch in the coverage report, so the table doubles as the reason the module
 * reaches 100 % of them: `words` is the output of `filter`, which is always dense, so
 * `length >= 2` implies both `words[0]` and `words[length - 1]` are strings. The many-word arm used
 * to carry a `?? ''` fallback for a missing last entry — a branch no string could reach, and one
 * no test could cover without fabricating a `split`/`filter` pair whose shape no string produces.
 * It is gone rather than covered by an assertion about coverage instead of behaviour.
 */
describe('decision 1: no word survives the split', () => {
  it('answers the placeholder for an empty name', () => {
    expect(initialsOf('')).toBe('?');
  });

  it('answers the placeholder for whitespace other than a space', () => {
    // `\s` covers the full class, so a name made of tabs and newlines is empty in the same way.
    expect(initialsOf('\t\n')).toBe('?');
    expect(initialsOf('\u00a0')).toBe('?');
  });

  it('answers the placeholder for a name made only of separators', () => {
    expect(initialsOf('. _ -')).toBe('?');
    expect(initialsOf('---')).toBe('?');
  });
});

describe('decision 2: one word or many', () => {
  it('takes two characters from the one word it was given', () => {
    expect(initialsOf('abacus')).toBe('AB');
    expect(initialsOf('ab')).toBe('AB');
  });

  it('takes the one character a single-character word can offer', () => {
    expect(initialsOf('a')).toBe('A');
    expect(initialsOf('Q')).toBe('Q');
  });

  it('switches to first-plus-last as soon as a second word appears', () => {
    expect(initialsOf('a b')).toBe('AB');
    expect(initialsOf('Ada Byron King Lovelace')).toBe('AL');
  });
});

describe('decision 3: the separator class', () => {
  it('splits on any whitespace, not only on the space', () => {
    expect(initialsOf('alice\tbob')).toBe('AB');
    expect(initialsOf('alice\nbob')).toBe('AB');
    expect(initialsOf('alice\r\nbob')).toBe('AB');
    expect(initialsOf('\u00a0alice\u00a0bob\u00a0')).toBe('AB');
  });

  it('splits on a run of separators without producing empty words', () => {
    expect(initialsOf('...alice...bob...')).toBe('AB');
    expect(initialsOf('alice _.- bob')).toBe('AB');
  });
});

describe('decision 4: upper-casing', () => {
  it('upper-cases an already upper-case name to itself', () => {
    expect(initialsOf('ALICE BOB')).toBe('AB');
  });

  it('upper-cases a mixed-case name', () => {
    expect(initialsOf('aBc dEf')).toBe('AD');
  });

  it('upper-cases digits and punctuation without changing them', () => {
    expect(initialsOf('release 42')).toBe('R4');
    expect(initialsOf('#tags here')).toBe('#H');
  });

  it('can widen a letter, and the widest case still fits the badge', () => {
    // German sharp s upper-cases to "SS": two of them are the four-character limit exactly, which is
    // the boundary the schema allows and the reason the badge is allowed four characters at all.
    expect(initialsOf('ß')).toBe('SS');
    expect(initialsOf('ßa ßb')).toBe('SSSS');
  });
});
