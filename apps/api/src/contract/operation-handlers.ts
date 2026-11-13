import { Inject, Injectable } from '@nestjs/common';
import type { OperationHandler } from './operation-handler';

/** A handler group is one injectable class per domain tag; it owns no HTTP concerns. */
export interface OperationGroup {
  readonly tag: string;
  handlers(): ReadonlyMap<string, OperationHandler>;
}

export const OPERATION_GROUPS = Symbol('seamnex.contract.operation-groups');
export const OPERATION_HANDLERS = Symbol('seamnex.contract.operation-handlers');

/**
 * The single handler registry. Built at boot from the injected groups, so the dispatcher never
 * imports a handler module directly and a duplicate key fails the process rather than silently
 * shadowing another domain.
 */
@Injectable()
export class OperationHandlers {
  private readonly map = new Map<string, OperationHandler>();
  private readonly tags = new Map<string, string>();

  constructor(@Inject(OPERATION_GROUPS) groups: readonly OperationGroup[]) {
    for (const group of groups) {
      for (const [key, handler] of group.handlers()) {
        const owner = this.tags.get(key);
        if (owner !== undefined) {
          throw new Error(`${key} is implemented twice (${owner} and ${group.tag}).`);
        }
        this.tags.set(key, group.tag);
        this.map.set(key, handler);
      }
    }
  }

  get(key: string): OperationHandler | undefined {
    return this.map.get(key);
  }

  keys(): string[] {
    return [...this.map.keys()].sort();
  }

  get size(): number {
    return this.map.size;
  }

  tagOf(key: string): string | undefined {
    return this.tags.get(key);
  }
}
