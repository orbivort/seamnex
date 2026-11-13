import { resolveKey } from '@seamnex/domain';
import {
  signInToProduct,
  verifyProductSession,
  type DriverOptions,
  type ProductLoginInput,
  type ProductLoginResult,
  type SessionCheck,
} from './product-login.driver';
import { orangeHrmLogin } from './adapters/orangehrm-login';

/**
 * ADR-BE-22 §"One role, one hop" — the seam between the orchestration and a product's login form.
 *
 * Everything the relay does around a sign-in is product-neutral: the launch hop, the session cache
 * and its TTL bound, the single-flight lock, the per-user secret scope, the audit chain, the cookie
 * planting and the fallback to the product's own page. What is *not* product-neutral is four facts
 * per product — where the form lives, how it carries its CSRF token, how it says "no", and how a
 * session is confirmed. This interface is exactly those four facts, so a second product is an
 * adapter rather than a branch inside the service.
 *
 * Deliberately absent: a driver registry that picks by *class*. `native` and `fa_header` products
 * have no login form to drive, and the relay must never grow a path that pretends otherwise.
 */
export type SessionVerifyInput = {
  /** Internal origin on the instance network (`http://orangehrm:80`); never the public one. */
  readonly origin: string;
  /** What a browser uses (`http://orangehrm.localhost:8020`), for `Host`, `Origin`, `Referer`. */
  readonly publicOrigin: string;
  /** The login this session is supposed to belong to. */
  readonly username: string;
  readonly cookies: readonly string[];
};

export interface ProductLoginAdapter {
  /** A stable label for logs and audit detail; two products sharing one would be indistinguishable. */
  readonly name: string;
  /** One attempt, fail closed. Never throws: a failure is a verdict the caller falls back from. */
  signIn(input: ProductLoginInput, options: DriverOptions): Promise<ProductLoginResult>;
  /** Is a cached product cookie still worth planting? */
  verify(input: SessionVerifyInput, options: DriverOptions): Promise<SessionCheck>;
}

/**
 * The OpenProject adapter is the D9 driver unchanged: the registry exists so a second product does
 * not have to alter the code the first one is verified against.
 */
const openProjectLogin: ProductLoginAdapter = {
  name: 'openproject',
  signIn: (input, options) => signInToProduct(input, options),
  verify: (input, options) => verifyProductSession(input, options),
};

/**
 * Keyed by the **composed** catalogue key (`D07-01`), because `resolveKey` maps the operator's
 * legacy spelling (`D7`) onto it. Keying by the short form would have re-created the string-compare
 * defect ADR-BE-22 records: `D7` and `D07-01` are the same entry and must resolve to one adapter.
 */
const ADAPTERS: Readonly<Record<string, ProductLoginAdapter>> = {
  'D09-01': openProjectLogin,
  'D07-01': orangeHrmLogin,
};

/**
 * The adapter for a catalogue entry, or `null` when the relay has nothing to drive for it.
 *
 * `null` is the normal answer for every product that signs in natively, and the service treats it
 * as "decline the launch" rather than as an error: the browser then sees the product's own page,
 * which is today's behaviour.
 */
export function loginAdapterFor(entryKey: string): ProductLoginAdapter | null {
  const canonical = resolveKey(entryKey.trim().toUpperCase());
  return ADAPTERS[canonical] ?? null;
}
