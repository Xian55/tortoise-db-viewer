// Minimal S3 client for Cloudflare R2 -- just enough to PUT/HEAD an object, signed with
// AWS SigV4 using node:crypto. No SDK and no `aws` CLI dependency: the CLI spawns a
// process per call, which is unusable for a 3.5k-file tile pyramid, and pulling in
// @aws-sdk would add ~15 MB of devDependency for two HTTP verbs.
//
// R2 speaks the S3 API at https://<account>.r2.cloudflarestorage.com/<bucket>/<key>
// with region "auto".

import { createHash, createHmac } from "node:crypto";

const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");
const hmac = (key, str) => createHmac("sha256", key).update(str, "utf8").digest();

/** S3 canonical URI: percent-encode each segment, keep the separators. */
const encodePath = (p) =>
  p.split("/").map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");

/**
 * Build the SigV4 Authorization header value. Exported (rather than living inside the
 * class) so it can be checked against the published AWS test vectors -- getting this
 * subtly wrong shows up only as a 403 from R2, which is a miserable thing to debug.
 */
export function signatureV4({
  method, canonicalPath, headers, payloadHash, amzDate,
  accessKeyId, secretAccessKey, region, service, query = "",
}) {
  const dateStamp = amzDate.slice(0, 8);
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim();
  const names = Object.keys(lower).sort();
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [method, canonicalPath, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  let k = hmac(`AWS4${secretAccessKey}`, dateStamp);
  k = hmac(k, region);
  k = hmac(k, service);
  k = hmac(k, "aws4_request");
  const signature = createHmac("sha256", k).update(stringToSign, "utf8").digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export class R2 {
  /** @param {{accountId:string, accessKeyId:string, secretAccessKey:string, bucket:string}} o */
  constructor({ accountId, accessKeyId, secretAccessKey, bucket }) {
    this.host = `${accountId}.r2.cloudflarestorage.com`;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.bucket = bucket;
    this.region = "auto";
    this.service = "s3";
  }

  #auth(method, canonicalPath, headers, payloadHash, amzDate) {
    return signatureV4({
      method, canonicalPath, headers, payloadHash, amzDate,
      accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey,
      region: this.region, service: this.service,
    });
  }

  #req(method, key, body, extraHeaders = {}) {
    const canonicalPath = `/${encodePath(this.bucket)}/${encodePath(key)}`;
    const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const payloadHash = sha256hex(body ?? Buffer.alloc(0));
    const headers = {
      host: this.host,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      ...extraHeaders,
    };
    if (body) headers["content-length"] = String(body.length);
    headers.Authorization = this.#auth(method, canonicalPath, headers, payloadHash, amzDate);
    return fetch(`https://${this.host}${canonicalPath}`, { method, headers, body });
  }

  /** PUT one object. Throws with the R2 error body on non-2xx. */
  async put(key, body, { contentType, cacheControl } = {}) {
    const extra = {};
    if (contentType) extra["content-type"] = contentType;
    if (cacheControl) extra["cache-control"] = cacheControl;
    const res = await this.#req("PUT", key, body, extra);
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      // A bare "403 AccessDenied" is indistinguishable between four very different
      // causes, and the one that actually bites is a token that has since expired:
      // thousands of uploads succeed, then every PUT fails at once an hour later.
      const hint = res.status !== 403 ? "" : [
        "",
        "  403 from R2 usually means one of:",
        "    * the API token EXPIRED (they can carry a TTL) or was rolled -- by far the",
        "      likeliest when writes worked minutes ago; re-create it, re-export the vars",
        "    * the token is Object READ-only, or scoped to a different bucket",
        "    * the bucket or prefix has a lock/retention rule, which blocks OVERWRITING",
        "      an existing object just as it blocks deleting one",
        "    * the machine clock drifted far enough to invalidate the signature",
        "  Discriminator: PUT a brand-new key. Succeeds while an overwrite fails means",
        "  retention; both failing means the token.",
      ].join("\n");
      throw new Error(`PUT ${key} -> ${res.status} ${res.statusText}: ${detail}${hint}`);
    }
    return true;
  }

  /** HEAD one object -> {status, size} (status 404 when absent). */
  async head(key) {
    const res = await this.#req("HEAD", key, null);
    return { status: res.status, size: Number(res.headers.get("content-length") || 0) };
  }
}

/** Read R2 credentials from the environment, with a clear error listing what's missing. */
export function r2FromEnv(bucket = process.env.R2_BUCKET || "tortoise-db-viewer") {
  const need = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
  const missing = need.filter((n) => !process.env[n]);
  if (missing.length) {
    throw new Error(`missing env: ${missing.join(", ")}\n`
      + `Create an R2 API token (Cloudflare dashboard -> R2 -> Manage API tokens ->\n`
      + `Create token, "Object Read & Write" on the ${bucket} bucket). It gives you an\n`
      + `Access Key ID + Secret Access Key; the Account ID is on the R2 overview page.`);
  }
  return new R2({
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket,
  });
}
