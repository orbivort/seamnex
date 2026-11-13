const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A path parameter that is not a UUID cannot address a row, and passing it to PostgreSQL would
 * raise `22P02` — a 500 for what is a 404. Validating first keeps the problem document honest.
 */
export function isUuid(value: string | undefined): value is string {
  return typeof value === 'string' && UUID.test(value);
}
