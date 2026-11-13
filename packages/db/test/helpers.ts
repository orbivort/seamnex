/**
 * The suite-local name for the shared test support. The implementation lives in `src/testing.ts`
 * because `@seamnex/api` needs the same throwaway-database behaviour, and a copy would drift.
 */
export {
  ADMIN_URL,
  createTestDatabase,
  hasDatabase,
  insertCatalogEntry,
  insertInstance,
  skipUnlessDatabase,
  type TestDatabase,
} from '../src/testing';
