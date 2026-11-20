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

  // SendGrid open + click tracking. OFF by default: the tracking pixel and
  // redirect-wrapped links are classic bulk-mail traits that push mail into
  // Gmail's Promotions tab. Set EMAIL_TRACKING=on only if you need the stats.
  emailTracking: /^(on|true|1|yes)$/i.test(process.env.EMAIL_TRACKING ?? ""),

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
    "merchai-onboarding.s3.us-east-2.amazonaws.com,media.asicentral.com,51122294.fs1.hubspotusercontent-na1.net,showcase.ipromo.com"
  )
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
  maxImageBytes: Number(process.env.MAX_IMAGE_BYTES ?? 10 * 1024 * 1024),
  imageFetchTimeoutMs: Number(process.env.IMAGE_FETCH_TIMEOUT_MS ?? 10_000),

  // ── Send as a rep (Microsoft Graph) ─────────────────────────────────────
  // App-only credentials for the separate "iPromo Email Connector Mailer" app
  // registration (NOT the Stytch sign-in app, NOT "iPromo Portal SSO"). Needs
  // Application permissions Mail.Send, User.Read.All, GroupMember.Read.All, with
  // Mail.Send limited to the reps group by an Exchange application access policy.
  // Any of these unset = rep sending is off.
  graph: {
    tenantId: process.env.GRAPH_TENANT_ID ?? "",
    clientId: process.env.GRAPH_CLIENT_ID ?? "",
    clientSecret: process.env.GRAPH_CLIENT_SECRET ?? "",
  },
  reps: {
    // Object id of the M365 security group "Email connector reps". Only enabled
    // members can be sent as; leavers drop out when disabled/removed.
    groupId: process.env.REPS_GROUP_ID ?? "",
    // Signed-in users who may send as reps (comma-separated). Leo only.
    sendAsUsers: (process.env.REP_SEND_AS_USERS ?? "")
      .split(",")
      .map((u) => u.trim().toLowerCase())
      .filter(Boolean),
    // Hours between full syncs of the reps list (each send also re-checks live).
    syncHours: Number(process.env.REPS_SYNC_HOURS ?? 24),
  },

  // HubSpot private app token (scopes: crm.objects.contacts.read,
  // crm.objects.contacts.write, crm.objects.owners.read, sales-email-read).
  // Unset = rep sends are not logged to HubSpot.
  hubspotToken: process.env.HUBSPOT_TOKEN ?? "",

  // Sites on Cloudflare/Higgsfield (no fixed egress IP) send through us instead
  // of calling SendGrid directly, each with its own Bearer token and sender
  // list. "showcase" comes from SHOWCASE_API_TOKEN / SHOWCASE_SENDERS. More
  // sites: list names in EXTRA_SITES (e.g. "cyberweek") and set
  // <NAME>_API_TOKEN / <NAME>_SENDERS for each. A site with no token is off.
  sites: loadSites(),
};

export interface SiteConfig {
  name: string;
  apiToken: string;
  // Addresses the site may send as; the first exact entry is the default `from`.
  // "*@ipromo.com" lets it send as any address on that domain.
  senders: string[];
}

function parseList(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function loadSites(): SiteConfig[] {
  const names = ["showcase", ...parseList(process.env.EXTRA_SITES)];
  const seen = new Set<string>();
  const sites: SiteConfig[] = [];
  for (const name of names) {
    if (!/^[a-z][a-z0-9_]*$/.test(name) || seen.has(name)) continue;
    seen.add(name);
    const key = name.toUpperCase();
    const apiToken = (process.env[`${key}_API_TOKEN`] ?? "").trim();
    if (!apiToken) continue;
    sites.push({ name, apiToken, senders: parseList(process.env[`${key}_SENDERS`]) });
  }
  return sites;
}
