import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function parseSharedSenders(raw: string): Map<string, string[] | "*"> {
  const map = new Map<string, string[] | "*">();
  for (const entry of raw.split(",")) {
    const [address, users] = entry.split("=").map((p) => p.trim().toLowerCase());
    if (!address) continue;
    map.set(
      address,
      users ? users.split("|").map((u) => u.trim()).filter(Boolean) : "*"
    );
  }
  return map;
}

export const config = {
  baseUrl: required("CONNECTOR_BASE_URL").replace(/\/$/, ""),
  port: Number(process.env.PORT ?? 8080),

  stytch: {
    projectId: required("STYTCH_PROJECT_ID"),
    secret: required("STYTCH_SECRET"),
    authorizationServer: required("STYTCH_AUTHORIZATION_SERVER").replace(/\/$/, ""),
  },

  sendgridApiKey: required("SENDGRID_API_KEY"),

  perUserDailyCap: Number(process.env.PER_USER_DAILY_CAP ?? 10000),
  globalDailyCap: Number(process.env.GLOBAL_DAILY_CAP ?? 50000),
  allowedSenderDomains: (process.env.ALLOWED_SENDER_DOMAINS ?? "ipromo.com")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),

  // Shared addresses a signed-in user may pick as `from` in send_email, mapped to
  // who may use them ("*" = any signed-in user). Format:
  //   shared@ipromo.com              → any signed-in user
  //   shared@ipromo.com=a@ipromo.com|b@ipromo.com → only those users
  // Entries are comma-separated. The default ships via git; set SHARED_SENDERS
  // only to diverge from it (set it empty to turn shared senders off).
  sharedSenders: parseSharedSenders(process.env.SHARED_SENDERS ?? "showcase@ipromo.com"),

  // Server-side image fetch (the `images` param): hosts we'll pull image URLs
  // from. This allowlist is the SSRF control — keep it tight.
  allowedImageHosts: (
    process.env.ALLOWED_IMAGE_HOSTS ??
    "merchai-onboarding.s3.us-east-2.amazonaws.com,media.asicentral.com"
  )
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
  maxImageBytes: Number(process.env.MAX_IMAGE_BYTES ?? 10 * 1024 * 1024),
  imageFetchTimeoutMs: Number(process.env.IMAGE_FETCH_TIMEOUT_MS ?? 10_000),

  // Showcase site (Cloudflare, no fixed egress IP) sends through us instead of
  // calling SendGrid directly. Unset token = endpoint disabled.
  showcase: {
    apiToken: process.env.SHOWCASE_API_TOKEN ?? "",
    // Addresses the showcase may send as; the first is the default `from`.
    senders: (process.env.SHOWCASE_SENDERS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  },
};
