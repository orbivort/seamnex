import type { RegistryEntry } from '@seamnex/domain';

export const REGISTRY_SERVICE = Symbol('seamnex.m12.registry');

/** Owns `registry_snapshot`; the projection is rebuilt from instances and integration metadata. */
export interface RegistryService {
  entries(): Promise<RegistryEntry[]>;
  entry(slug: string): Promise<RegistryEntry>;
  stale(): Promise<RegistryEntry[]>;
}
