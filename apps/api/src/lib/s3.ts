import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "./env.js";

const isLocalStorage = env.STORAGE_DRIVER === "local";
const localStorageRoot = path.resolve(process.cwd(), env.LOCAL_STORAGE_DIR);

const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY
  }
});

function resolveLocalPath(storageKey: string) {
  const normalized = path.normalize(storageKey).replace(/^(\.\.(\/|\\|$))+/, "");
  return path.join(localStorageRoot, normalized);
}

async function streamToBuffer(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function ensureStorage() {
  if (isLocalStorage) {
    await mkdir(localStorageRoot, { recursive: true });
    return;
  }

  try {
    await s3.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
  } catch {
    await s3.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: ".keep",
        Body: "initialized"
      })
    );
  }
}

export async function putObject(
  storageKey: string,
  body: Buffer,
  contentType: string
) {
  if (isLocalStorage) {
    const filePath = resolveLocalPath(storageKey);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, body);
    return;
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: storageKey,
      Body: body,
      ContentType: contentType
    })
  );
}

export async function getObjectStream(storageKey: string) {
  if (isLocalStorage) {
    return createReadStream(resolveLocalPath(storageKey));
  }

  const object = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: storageKey }));
  return object.Body as Readable;
}

export async function getObjectBuffer(storageKey: string) {
  if (isLocalStorage) {
    return readFile(resolveLocalPath(storageKey));
  }

  const stream = await getObjectStream(storageKey);
  return streamToBuffer(stream);
}
