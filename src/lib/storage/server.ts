// ============================================================
// Server-side storage — MinIO (S3-compatible) on the VPS.
// ============================================================
// Replaces Supabase Storage with the same `.from(bucket).upload/getPublicUrl/
// remove` shape the code already uses, so call sites don't change. Only the
// server holds MinIO credentials; the browser uploads through /api/storage
// (see the browser shim), never directly.
//
// Env (see .env.local.example):
//   MINIO_ENDPOINT / MINIO_REGION / MINIO_ACCESS_KEY / MINIO_SECRET_KEY
//   MINIO_BUCKET_AVATARS / MINIO_BUCKET_CHAT_MEDIA / MINIO_BUCKET_FLOW_MEDIA
//
// Bucket-name mapping: Supabase bucket ids ("avatars", "chat-media",
// "flow-media") map to the configured MinIO bucket names so existing string
// literals keep working.

import {
  DeleteObjectsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

const BUCKET_ENV: Record<string, string | undefined> = {
  avatars: process.env.MINIO_BUCKET_AVATARS ?? 'avatars',
  'chat-media': process.env.MINIO_BUCKET_CHAT_MEDIA ?? 'chat-media',
  'flow-media': process.env.MINIO_BUCKET_FLOW_MEDIA ?? 'flow-media',
}

function resolveBucket(bucket: string): string {
  return BUCKET_ENV[bucket] ?? bucket
}

let client: S3Client | undefined
function s3(): S3Client {
  if (client) return client
  const endpoint = process.env.MINIO_ENDPOINT
  if (!endpoint) {
    throw new Error('MINIO_ENDPOINT is not set — storage is unavailable.')
  }
  client = new S3Client({
    endpoint,
    region: process.env.MINIO_REGION ?? 'us-east-1',
    // Path-style is required for MinIO (no virtual-host buckets).
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.MINIO_ACCESS_KEY ?? '',
      secretAccessKey: process.env.MINIO_SECRET_KEY ?? '',
    },
  })
  return client
}

/** Public URL for an object, mirroring Supabase's `/object/public/...` shape. */
function publicUrlFor(bucket: string, path: string): string {
  const endpoint = (process.env.MINIO_ENDPOINT ?? '').replace(/\/$/, '')
  return `${endpoint}/${resolveBucket(bucket)}/${path}`
}

interface UploadOptions {
  cacheControl?: string
  upsert?: boolean
  contentType?: string
}

export interface BucketApi {
  upload(
    path: string,
    file: Buffer | Uint8Array | Blob | ArrayBuffer,
    opts?: UploadOptions,
  ): Promise<{ data: { path: string } | null; error: { message: string } | null }>
  getPublicUrl(path: string): { data: { publicUrl: string } }
  remove(paths: string[]): Promise<{ error: { message: string } | null }>
}

export interface StorageClient {
  from(bucket: string): BucketApi
}

async function toBytes(
  file: Buffer | Uint8Array | Blob | ArrayBuffer,
): Promise<Uint8Array> {
  if (file instanceof Uint8Array) return file
  if (file instanceof ArrayBuffer) return new Uint8Array(file)
  // Blob / File
  const arrayBuf = await (file as Blob).arrayBuffer()
  return new Uint8Array(arrayBuf)
}

export function createServerStorage(): StorageClient {
  return {
    from(bucket: string): BucketApi {
      const realBucket = resolveBucket(bucket)
      return {
        async upload(path, file, opts) {
          try {
            const Body = await toBytes(file)
            await s3().send(
              new PutObjectCommand({
                Bucket: realBucket,
                Key: path,
                Body,
                ContentType: opts?.contentType,
                CacheControl: opts?.cacheControl,
              }),
            )
            return { data: { path }, error: null }
          } catch (err) {
            return { data: null, error: { message: (err as Error).message } }
          }
        },
        getPublicUrl(path) {
          return { data: { publicUrl: publicUrlFor(bucket, path) } }
        },
        async remove(paths) {
          try {
            await s3().send(
              new DeleteObjectsCommand({
                Bucket: realBucket,
                Delete: { Objects: paths.map((Key) => ({ Key })) },
              }),
            )
            return { error: null }
          } catch (err) {
            return { error: { message: (err as Error).message } }
          }
        },
      }
    },
  }
}
