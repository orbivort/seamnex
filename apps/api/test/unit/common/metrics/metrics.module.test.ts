import { describe, expect, it } from 'vitest';
import { MetricsModule } from '../../../../src/common/metrics/metrics.module';
import { METRICS } from '../../../../src/common/metrics/metrics';

describe('MetricsModule', () => {
  it('builds one registry stamped with the process role', async () => {
    const providers = Reflect.getMetadata('providers', MetricsModule) as Array<{
      provide: symbol;
      useFactory: (config: unknown) => {
        registry: { metrics: () => Promise<string> };
      };
    }>;
    const provider = providers.find((candidate) => candidate.provide === METRICS);
    expect(provider).toBeDefined();

    const metrics = provider?.useFactory({ SEAMNEX_ROLE: 'broker-proxy' });
    const text = await metrics?.registry.metrics();

    expect(text).toContain('role="broker-proxy"');
    expect(text).toContain('seamnex_role_up');
  });

  it('exports the token it provides', () => {
    expect(Reflect.getMetadata('exports', MetricsModule)).toContain(METRICS);
  });
});
