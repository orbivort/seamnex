/**
 * FR-5.5 — does a mapping's `from` path exist in an item?
 *
 * The sample parser offers paths like `_embedded.elements[0].subject` and `["first name"]`, and the
 * compiler turns the same text into `$json.…`. Validation had no way to ask whether any of them
 * describe the record a step actually received: it compared mappings with the *target* schema only,
 * so four paths that did not exist read as a clean definition while the write posted an empty body
 * the product refused.
 *
 * `null` means "not a path this helper understands" — an author may have typed something else, and
 * guessing about it would be worse than staying quiet.
 */
export type PathVerdict = boolean | null;

const BARE_KEY = /^[A-Za-z_$][\w$]*/;

/** `a.b[0]["odd.key"]` → `['a', 'b', 0, 'odd.key']`, or `null` when the text is not such a path. */
export function pathSegments(path: string): (string | number)[] | null {
  const text = path.trim();
  const segments: (string | number)[] = [];
  let index = 0;

  while (index < text.length) {
    const character = text[index];
    if (character === '.') {
      index += 1;
      continue;
    }
    if (character === '[') {
      const close = text.indexOf(']', index);
      if (close === -1) return null;
      const inner = text.slice(index + 1, close).trim();
      if (/^\d+$/.test(inner)) segments.push(Number(inner));
      else if (/^(["']).*\1$/.test(inner)) segments.push(inner.slice(1, -1));
      else return null;
      index = close + 1;
      continue;
    }
    const match = BARE_KEY.exec(text.slice(index));
    if (match === null) return null;
    segments.push(match[0]);
    index += match[0].length;
  }

  return segments;
}

/**
 * `true` when the path resolves (a `null` value still counts), `false` when a key or index is
 * missing, `null` when the path cannot be read as one.
 */
export function resolvesPath(item: unknown, path: string): PathVerdict {
  const segments = pathSegments(path);
  if (segments === null) return null;

  let current: unknown = item;
  for (const segment of segments) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || segment >= current.length) return false;
      current = current[segment];
      continue;
    }
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return false;
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, segment)) return false;
    current = record[segment];
  }

  return true;
}
