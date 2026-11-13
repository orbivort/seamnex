import { Inject, Injectable } from '@nestjs/common';
import { resolveKey } from '@seamnex/domain';
import { ProductApiClient } from './product-api.client';
import { OrangeHrmApiClient } from './adapters/orangehrm-api';
import type { ProductProvisioningAdapter } from './provisioning-adapter';

/**
 * ADR-BE-22 §Credentials — which admin API answers for a catalogue entry.
 *
 * Keyed by the composed catalogue key, for the same reason the login registry is: `resolveKey`
 * maps the operator's `D7` onto `D07-01`, and an entry must resolve to one adapter whichever
 * spelling reached this module.
 *
 * A missing adapter is not an error. It means the platform cannot create an account in that
 * product, so mappings are created by hand — the state ADR-BE-22 already describes for a product
 * whose admin credential nobody supplied.
 */
@Injectable()
export class ProductApiAdapters {
  private readonly byEntry: ReadonlyMap<string, ProductProvisioningAdapter>;

  constructor(
    @Inject(ProductApiClient) openproject: ProductApiClient,
    @Inject(OrangeHrmApiClient) orangehrm: OrangeHrmApiClient,
  ) {
    this.byEntry = new Map<string, ProductProvisioningAdapter>([
      ['D09-01', openproject],
      ['D07-01', orangehrm],
    ]);
  }

  for(entryKey: string): ProductProvisioningAdapter | null {
    return this.byEntry.get(resolveKey(entryKey.trim().toUpperCase())) ?? null;
  }
}
