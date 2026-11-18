import { config } from "./config.js";
import type { Attachment } from "./email.js";

// Microsoft Graph, app-only (client credentials). Used only for rep sending:
// look up reps, check group membership, and send from the rep's own mailbox.

const GRAPH = "https://graph.microsoft.com/v1.0";

export function graphConfigured(): boolean {
  const g = config.graph;
  return !!(g.tenantId && g.clientId && g.clientSecret && config.reps.groupId);
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function token(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const { tenantId, clientId, clientSecret } = config.graph;
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  const body = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    // error_description never contains the secret.
    throw new Error(`Microsoft sign-in for the mailer app failed: ${body.error_description ?? res.status}`);
  }
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

async function graph<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path.startsWith("http") ? path : `${GRAPH}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${await token()}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const b = (await res.json()) as { error?: { code?: string; message?: string } };
      if (b.error) detail = `${b.error.code}: ${b.error.message}`;
    } catch {
      /* no body */
    }
    const err = new Error(`Microsoft Graph ${detail}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (res.status === 202 || res.status === 204 ? undefined : await res.json()) as T;
}

export interface RepProfile {
  id: string;
  email: string;
  name: string;
  title?: string;
  phone?: string;
  enabled: boolean;
}

interface GraphUser {
  id: string;
  displayName?: string;
  jobTitle?: string | null;
  mail?: string | null;
  userPrincipalName?: string;
  accountEnabled?: boolean;
  mobilePhone?: string | null;
  businessPhones?: string[];
}

const USER_FIELDS =
  "id,displayName,jobTitle,mail,userPrincipalName,accountEnabled,mobilePhone,businessPhones";

function toProfile(u: GraphUser): RepProfile {
  return {
    id: u.id,
    email: (u.mail || u.userPrincipalName || "").toLowerCase(),
    name: u.displayName ?? "",
    title: u.jobTitle ?? undefined,
    phone: u.mobilePhone || u.businessPhones?.[0] || undefined,
    enabled: u.accountEnabled !== false,
  };
}

/** All users in the reps group (nested groups included). */
export async function listRepGroupMembers(): Promise<RepProfile[]> {
  const out: RepProfile[] = [];
  let next: string | undefined =
    `/groups/${encodeURIComponent(config.reps.groupId)}/transitiveMembers/microsoft.graph.user` +
    `?$select=${USER_FIELDS}&$top=999`;
  while (next) {
    const page: { value: GraphUser[]; "@odata.nextLink"?: string } = await graph(next);
    out.push(...page.value.map(toProfile));
    next = page["@odata.nextLink"];
  }
  return out;
}

/**
 * Live check right before a send: the account exists, is enabled, and is still
 * in the reps group. Returns null when any of those fail.
 */
export async function getActiveRep(email: string): Promise<RepProfile | null> {
  let u: GraphUser;
  try {
    u = await graph<GraphUser>(`/users/${encodeURIComponent(email)}?$select=${USER_FIELDS}`);
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
  const p = toProfile(u);
  if (!p.enabled) return null;
  const r = await graph<{ value: string[] }>(`/users/${encodeURIComponent(u.id)}/checkMemberGroups`, {
    method: "POST",
    body: JSON.stringify({ groupIds: [config.reps.groupId] }),
  });
  return r.value.includes(config.reps.groupId) ? p : null;
}

export interface GraphMessage {
  to: { email: string; name?: string }[];
  cc?: { email: string; name?: string }[];
  bcc?: { email: string; name?: string }[];
  replyTo?: { email: string; name?: string };
  subject: string;
  html: string;
  attachments?: Attachment[];
}

// Graph's sendMail takes the whole message as one JSON request, capped at 4 MB.
// Leave headroom for the JSON envelope.
export const GRAPH_MAX_REQUEST_BYTES = 3_900_000;

const recip = (r: { email: string; name?: string }) => ({
  emailAddress: { address: r.email, ...(r.name ? { name: r.name } : {}) },
});

export function buildSendMailBody(msg: GraphMessage) {
  return {
    message: {
      subject: msg.subject,
      body: { contentType: "HTML", content: msg.html },
      toRecipients: msg.to.map(recip),
      ...(msg.cc?.length ? { ccRecipients: msg.cc.map(recip) } : {}),
      ...(msg.bcc?.length ? { bccRecipients: msg.bcc.map(recip) } : {}),
      ...(msg.replyTo ? { replyTo: [recip(msg.replyTo)] } : {}),
      ...(msg.attachments?.length
        ? {
            attachments: msg.attachments.map((a) => ({
              "@odata.type": "#microsoft.graph.fileAttachment",
              name: a.filename,
              contentType: a.type ?? "application/octet-stream",
              contentBytes: a.content,
              isInline: a.disposition === "inline",
              ...(a.contentId ? { contentId: a.contentId } : {}),
            })),
          }
        : {}),
    },
    // This is what puts the copy in the rep's Sent Items.
    saveToSentItems: true,
  };
}

/** Send from the rep's own mailbox. From = the rep; nothing says "on behalf of". */
export async function sendMailAs(repEmail: string, msg: GraphMessage): Promise<void> {
  const body = JSON.stringify(buildSendMailBody(msg));
  if (Buffer.byteLength(body) > GRAPH_MAX_REQUEST_BYTES) {
    throw new Error(
      "This message is over Microsoft's ~4 MB limit for sending as a rep (attachments and images count). " +
        "Shrink or drop attachments, or link to the file instead."
    );
  }
  await graph<void>(`/users/${encodeURIComponent(repEmail)}/sendMail`, { method: "POST", body });
}
