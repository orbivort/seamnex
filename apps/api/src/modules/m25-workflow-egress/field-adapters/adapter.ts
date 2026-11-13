import type { FieldDescriptor } from '@seamnex/domain';

/**
 * One product's translation of its own metadata into the platform's field descriptors.
 *
 * Everything product-specific lives behind this type: the path, the auth (the egress service owns
 * that), the parsing and the "this product cannot describe itself" verdict. A new product is an
 * adapter, not a branch in the service.
 */
export type FieldAdapter = {
  readonly entryKey: string;
  readonly method: 'GET' | 'POST';
  /** A constant path on the product. Never built from user input. */
  readonly path: string;
  readonly supports: (operation: string) => boolean;
  /** Shown when `supports` is false or the product answered with a shape that cannot be read. */
  readonly unsupportedDetail: string;
  readonly extract: (body: unknown, operation: string) => FieldDescriptor[];
};

/** Narrow a nested object without asserting a shape. */
export function objectAt(value: unknown, ...path: string[]): Record<string, unknown> | null {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current !== 'object' || current === null || Array.isArray(current)) return null;
  return current as Record<string, unknown>;
}
