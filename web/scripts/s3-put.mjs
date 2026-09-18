// Uploads one file to an `s3://bucket/key` URL (`docs/13-deployment-fly.md` §6).
//
//   node scripts/s3-put.mjs <file> s3://bucket/prefix/name.tar.gz
//
// The AWS CLI would mean Python in the runtime image; `@aws-sdk/client-s3` is
// already a production dependency of the server, so the archive uploader is
// twenty lines instead of a 60 MB layer. Credentials come from the same
// AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY Litestream uses; AWS_ENDPOINT_URL_S3
// (set by Fly for Tigris) points at an S3-compatible service.

/* Node globals, declared for the flat ESLint config, which scopes its
   environments to the TypeScript packages. */
/* global process, console, URL */

import { createReadStream, statSync } from "node:fs";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const [, , file, target] = process.argv;
if (!file || !target) {
  console.error("usage: node scripts/s3-put.mjs <file> s3://bucket/key");
  process.exit(2);
}

const url = new URL(target);
if (url.protocol !== "s3:") {
  console.error(`expected an s3:// URL, got ${target}`);
  process.exit(2);
}
const bucket = url.hostname;
const key = url.pathname.replace(/^\//, "");
if (bucket === "" || key === "") {
  console.error(`missing bucket or key in ${target}`);
  process.exit(2);
}

const endpoint = process.env["AWS_ENDPOINT_URL_S3"] ?? process.env["AWS_ENDPOINT_URL"] ?? undefined;
const client = new S3Client({
  region: process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"] ?? "auto",
  ...(endpoint === undefined ? {} : { endpoint, forcePathStyle: true }),
});

// `ContentLength` from the stat, so the stream is not buffered to find it.
await client.send(
  new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: createReadStream(file),
    ContentLength: statSync(file).size,
    ContentType: "application/gzip",
  }),
);

console.log(`s3-put: ${file} -> ${target}`);
