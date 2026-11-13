/**
 * Two letters for an avatar, from the words of a display name.
 *
 * Both surfaces that render a person — the directory mirror (`/admin/users`) and the signed-in
 * identity (`/me`, the console header) — computed this as `name.slice(0, 4)`. That is a truncation,
 * not initials: "Platform Administrator" rendered as "PLAT" and "CRM Administrator" as "CRM " with
 * a trailing space. A name with two or more words contributes the first letters of the first and
 * last word; a single word contributes its first two characters. `IdpUserSchema.initials` allows
 * 1–4 characters, so the result always fits the badge.
 */
export function initialsOf(displayName: string): string {
  const words = displayName.split(/[\s._-]+/).filter((word) => word.length > 0);
  const first = words[0];
  if (first === undefined) return '?';
  // The guard above proves `words` is not empty, so the last index exists; `filter` never leaves a
  // hole for this read to fall into, which is why there is no fallback here.
  const last = words[words.length - 1] as string;
  const letters = words.length >= 2 ? `${first.charAt(0)}${last.charAt(0)}` : first.slice(0, 2);
  return letters.toUpperCase();
}
