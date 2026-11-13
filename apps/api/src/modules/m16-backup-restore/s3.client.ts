import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { requireAdapters } from '../../common/adapters';

/**
 * ADR-BE-11 / 4C.1 — the backup target.
 *
 * Path-style addressing is forced: VersityGW (the development target) does not answer virtual-host
 * URLs, and a real S3 endpoint accepts both. Signature v4 is the SDK's job — the hand-rolled probe
 * in `scripts/check-s3.mjs` proved the endpoint, not a client worth maintaining.
 */
@Injectable()
export class BackupObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private bucketChecked = false;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.bucket = config.S3_BUCKET;
    this.client = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY,
        secretAccessKey: config.S3_SECRET_KEY,
      },
    });
  }

  async putFile(
    key: string,
    path: string,
    contentType = 'application/octet-stream',
  ): Promise<{ key: string; bytes: number }> {
    this.guard();
    await this.ensureBucket();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(path),
        ContentType: contentType,
      }),
    );
    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    return { key, bytes: head.ContentLength ?? 0 };
  }

  async putText(key: string, body: string, contentType = 'application/json'): Promise<void> {
    this.guard();
    await this.ensureBucket();
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async getText(key: string): Promise<string> {
    this.guard();
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const stream = result.Body;
    if (stream === undefined) throw new Error(`object ${key} has no body`);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  }

  async download(key: string, path: string): Promise<void> {
    this.guard();
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const stream = result.Body;
    if (stream === undefined) throw new Error(`object ${key} has no body`);
    await pipeline(stream as AsyncIterable<Uint8Array>, createWriteStream(path));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix: string): Promise<{ key: string; bytes: number; lastModified: Date | null }[]> {
    this.guard();
    const result = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: 1_000 }),
    );
    return (result.Contents ?? []).map((entry) => ({
      key: entry.Key ?? '',
      bytes: entry.Size ?? 0,
      lastModified: entry.LastModified ?? null,
    }));
  }

  async remove(key: string): Promise<void> {
    this.guard();
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** The runner creates the bucket, not the stack: nothing depends on it existing at boot. */
  async ensureBucket(): Promise<void> {
    if (this.bucketChecked) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
    this.bucketChecked = true;
  }

  private guard(): void {
    requireAdapters(this.config, 's3');
  }
}
