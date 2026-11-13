/**
 * S3 target contract check (ADR-BE-11).
 *
 * The dev stack's backup target is VersityGW, a gateway rather than a server with a health API:
 * a TCP healthcheck in compose proves the listener, nothing more. This script proves the part that
 * matters — that the endpoint speaks S3, honours the configured credentials, persists objects and
 * refuses anonymous access. A backup runner that cannot do any of those four is discovered here
 * rather than at the first restore drill.
 *
 * It follows the same skip rule as the database suites: with no endpoint listening the run is
 * skipped, because most local runs have no stack up. `SEAMNEX_REQUIRE_S3_TESTS=1` (CI, pre-release)
 * turns the skip into a failure.
 *
 *   pnpm check:s3
 */
import { createHash, createHmac } from 'node:crypto';

const ENDPOINT = (process.env.S3_ENDPOINT ?? 'http://localhost:9000').replace(/\/+$/, '');
const ACCESS_KEY = process.env.S3_ACCESS_KEY ?? 'seamnex_s3';
const SECRET_KEY = process.env.S3_SECRET_KEY ?? 'seamnex_s3_dev_password';
const BUCKET = process.env.S3_BUCKET ?? 'seamnex-backups';
const REGION = process.env.S3_REGION ?? 'us-east-1';
const REQUIRED = process.env.SEAMNEX_REQUIRE_S3_TESTS === '1';
const SERVICE = 's3';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

/**
 * SigV4 canonical query string: keys and values URI-encoded, then sorted by key. Signing the raw
 * `?prefix=platform/` string instead is the classic 403 — the `/` must travel as `%2F`.
 */
function canonicalQuery(params = {}) {
  return Object.entries(params)
    .map(([key, value]) => [encodeURIComponent(key), encodeURIComponent(value)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

/** Minimal SigV4, path-style. Enough to prove the endpoint accepts a real S3 request. */
async function signed(method, path, options = {}) {
  const query = canonicalQuery(options.query);
  const url = new URL(`${ENDPOINT}${path}${query === '' ? '' : `?${query}`}`);
  const body = options.body ?? '';
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body);

  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join(
    '\n',
  );
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${SECRET_KEY}`, dateStamp), REGION), SERVICE),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return fetch(url, {
    method,
    body: body === '' ? undefined : body,
    headers: {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      authorization: `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
}

/** A closed port is a skip; anything else is a verdict. */
async function reachable() {
  try {
    const response = await fetch(ENDPOINT, { signal: AbortSignal.timeout(3000) });
    return { up: true, status: response.status };
  } catch {
    return { up: false, status: 0 };
  }
}

const probe = await reachable();
if (!probe.up) {
  const message = `s3 target not reachable at ${ENDPOINT}; start it with \`pnpm dev:stack\``;
  if (REQUIRED) {
    console.error(`check:s3 FAILED — ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`check:s3 skipped — ${message}`);
    process.exitCode = 0;
  }
}

async function main() {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(28)} ${detail}`);
  };

  const key = `platform/check-${Date.now()}.txt`;
  const payload = 'platform s3 contract probe';

  // 409 means the bucket already exists and this identity owns it — success for our purpose, and
  // it proves the named volume survived the previous run.
  const create = await signed('PUT', `/${BUCKET}`);
  check('create bucket', create.status === 200 || create.status === 409, `HTTP ${create.status}`);

  const put = await signed('PUT', `/${BUCKET}/${key}`, { body: payload });
  check('put object', put.status === 200, `HTTP ${put.status}`);

  const get = await signed('GET', `/${BUCKET}/${key}`);
  const roundTrip = get.status === 200 ? await get.text() : '';
  check(
    'get object',
    roundTrip === payload,
    `HTTP ${get.status}, body matches ${roundTrip === payload}`,
  );

  const list = await signed('GET', `/${BUCKET}`, {
    query: { 'list-type': '2', prefix: 'platform/' },
  });
  const listing = await list.text();
  check(
    'list objects',
    list.status === 200 && listing.includes(key),
    `HTTP ${list.status}, key listed ${listing.includes(key)}`,
  );

  const remove = await signed('DELETE', `/${BUCKET}/${key}`);
  check('delete object', remove.status === 204 || remove.status === 200, `HTTP ${remove.status}`);

  const anonymous = await fetch(`${ENDPOINT}/${BUCKET}/${key}`);
  check('anonymous refused', anonymous.status === 403, `HTTP ${anonymous.status}`);

  const failed = results.filter((result) => !result.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed against ${ENDPOINT}`,
  );
  if (failed.length > 0) {
    console.error('The backup target does not satisfy the S3 contract the runner depends on.');
    process.exitCode = 1;
  }
}

if (probe.up) await main();
