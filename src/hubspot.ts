import { config } from "./config.js";

// Log a rep send as an Email activity on each matching HubSpot contact, owned by
// the rep. Contacts are never created here: no contact = nothing logged.

const API = "https://api.hubapi.com";
// HubSpot-defined association type: email → contact.
const EMAIL_TO_CONTACT = 198;

export function hubspotConfigured(): boolean {
  return !!config.hubspotToken;
}

async function hs<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.hubspotToken}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const b = (await res.json()) as { message?: string };
      if (b.message) detail += `: ${b.message}`;
    } catch {
      /* no body */
    }
    throw new Error(`HubSpot ${detail}`);
  }
  return (await res.json()) as T;
}

async function contactIdsFor(emails: string[]): Promise<string[]> {
  if (!emails.length) return [];
  const r = await hs<{ results: { id: string }[] }>("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "email", operator: "IN", values: emails }] }],
      properties: ["email"],
      limit: 100,
    }),
  });
  return r.results.map((c) => c.id);
}

const ownerCache = new Map<string, string | null>();
async function ownerIdFor(email: string): Promise<string | null> {
  if (ownerCache.has(email)) return ownerCache.get(email)!;
  const r = await hs<{ results: { id: string }[] }>(
    `/crm/v3/owners/?email=${encodeURIComponent(email)}&limit=1`
  );
  const id = r.results[0]?.id ?? null;
  ownerCache.set(email, id);
  return id;
}

export interface HubspotLogInput {
  rep: { email: string; name: string };
  to: { email: string; name?: string }[];
  cc?: { email: string; name?: string }[];
  subject: string;
  html: string;
  sentAt: string;
}

export type HubspotLogResult =
  | { status: "logged"; emailId: string; contacts: number }
  | { status: "no_contact" }
  | { status: "error"; error: string };

export async function logToHubspot(m: HubspotLogInput): Promise<HubspotLogResult> {
  try {
    const recipients = [...m.to, ...(m.cc ?? [])].map((r) => r.email.toLowerCase());
    const contactIds = await contactIdsFor(recipients);
    if (!contactIds.length) return { status: "no_contact" };
    const ownerId = await ownerIdFor(m.rep.email);
    const [firstName, ...rest] = m.rep.name.split(" ");
    const created = await hs<{ id: string }>("/crm/v3/objects/emails", {
      method: "POST",
      body: JSON.stringify({
        properties: {
          hs_timestamp: m.sentAt,
          hs_email_direction: "EMAIL",
          hs_email_status: "SENT",
          hs_email_subject: m.subject,
          hs_email_html: m.html,
          hs_email_headers: JSON.stringify({
            from: { email: m.rep.email, firstName, lastName: rest.join(" ") },
            to: m.to.map((r) => ({ email: r.email })),
            cc: (m.cc ?? []).map((r) => ({ email: r.email })),
            bcc: [],
          }),
          ...(ownerId ? { hubspot_owner_id: ownerId } : {}),
        },
        associations: contactIds.map((id) => ({
          to: { id },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: EMAIL_TO_CONTACT }],
        })),
      }),
    });
    return { status: "logged", emailId: created.id, contacts: contactIds.length };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : "HubSpot logging failed" };
  }
}
