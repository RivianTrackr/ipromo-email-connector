import * as stytch from "stytch";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "./config.js";
import { recordConnection, recordAuthFailure } from "./store.js";

// Stytch is the OAuth authorization server. This connector is only a RESOURCE
// server: it validates the access token Stytch minted and extracts the verified
// identity. No tokens are issued here.
const client = new stytch.Client({
  project_id: config.stytch.projectId,
  secret: config.stytch.secret,
});

// Verify Connected Apps access tokens against the project's own JWKS + issuer.
// We do this directly with jose rather than the SDK's introspectTokenLocal,
// because that helper only accepts issuer `stytch.com/<project>` or the API base
// URL — never the custom project domain (…customers.stytch.dev) that actually
// mints these tokens, so it always fails with "unexpected iss claim value".
const JWKS = createRemoteJWKSet(
  new URL(`${config.stytch.authorizationServer}/.well-known/jwks.json`)
);

export interface AuthedUser {
  email: string; // verified @ipromo.com address — becomes the enforced `from`
  subject: string; // Stytch user id
}

// subject (Stytch user_id) -> email, so we don't hit users.get on every call.
const emailCache = new Map<string, string>();

// The Connected Apps access token carries email only if the project mints it as a
// custom claim; otherwise resolve it from the user record once and cache.
async function resolveEmail(
  subject: string,
  customClaims: Record<string, unknown>
): Promise<string> {
  const fromClaim =
    (customClaims.email as string) ||
    (customClaims["https://stytch.com/email"] as string) ||
    (customClaims.email_address as string) ||
    "";
  if (fromClaim) return fromClaim.toLowerCase();

  const cached = emailCache.get(subject);
  if (cached) return cached;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const user: any = await client.users.get({ user_id: subject });
  // Prefer a real verified email; fall back to the address the login page captured
  // from the Microsoft access token and stashed in untrusted_metadata (Stytch
  // leaves user.emails empty because Microsoft's id_token comes back blank).
  const email = String(
    user?.emails?.[0]?.email ?? user?.untrusted_metadata?.email ?? ""
  ).toLowerCase();
  if (email) emailCache.set(subject, email);
  return email;
}

/**
 * Validate a Bearer access token from Stytch Connected Apps and return the user.
 * Returns null (→ 401) if the token is missing/invalid or the identity is not on
 * an approved domain. The domain check is the tenant lock: the Entra app is
 * multi-tenant (Stytch's Microsoft provider only supports /common), so we reject
 * anyone whose verified email isn't @ipromo.com here.
 *
 * introspectTokenLocal verifies the JWT via Stytch's JWKS (no network call) and
 * returns { subject, scope, custom_claims, ... }.
 */
export async function authenticate(authHeader?: string): Promise<AuthedUser | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  const debug = process.env.DEBUG_AUTH === "1";
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: config.stytch.authorizationServer,
    });
    if (debug) console.log("[auth] payload:", JSON.stringify(payload));
    const subject = String(payload.sub ?? "");
    if (!subject) {
      recordAuthFailure("no_subject");
      return null;
    }
    const email = await resolveEmail(subject, payload as Record<string, unknown>);
    if (debug) console.log("[auth] subject/email:", subject, email);
    if (!email) {
      recordAuthFailure("email_unresolved", subject);
      return null;
    }
    if (!isAllowedSender(email)) {
      recordAuthFailure("domain_not_allowed", email);
      return null;
    }
    recordConnection(subject, email);
    return { email, subject };
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const code = (err as any)?.code ?? String((err as any)?.message ?? "").slice(0, 80);
    recordAuthFailure("jwt_invalid", code);
    if (debug) console.error("[auth] error:", err);
    return null;
  }
}

/** Defense in depth: never send as anything outside the approved domain(s). */
export function isAllowedSender(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  return !!domain && config.allowedSenderDomains.includes(domain);
}

/** RFC 9728 Protected Resource Metadata — tells Claude where to authenticate. */
export function protectedResourceMetadata() {
  return {
    resource: config.baseUrl,
    authorization_servers: [config.stytch.authorizationServer],
    bearer_methods_supported: ["header"],
  };
}

/** The WWW-Authenticate value returned on 401 so Claude can discover the AS. */
export const wwwAuthenticate =
  `Bearer resource_metadata="${config.baseUrl}/.well-known/oauth-protected-resource"`;
