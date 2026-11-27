import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normaliseRegistryEntry } from '@seamnex/domain';

/**
 * NFR-4.16 — the shipped default allow-list.
 *
 * The document is versioned in the repository and loaded once per process; the platform's first
 * audited revision is built from it plus whatever the owner adds. It is deliberately **not** a SQL
 * seed: a literal in a migration and a literal here would drift, and the failure mode of that drift
 * is an allow-list that silently differs between a fresh install and an upgraded one.
 */
export const TRUSTED_REGISTRY_FORMAT = 'trusted-registry/v1';

export const TRUSTED_REGISTRIES_DOCUMENT = join(import.meta.dirname, 'trusted-registries.json');

export type TrustedRegistryDocument = {
  readonly format: string;
  readonly version: number;
  readonly note: string;
  readonly entries: readonly string[];
};

/**
 * Canonical form of a list: normalised, lower-cased, de-duplicated and sorted, so two callers that
 * assembled the same namespaces in a different order produce the same `content_hash`.
 */
export function normaliseTrustedRegistryEntries(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    const normalised = normaliseRegistryEntry(entry);
    if (normalised === null) {
      throw new Error(
        `"${entry}" is not a trusted-registry entry; use a registry or registry/namespace in lower case.`,
      );
    }
    seen.add(normalised);
  }
  return [...seen].sort();
}

/** Content hash of a canonical entry list; the value `trusted_registry_revision.content_hash` holds. */
export function trustedRegistryContentHash(entries: readonly string[]): string {
  return createHash('sha256')
    .update(normaliseTrustedRegistryEntries(entries).join('\n'))
    .digest('hex');
}

export function parseTrustedRegistryDocument(
  text: string,
  source: string,
): TrustedRegistryDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${(error as Error).message}`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${source} must be a JSON object.`);
  }
  const document = parsed as Record<string, unknown>;
  if (document.format !== TRUSTED_REGISTRY_FORMAT) {
    throw new Error(
      `${source} declares format "${String(document.format)}", expected "${TRUSTED_REGISTRY_FORMAT}".`,
    );
  }
  const version = document.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error(`${source} must declare a positive integer version.`);
  }
  if (!Array.isArray(document.entries) || document.entries.length === 0) {
    throw new Error(
      `${source} must declare at least one entry; an empty allow-list refuses everything.`,
    );
  }
  const entries: string[] = [];
  for (const entry of document.entries) {
    if (typeof entry !== 'string') {
      throw new Error(`${source} has a non-string entry (${JSON.stringify(entry)}).`);
    }
    entries.push(entry);
  }
  return {
    format: TRUSTED_REGISTRY_FORMAT,
    version,
    note: typeof document.note === 'string' ? document.note : '',
    entries: normaliseTrustedRegistryEntries(entries),
  };
}

export function loadShippedTrustedRegistries(
  path: string = TRUSTED_REGISTRIES_DOCUMENT,
): TrustedRegistryDocument {
  return parseTrustedRegistryDocument(readFileSync(path, 'utf8'), path);
}
