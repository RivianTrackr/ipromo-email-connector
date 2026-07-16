import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
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
};
