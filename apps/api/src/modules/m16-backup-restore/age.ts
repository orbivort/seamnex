import { existsSync, readFileSync } from 'node:fs';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { requireAdapters } from '../../common/adapters';
import { runOrThrow } from '../../common/exec/exec';
import { AppError } from '../../common/problem/app-error';

/**
 * 4C.1 — backup encryption with `age`.
 *
 * A CLI rather than a library: the binary is audited, streams without buffering the archive in the
 * API process, and is the same tool an operator uses for a manual restore. The cost is one process
 * per artefact, which is irrelevant next to a database dump.
 *
 * The recipient is a public key, so the API can encrypt but cannot decrypt a backup it wrote. The
 * identity lives escrowed (design §11.4); a host without it can still take backups, and a restore
 * says so instead of failing halfway through a download.
 */
@Injectable()
export class AgeEncryptor {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Encrypts in place: `<path>` → `<path>.age`, and the plaintext is removed by the caller. */
  async encrypt(path: string): Promise<{ path: string; recipient: string }> {
    requireAdapters(this.config, 'age');
    const target = `${path}.age`;
    await runOrThrow(
      this.config.SEAMNEX_AGE_BINARY,
      ['--encrypt', '--recipient', this.config.SEAMNEX_AGE_RECIPIENT, '--output', target, path],
      { timeoutMs: 600_000 },
    );
    return { path: target, recipient: this.config.SEAMNEX_AGE_RECIPIENT };
  }

  /** Decrypts `<path>.age` next to the encrypted file; refuses when the identity is absent. */
  async decrypt(path: string): Promise<string> {
    requireAdapters(this.config, 'age');
    if (!existsSync(this.config.SEAMNEX_AGE_IDENTITY_FILE)) {
      throw new AppError({
        code: 'ADAPTER_UNAVAILABLE',
        detail: `The age identity ${this.config.SEAMNEX_AGE_IDENTITY_FILE} is not present on this host.`,
        remediation:
          'Restore the escrowed identity before restoring a backup. The platform can encrypt without it and cannot decrypt without it.',
      });
    }
    const target = path.replace(/\.age$/, '');
    await runOrThrow(
      this.config.SEAMNEX_AGE_BINARY,
      ['--decrypt', '--identity', this.config.SEAMNEX_AGE_IDENTITY_FILE, '--output', target, path],
      { timeoutMs: 600_000 },
    );
    return target;
  }

  /** The recipient id recorded in every manifest, so a backup names the key that can open it. */
  recipientId(): string {
    return this.config.SEAMNEX_AGE_RECIPIENT.trim().length === 0
      ? 'unconfigured'
      : this.config.SEAMNEX_AGE_RECIPIENT;
  }

  /** The escrowed identity id, read from the file when present (never its secret material). */
  identityId(): string {
    try {
      const lines = readFileSync(this.config.SEAMNEX_AGE_IDENTITY_FILE, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.startsWith('#'));
      return lines.find((line) => line.includes('public key'))?.replace(/^#\s*/, '') ?? 'escrowed';
    } catch {
      return 'escrowed';
    }
  }
}
