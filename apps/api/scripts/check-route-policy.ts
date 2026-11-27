/**
 * Deliverable 3.4 / exit criterion 6 — the route-policy gate.
 *
 * ADR-BE-05 requires every route to declare a policy key, and the anonymous set to be an explicit
 * allowlist. `API_OPERATIONS` already throws while it loads when a key is missing, which fails
 * every build; this check additionally proves the *values* are real capabilities and that no
 * obsolete entry lingers in `POLICY_KEYS`.
 *
 * Run with `pnpm check:route-policy`. It exits non-zero with one line per violation, so a reviewer
 * can see what to add rather than a stack trace.
 */
import {
  ANONYMOUS_OPERATIONS,
  API_OPERATIONS,
  CAPABILITIES,
  COLLECTION_PATHS,
  POLICY_KEYS,
  RESERVED_POLICY_KEYS,
  isReservedPolicyKey,
  operationKey,
  scopeRuleFor,
} from '@seamnex/domain';

const violations: string[] = [];
const capabilities = new Set<string>(CAPABILITIES);
const reserved = new Set<string>(RESERVED_POLICY_KEYS);

const declaredKeys = new Set(API_OPERATIONS.map((operation) => operationKey(operation)));

for (const operation of API_OPERATIONS) {
  const key = operationKey(operation);
  const policyKey = operation.policyKey;
  if (policyKey === undefined || policyKey.length === 0) {
    violations.push(`${key}: no policy key`);
    continue;
  }
  if (!isReservedPolicyKey(policyKey) && !capabilities.has(policyKey)) {
    violations.push(`${key}: ${policyKey} is not a declared capability`);
  }
  if (operation.anonymous === true && !ANONYMOUS_OPERATIONS.includes(key)) {
    violations.push(`${key}: declared anonymous but absent from ANONYMOUS_OPERATIONS`);
  }
}

for (const key of ANONYMOUS_OPERATIONS) {
  const operation = API_OPERATIONS.find((candidate) => operationKey(candidate) === key);
  if (operation === undefined)
    violations.push(`${key}: anonymous entry is not a declared operation`);
  else if (operation.anonymous !== true)
    violations.push(`${key}: listed anonymous but not declared so`);
}

for (const [key, policyKey] of Object.entries(POLICY_KEYS)) {
  if (!declaredKeys.has(key))
    violations.push(`${key}: policy entry for an operation that does not exist`);
  if (!isReservedPolicyKey(policyKey) && !capabilities.has(policyKey)) {
    violations.push(`${key}: ${policyKey} is not a declared capability`);
  }
}

/*
 * ADR-BE-44: a collection read is answered from the grant, so the type has to resolve to a scope
 * rule with a narrower form. A path listed as a collection that binds `self`, `request` or a
 * platform fallback would be admitted without a predicate, which is the leak the decision exists
 * to make impossible — so the wiring is checked here instead of being remembered per handler.
 */
for (const path of COLLECTION_PATHS) {
  const key = `GET ${path}`;
  const policyKey = POLICY_KEYS[key];
  if (policyKey === undefined) {
    violations.push(`${key}: collection path is not a declared operation`);
    continue;
  }
  if (isReservedPolicyKey(policyKey)) {
    violations.push(`${key}: collection path binds the reserved key ${policyKey}`);
    continue;
  }
  const rule = scopeRuleFor(policyKey);
  if (rule !== 'instance' && rule !== 'domain') {
    violations.push(`${key}: collection path binds ${policyKey} with scope rule ${rule}`);
  }
}

if (violations.length > 0) {
  console.error(`route-policy check failed (${violations.length}):`);
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exitCode = 1;
} else {
  console.log(
    `route-policy check passed: ${API_OPERATIONS.length} operations, ` +
      `${ANONYMOUS_OPERATIONS.length} anonymous, ${Object.keys(POLICY_KEYS).length} policy keys, ` +
      `${reserved.size} reserved keys.`,
  );
}
