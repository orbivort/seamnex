import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CatalogEntrySchema,
  EnvSchemaFileSchema,
  isComposedEntryKey,
  type CatalogEntry,
  type EnvSchemaFile,
  type ReloadInvalidArtefact,
} from '@seamnex/domain';
import type { Pool } from 'pg';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { PG_POOL } from '../../database/database.module';
import type { CatalogRepositoryService, CatalogWorkingTree } from './catalog-repo.contract';

/**
 * Reads `catalog/*.json` and `catalog/env/*.json` from `SEAMNEX_CATALOG_REPO_PATH` (ADR-BE-09 D5) and
 * validates each document with the same schema the API serves, so a malformed artefact is reported
 * as `invalid` instead of becoming a 500 at read time — or, worse, reading as a deletion.
 *
 * The revision is the Git head when the path is a repository and a content hash otherwise: the
 * loader must be testable in a temporary directory, and CI validates the same files. The hash covers
 * both artefact kinds, so an environment-only edit still produces a new revision.
 */
@Injectable()
export class WorkingTreeCatalogRepository implements CatalogRepositoryService {
  private readonly logger = new Logger('catalog-repo');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  /**
   * `load` is synchronous work behind an async contract: the working tree is local, read once per
   * reload. It used to be declared `async` with no `await`, which the linter reports as a promise
   * that can never reject for the reason its signature implies.
   */
  load(): Promise<CatalogWorkingTree> {
    return Promise.resolve(this.readWorkingTree());
  }

  async recordCommit(input: {
    readonly sha: string;
    readonly kind: string;
    readonly actor: string;
    readonly message: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO catalog_commit (sha, kind, actor, message) VALUES ($1, $2, $3, $4)
       ON CONFLICT (sha) DO NOTHING`,
      [input.sha, input.kind, input.actor, input.message],
    );
  }

  private readWorkingTree(): CatalogWorkingTree {
    const root = this.config.SEAMNEX_CATALOG_REPO_PATH;
    const catalogDir = join(root, 'catalog');
    if (!existsSync(catalogDir)) {
      this.logger.warn({
        msg: 'catalog working tree is absent; nothing to reconcile',
        path: catalogDir,
      });
      return { revision: 'absent', documents: [], envSchemas: [], invalid: [] };
    }

    const documents: CatalogEntry[] = [];
    const invalid: ReloadInvalidArtefact[] = [];
    const handWritten = readdirSync(catalogDir)
      .filter((name) => name.endsWith('.json'))
      .sort();

    for (const name of handWritten) {
      const relative = `catalog/${name}`;
      const stem = name.slice(0, -'.json'.length);
      try {
        const parsed = CatalogEntrySchema.safeParse(
          JSON.parse(readFileSync(join(catalogDir, name), 'utf8')),
        );
        if (parsed.success) {
          /*
           * ADR-BE-20 phase 1 closes the documented filename/`key` gap for composed keys.
           *
           * The identity is the field, so a half-renamed tree is how this goes wrong: `D1.json` is
           * rewritten to declare `D01-01` while the old file is still present, or the file is renamed
           * before its field is. Either way two documents claim one slot and the loader resolves
           * them last-filename-wins — silently, with the loser invisible. The environment loader
           * already refuses a stem mismatch, so entries agree with it for the grammar that can be
           * renamed. Legacy stems stay convention: the grammar is two or three characters wide and
           * phase 2 is what renames them.
           *
           * The refusal reports the *declared* key rather than the stem, because `invalid[]` is what
           * protects an identity from removal in `removeMissing` — reporting the stem would delete
           * the very row the file was trying to declare.
           */
          if (isComposedEntryKey(parsed.data.key) && stem !== parsed.data.key) {
            invalid.push({
              path: relative,
              scope: 'entry',
              key: parsed.data.key,
              reason: `filename stem must equal the composed key; this file declares ${parsed.data.key}.`,
            });
          } else {
            documents.push(parsed.data);
          }
        } else
          invalid.push({
            path: relative,
            scope: 'entry',
            key: stem,
            reason: issueText(parsed.error.issues),
          });
      } catch (error) {
        invalid.push({ path: relative, scope: 'entry', key: stem, reason: messageOf(error) });
      }
    }

    const envSchemas = this.loadEnvSchemas(catalogDir, invalid);

    return {
      revision: this.revisionOf(root, documents, envSchemas),
      documents,
      envSchemas,
      invalid,
    };
  }

  async recordDrift(
    entryKey: string,
    expectedHash: string | null,
    observedHash: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO drift_record (scope, expected_hash, observed_hash, direction, detail)
       VALUES ('catalog', $1, $2, 'repo_ahead', $3::jsonb)`,
      [expectedHash, observedHash, JSON.stringify({ entryKey, source: 'catalog/reload' })],
    );
  }

  /**
   * `catalog/env/<KEY>.json`, one file per entry.
   *
   * A subdirectory, not a sibling file: the entry loader reads every `*.json` directly under
   * `catalog/`, so `catalog/D1.env.json` would be parsed as a catalog entry, fail, and be reported
   * as an invalid *entry* forever.
   */
  private loadEnvSchemas(catalogDir: string, invalid: ReloadInvalidArtefact[]): EnvSchemaFile[] {
    const envDir = join(catalogDir, 'env');
    if (!existsSync(envDir)) return [];

    const byKey = new Map<string, EnvSchemaFile>();
    for (const name of readdirSync(envDir)
      .filter((entry) => entry.endsWith('.json'))
      .sort()) {
      const relative = `catalog/env/${name}`;
      const stem = name.slice(0, -'.json'.length);
      try {
        const parsed = EnvSchemaFileSchema.safeParse(
          JSON.parse(readFileSync(join(envDir, name), 'utf8')),
        );
        if (!parsed.success) {
          invalid.push({
            path: relative,
            scope: 'environment',
            key: stem,
            reason: issueText(parsed.error.issues),
          });
          continue;
        }
        if (parsed.data.entryKey !== stem) {
          // A copy-pasted file is the common cause; naming both halves is the fix.
          invalid.push({
            path: relative,
            scope: 'environment',
            key: parsed.data.entryKey,
            reason: `entryKey "${parsed.data.entryKey}" does not match the filename "${stem}"`,
          });
          continue;
        }
        // Duplicates resolve to the lexically last file, like entries do. Keep one artefact per key.
        byKey.set(parsed.data.entryKey, parsed.data);
      } catch (error) {
        invalid.push({ path: relative, scope: 'environment', key: stem, reason: messageOf(error) });
      }
    }
    return [...byKey.values()];
  }

  private revisionOf(
    root: string,
    documents: readonly CatalogEntry[],
    envSchemas: readonly EnvSchemaFile[],
  ): string {
    if (existsSync(join(root, '.git'))) {
      try {
        // `execFile` with an argument array: no shell, so a path with a space or a quote cannot
        // become a second command.
        return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      } catch {
        this.logger.warn({ msg: 'git rev-parse failed; falling back to a content hash', root });
      }
    }
    const digest = createHash('sha256');
    for (const document of [...documents].sort((a, b) => a.key.localeCompare(b.key))) {
      digest.update(JSON.stringify(document));
    }
    for (const schema of [...envSchemas].sort((a, b) => a.entryKey.localeCompare(b.entryKey))) {
      digest.update(`env:${JSON.stringify(schema)}`);
    }
    return `content-${digest.digest('hex').slice(0, 16)}`;
  }
}

function issueText(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => `${issue.path.map(String).join('.') || '<root>'} ${issue.message}`)
    .join('; ');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unreadable';
}
