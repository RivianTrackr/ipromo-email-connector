import { config } from "./config.js";
import type { Attachment } from "./email.js";

export interface ImageRef {
  /** Absolute https URL of the image to fetch. */
  url: string;
  /** Id this image is placed by — [[IMG:contentId]] or <img src="cid:contentId">. */
  contentId: string;
}

const CONTENT_ID_RE = /^[A-Za-z0-9_-]+$/;

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/**
 * Fetch each referenced image URL server-side and return it as an inline
 * attachment (base64), so callers whose HTML pipeline can't attach bytes — but
 * can supply URLs (e.g. S3 assets) — still get inline images. Placement is via
 * `[[IMG:contentId]]` tokens or `<img src="cid:contentId">` (see renderImageTokens).
 *
 * This is an OUTBOUND FETCH surface, so it is deliberately narrow:
 *   - https only; host must be on `config.allowedImageHosts` (the SSRF control)
 *   - redirects are not followed (can't hop off the allowlist)
 *   - Content-Type must be `image/*`; body size is capped; the request times out.
 *
 * Any failure throws with a caller-facing message — the send is not attempted
 * with a half-built body.
 */
export async function fetchInlineImages(images: ImageRef[]): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const img of images) {
    out.push(await fetchOne(img));
  }
  return out;
}

async function fetchOne(img: ImageRef): Promise<Attachment> {
  if (!CONTENT_ID_RE.test(img.contentId)) {
    throw new Error(`Invalid image contentId "${img.contentId}" (allowed: A-Z a-z 0-9 _ -).`);
  }

  let url: URL;
  try {
    url = new URL(img.url);
  } catch {
    throw new Error(`Invalid image url: ${img.url}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Image url must be https: ${img.url}`);
  }

  const host = url.hostname.toLowerCase();
  if (!config.allowedImageHosts.includes(host)) {
    throw new Error(
      `Image host not allowed: ${host}. Add it to ALLOWED_IMAGE_HOSTS to permit fetching.`
    );
  }

  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "error", // a redirect could hop off the allowlisted host
      signal: AbortSignal.timeout(config.imageFetchTimeoutMs),
      headers: { accept: "image/*" },
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : "network error";
    throw new Error(`Failed to fetch image ${img.url}: ${why}`);
  }
  if (!res.ok) {
    throw new Error(`Image fetch returned HTTP ${res.status} for ${img.url}`);
  }

  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!type.startsWith("image/")) {
    throw new Error(
      `Image url did not return an image (Content-Type: ${type || "none"}): ${img.url}`
    );
  }

  const declared = res.headers.get("content-length");
  if (declared && Number(declared) > config.maxImageBytes) {
    throw new Error(
      `Image ${img.url} is ${declared} bytes, over the ${config.maxImageBytes}-byte limit.`
    );
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > config.maxImageBytes) {
    throw new Error(
      `Image ${img.url} is ${buf.length} bytes, over the ${config.maxImageBytes}-byte limit.`
    );
  }

  return {
    content: buf.toString("base64"),
    filename: `${img.contentId}.${EXT_BY_TYPE[type] ?? "img"}`,
    type,
    disposition: "inline",
    contentId: img.contentId,
  };
}
