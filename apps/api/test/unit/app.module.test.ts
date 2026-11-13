import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { OPERATION_GUARDS, type OperationGuard } from '../../src/contract/guards/operation-guard';
import { OPERATION_GROUPS, OperationHandlers } from '../../src/contract/operation-handlers';
import { ProblemFilter } from '../../src/common/problem/problem.filter';
import { RequestContextInterceptor } from '../../src/bootstrap/request-context.interceptor';
import { OperationGuardBridge } from '../../src/contract/guards/nest-guard.bridge';

/**
 * `AppModule` is the composition root, and two of its providers are factory functions whose only
 * job is to fix an order: the guard chain evaluates in registration order, and the handler groups
 * are merged in a fixed sequence so a later phase cannot shadow an earlier route. Neither is
 * reachable through the HTTP contract, so both are invoked here through the metadata Nest itself
 * reads. A module that quietly stops registering one of them would otherwise only fail at boot.
 */
type Provider = {
  readonly provide?: unknown;
  readonly useFactory?: (...args: never[]) => unknown;
  readonly useClass?: unknown;
};

const providers = (Reflect.getMetadata('providers', AppModule) ?? []) as Provider[];

function providerFor(token: unknown): Provider {
  const provider = providers.find((entry) => entry?.provide === token);
  if (provider === undefined) throw new Error(`no provider registered for ${String(token)}`);
  return provider;
}

describe('AppModule composition', () => {
  it('registers the cross-cutting concerns as framework primitives', () => {
    expect(providerFor(APP_FILTER).useClass).toBe(ProblemFilter);
    expect(providerFor(APP_INTERCEPTOR).useClass).toBe(RequestContextInterceptor);
    expect(providerFor(APP_GUARD).useClass).toBe(OperationGuardBridge);
  });

  it('keeps the guard chain in evaluation order', () => {
    const factory = providerFor(OPERATION_GUARDS).useFactory;
    const guards = [
      { phase: 'csrf' },
      { phase: 'identity' },
      { phase: 'policy' },
      { phase: 'rate-limit' },
    ];

    expect(factory?.(...(guards as never[]))).toEqual(guards);
  });

  it('keeps every handler group, in declaration order', () => {
    const factory = providerFor(OPERATION_GROUPS).useFactory;
    const groups = Array.from({ length: 10 }, (_, index) => ({ index }));

    expect(factory?.(...(groups as never[]))).toEqual(groups);
  });

  it('registers the dispatcher itself', () => {
    expect(providers).toContain(OperationHandlers);
  });

  it('imports the modules whose routes the dispatcher resolves', () => {
    const imports = (Reflect.getMetadata('imports', AppModule) ?? []) as unknown[];
    expect(imports.length).toBeGreaterThanOrEqual(25);
    expect((Reflect.getMetadata('controllers', AppModule) ?? []).length).toBe(1);
  });
});

describe('operation guard contract', () => {
  it('exposes the guards token as a symbol', () => {
    expect(typeof OPERATION_GUARDS).toBe('symbol');
    // The type is structural; the value is what the container resolves.
    const guard: OperationGuard = { phase: 'after-context', canActivate: async () => undefined };
    expect(guard.phase).toBe('after-context');
  });
});
