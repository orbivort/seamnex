import {
  isNonWaivableRule,
  isTrustedImageReference,
  untrustedRegistryMessage,
  type ComposeRule,
} from '@seamnex/domain';
import { isPinnedImage } from './compose-policy';
import type { ComposeViolation, SourcePolicyResult } from './policy-result';

/**
 * NFR-4.15 — the Dockerfile half of the single compose policy.
 *
 * "Ingested Compose files **and Dockerfiles** shall pass a blocking policy check before any container
 * starts." The Dockerfile path used to skip the policy entirely: `resolve()` only evaluated a compose
 * document, so a repository that shipped a Dockerfile reached `build` with no verdict at all.
 *
 * Only one of the five rules is expressible in a Dockerfile. Host networking, privileged mode,
 * host-path bind mounts and external networks are **runtime** constructs: they live in the run
 * definition the platform generates (`render.service.ts`), which never publishes a port, never binds
 * a host path and always attaches the instance's own network — so there is nothing in a Dockerfile to
 * check for them, and pretending otherwise would invent a rule that can never fire. What a Dockerfile
 * does decide is which base image runs, and an unpinned `FROM` is exactly the "a tag that can move
 * under us" the rule exists for.
 *
 * There is no normalisation to record here: a base image reference is either pinned by its author or
 * waived by an approval. `patch` and `publishedPorts` are therefore always empty/zero.
 */
export function evaluateDockerfile(
  content: string,
  waivedRules: ReadonlySet<ComposeRule> = new Set(),
  /** NFR-4.16 allow-list; `null` means the caller holds no list and the rule is not evaluated. */
  trustedRegistries: readonly string[] | null = null,
): SourcePolicyResult {
  const violations: ComposeViolation[] = [];
  const stages: string[] = [];
  /** Stage aliases defined so far, lower-cased: `FROM build` names a stage, not an image. */
  const aliases = new Set<string>();
  let stageIndex = 0;

  for (const instruction of instructions(content)) {
    const [keyword, ...rest] = instruction;
    if (keyword === undefined || keyword.toUpperCase() !== 'FROM') continue;
    stageIndex += 1;
    // `--platform=$BUILDPLATFORM` and friends precede the image; the image is the first bare token.
    const args = rest.filter((token) => !token.startsWith('--'));
    const image = args[0];
    const alias = args[1]?.toUpperCase() === 'AS' ? args[2] : undefined;
    const stage = alias ?? `stage-${stageIndex}`;
    stages.push(stage);

    if (image === undefined) continue;
    /*
     * `FROM build` continues from an earlier stage. It inherits whatever that stage was built from,
     * which was checked when it was declared, so flagging it would block every ordinary multi-stage
     * build — the one thing a policy must not do is refuse the common good case.
     */
    if (aliases.has(image.toLowerCase())) {
      if (alias !== undefined) aliases.add(alias.toLowerCase());
      continue;
    }
    if (alias !== undefined) aliases.add(alias.toLowerCase());
    // `scratch` is the empty root filesystem: nothing can move under it.
    if (image.toLowerCase() === 'scratch') continue;
    if (image.includes('$')) {
      violations.push({
        rule: 'unpinned_image',
        service: stage,
        detail: `stage ${stage} builds from ${image}, whose base image is resolved at build time and cannot be pinned by review.`,
      });
      continue;
    }
    if (!isPinnedImage(image)) {
      violations.push({
        rule: 'unpinned_image',
        service: stage,
        detail: `stage ${stage} builds from ${image}, which is not digest- or version-pinned.`,
      });
    }
    // NFR-4.16: the base image is fetched at build time, so it is one of the two "pull" moments.
    if (trustedRegistries !== null && !isTrustedImageReference(image, trustedRegistries)) {
      violations.push({
        rule: 'untrusted_registry',
        service: stage,
        detail: untrustedRegistryMessage(image),
      });
    }
  }

  const waived = [...new Set(violations.map((item) => item.rule))].filter(
    (rule) => waivedRules.has(rule) && !isNonWaivableRule(rule),
  );
  const blocking = violations.filter(
    (item) => isNonWaivableRule(item.rule) || !waivedRules.has(item.rule),
  );

  return {
    verdict: blocking.length > 0 ? 'blocked' : waived.length > 0 ? 'unsafe_approved' : 'allowed',
    violations,
    waived,
    document: {},
    patch: [],
    publishedPorts: 0,
    services: stages,
  };
}

/**
 * Tokens of each logical instruction.
 *
 * A Dockerfile is line-oriented with three wrinkles that matter here: `#` starts a comment (including
 * parser directives such as `# syntax=`), a trailing `\` continues the instruction, and the keyword is
 * case-insensitive. Reading only the first token of each physical line would miss a `FROM` on a
 * continued line, which is the one instruction this policy cares about.
 */
function instructions(content: string): string[][] {
  const logical: string[] = [];
  let pending = '';

  for (const raw of content.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (pending.length === 0 && (trimmed.length === 0 || trimmed.startsWith('#'))) continue;
    if (trimmed.endsWith('\\')) {
      pending += `${trimmed.slice(0, -1)} `;
      continue;
    }
    logical.push(`${pending}${trimmed}`.trim());
    pending = '';
  }
  if (pending.trim().length > 0) logical.push(pending.trim());

  return logical.map((line) => line.split(/\s+/).filter((token) => token.length > 0));
}
