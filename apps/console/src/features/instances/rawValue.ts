/**
 * A masked value has no readable content by construction, so the edit field starts empty rather
 * than showing the mask as if it were the stored secret.
 */
export function rawValue(value: string | null, masked: boolean): string {
  if (masked) return '';
  return value ?? '';
}
