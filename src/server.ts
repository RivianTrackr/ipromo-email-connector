import express from "express";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import {
  authenticate,
  canSendAs,
  isAllowedSender,
  protectedResourceMetadata,
  siteForToken,
  siteMaySendAs,
  wwwAuthenticate,
  type AuthedUser,
} from "./auth.js";
import { renderImageTokens, sendOne, type OutgoingMessage, type SendResult } from "./email.js";
import { fetchInlineImages } from "./images.js";
import { sendMailAs } from "./graph.js";
import { hubspotConfigured, logToHubspot } from "./hubspot.js";
import { maySendAsReps, repList, resolveRep, startRepSync } from "./reps.js";
import { appendSignature, signatureHtml } from "./signature.js";
import {
  assertUnderCaps,
  listRepSends,
  recordAuthFailure,
  recordSend,
} from "./store.js";

const app = express();
// 30mb accommodates base64-encoded attachments; SendGrid caps total message size ~30MB.
app.use(express.json({ limit: "30mb" }));

// ── Discovery: where Claude should authenticate ────────────────────────────
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json(protectedResourceMetadata());
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ── Tool schema (the "dumb" send surface; `from` only from an allowlist) ───
const contact = z.object({ email: z.string().email(), name: z.string().optional() });
const attachment = z.object({
  content: z.string().min(1).describe("Base64-encoded file contents."),
  filename: z.string().min(1),
  type: z.string().optional().describe('MIME type, e.g. "application/pdf" or "image/png".'),
  disposition: z.enum(["attachment", "inline"]).optional(),
  contentId: z
    .string()
    .optional()
    .describe('For inline images: the id referenced as <img src="cid:THIS_ID"> in the HTML.'),
});
const imageRef = z.object({
  url: z.string().url().describe("Absolute https URL of the image (must be on an allowed host)."),
  contentId: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, "contentId: letters, numbers, _ or - only")
    .describe('Placed via [[IMG:contentId]] or <img src="cid:contentId"> in the HTML.'),
  alt: z.string().optional().describe("Alt text for the placed image."),
  width: z.number().int().positive().optional().describe("Rendered width in px."),
});
const message = z.object({
  to: z.array(contact).min(1),
  subject: z.string().min(1),
  html: z.string().min(1),
  text: z.string().optional(),
  cc: z.array(contact).optional(),
  bcc: z.array(contact).optional(),
  replyTo: contact.optional(),
  attachments: z.array(attachment).optional(),
  images: z.array(imageRef).optional(),
});
const messages = z.array(message).min(1).max(200);
const sendEmailInput = {
  from: contact
    .optional()
    .describe(
      "Optional. Omit to send as yourself. Set only to send as an approved shared " +
        "address (e.g. showcase@ipromo.com); anything else is refused."
    ),
  messages,
};

type MessageInput = z.infer<typeof message>;
type BatchResult = { to: string[]; subject: string } & SendResult;

/**
 * Send a batch as `fromEmail`: caps, server-side image inlining, SendGrid, and
 * the audit log. Shared by the MCP tool and the showcase endpoint. Throws if the
 * batch would exceed a cap (nothing is sent).
 */
async function sendBatch(
  fromEmail: string,
  fromName: string | undefined,
  batch: MessageInput[],
  sentBy?: string
): Promise<BatchResult[]> {
  assertUnderCaps(fromEmail, batch.length);

  const results: BatchResult[] = [];
  for (const m of batch) {
    const { images, ...msg } = m;

    // Fetch any URL-referenced images server-side and inline them. A fetch
    // failure fails just this message — we don't send a half-built body.
    let r: SendResult | undefined;
    if (images?.length) {
      try {
        const fetched = await fetchInlineImages(images);
        (msg as OutgoingMessage).attachments = [
          ...((msg as OutgoingMessage).attachments ?? []),
          ...fetched,
        ];
        (msg as OutgoingMessage).inlineImageMeta = images.map((i) => ({
          contentId: i.contentId,
          alt: i.alt,
          width: i.width,
        }));
      } catch (err) {
        r = { status: "error", error: err instanceof Error ? err.message : "image fetch failed" };
      }
    }
    r ??= await sendOne(fromEmail, fromName, msg as OutgoingMessage);
    recordSend({
      ts: new Date().toISOString(),
      senderEmail: fromEmail,
      sentBy,
      toEmails: m.to.map((t) => t.email),
      subject: m.subject,
      status: r.status,
      sendgridId: r.sendgridId,
      error: r.error,
    });
    results.push({
      to: m.to.map((t) => t.email),
      subject: m.subject,
      status: r.status,
      sendgridId: r.sendgridId,
      error: r.error,
    });
  }
  return results;
}

// Build a per-request MCP server bound to the authenticated user so the tool
// handler can enforce `from` = the verified identity (or a shared address
// SHARED_SENDERS lets them use).

// ── Send as a rep (Microsoft Graph) ────────────────────────────────────────
// Only for users on REP_SEND_AS_USERS. Mail goes out from the rep's own mailbox
// (From = the rep, no "on behalf of"), a copy is saved to their Sent Items,
// replies go to the rep, the rep's signature is appended, and each send is
// logged on the matching HubSpot contact with the rep as owner.

// Exchange allows ~30 messages a minute per mailbox; keep one call under that.
const REP_BATCH_MAX = 30;
const repMessage = message.extend({
  signature: z
    .boolean()
    .optional()
    .describe("Append the rep's signature (default true). Set false if the HTML already has one."),
});
const sendAsRepInput = {
  rep: z.string().email().describe("The rep's @ipromo.com address. See list_reps."),
  messages: z.array(repMessage).min(1).max(REP_BATCH_MAX),
};

type RepBatchResult = BatchResult & { hubspot?: string };

async function sendAsRepBatch(
  repEmail: string,
  batch: z.infer<typeof repMessage>[],
  sentBy: string
): Promise<{ rep: string; results: RepBatchResult[] }> {
  const rep = await resolveRep(repEmail);
  if (!isAllowedSender(rep.email)) throw new Error(`${rep.email} is not on an approved domain.`);
  assertUnderCaps(rep.email, batch.length);
  const sig = signatureHtml(rep);

  const results: RepBatchResult[] = [];
  for (const m of batch) {
    const { images, signature, ...rest } = m;
    const msg = rest as OutgoingMessage;
    let r: SendResult;
    let html = msg.html;
    let hubspot: { status: string; id?: string } | undefined;
    try {
      if (images?.length) {
        msg.attachments = [...(msg.attachments ?? []), ...(await fetchInlineImages(images))];
        msg.inlineImageMeta = images.map((i) => ({ contentId: i.contentId, alt: i.alt, width: i.width }));
      }
      html = renderImageTokens(msg.html, msg.attachments, msg.inlineImageMeta);
      if (signature !== false) html = appendSignature(html, sig);
      await sendMailAs(rep.email, {
        to: msg.to,
        cc: msg.cc,
        bcc: msg.bcc,
        replyTo: msg.replyTo ?? { email: rep.email, name: rep.name },
        subject: msg.subject,
        html,
        attachments: msg.attachments,
      });
      r = { status: "sent" };
    } catch (err) {
      r = { status: "error", error: err instanceof Error ? err.message : "send failed" };
    }

    const ts = new Date().toISOString();
    if (r.status === "sent" && hubspotConfigured()) {
      const h = await logToHubspot({
        rep: { email: rep.email, name: rep.name },
        to: msg.to,
        cc: msg.cc,
        subject: msg.subject,
        html,
        sentAt: ts,
      });
      hubspot =
        h.status === "logged"
          ? { status: "logged", id: h.emailId }
          : h.status === "error"
            ? { status: `error: ${h.error}` }
            : { status: "no_contact" };
    }
    recordSend({
      ts,
      senderEmail: rep.email,
      sentBy,
      toEmails: m.to.map((t) => t.email),
      subject: m.subject,
      status: r.status,
      error: r.error,
      via: "graph",
      hubspotStatus: hubspot?.status.startsWith("error") ? "error" : hubspot?.status,
      hubspotId: hubspot?.id,
    });
    results.push({
      to: m.to.map((t) => t.email),
      subject: m.subject,
      status: r.status,
      error: r.error,
      ...(hubspot ? { hubspot: hubspot.status } : {}),
    });
  }
  return { rep: rep.email, results };
}

function registerRepTools(server: McpServer, user: AuthedUser): void {
  server.tool(
    "list_reps",
    "List the active sales reps you can send as with send_as_rep (name, title, email). " +
      "The list comes from the Microsoft 365 reps group; people who leave drop off automatically.",
    {},
    async () => {
      const { reps, lastSync, lastError } = repList();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                reps: reps.map((r) => ({ name: r.name, title: r.title ?? null, email: r.email })),
                lastSync,
                ...(lastError ? { lastError } : {}),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "send_as_rep",
    "Send one or more fully-rendered emails AS a sales rep, from the rep's own Microsoft 365 " +
      "mailbox. Recipients see only the rep (no 'on behalf of'); a copy lands in the rep's Sent " +
      "Items, replies go to the rep, the rep's signature is added at the end (set signature:false " +
      "to skip), and each send is logged on the matching HubSpot contact. Always show the user the " +
      "exact rep, recipients, subject and body and get their OK before calling this. Up to " +
      `${REP_BATCH_MAX} messages per call; each message (with attachments and images) must stay ` +
      "under about 3.5 MB. Images, attachments and [[IMG:id]] tokens work as in send_email.",
    sendAsRepInput,
    async ({ rep, messages }) => {
      const out = await sendAsRepBatch(rep, messages, user.email);
      const sent = out.results.filter((r) => r.status === "sent").length;
      return {
        content: [
          {
            type: "text",
            text: `Sent ${sent}/${out.results.length} as ${out.rep}.\n${JSON.stringify(out.results, null, 2)}`,
          },
        ],
      };
    }
  );

  server.tool(
    "rep_send_log",
    "What went out as which rep: sends made with send_as_rep, newest first. Filter by rep " +
      "and/or an ISO date to start from.",
    {
      rep: z.string().email().optional(),
      since: z.string().optional().describe("ISO date or timestamp, e.g. 2026-11-01"),
      limit: z.number().int().min(1).max(500).optional(),
    },
    async ({ rep, since, limit }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(listRepSends({ rep, since, limit: limit ?? 100 }), null, 2),
        },
      ],
    })
  );
}

function buildServer(user: AuthedUser): McpServer {
  const server = new McpServer({ name: "ipromo-email-connector", version: "0.1.0" });

  server.tool(
    "send_email",
    "Send one or more fully-rendered emails from your own verified iPromo address. " +
      "Leave out 'from' to send as yourself (the normal case). Set 'from' only to send " +
      "as an approved shared address such as showcase@ipromo.com; other addresses are refused. " +
      "Files (PDFs, images, etc.) go in 'attachments' with base64 'content'. " +
      "To embed an image inline, add it as an attachment with disposition:'inline' and a " +
      "'contentId', then reference it in the HTML as <img src=\"cid:THAT_ID\">. " +
      "If your HTML pipeline strips <img> tags, instead write a plain-text token " +
      "[[IMG:contentId]] where the image should sit (optionally " +
      "[[IMG:contentId|alt=...|width=160]]) — it is swapped for the cid image before send. " +
      "If you only have image URLs (not bytes), pass 'images': [{url, contentId}] and the " +
      "server fetches each and inlines it; place them with the same [[IMG:contentId]] token. " +
      "The caller is responsible for unsubscribe links and list compliance.",
    sendEmailInput,
    async ({ from, messages }) => {
      if (!isAllowedSender(user.email)) {
        throw new Error(`Sender ${user.email} is not on an approved domain.`);
      }
      const fromEmail = (from?.email ?? user.email).toLowerCase();
      if (!canSendAs(user, fromEmail)) {
        throw new Error(`You can't send as ${fromEmail}. Leave out 'from' to send as yourself.`);
      }
      const shared = fromEmail !== user.email;
      const results = await sendBatch(
        fromEmail,
        from?.name,
        messages,
        shared ? user.email : undefined
      );

      const sent = results.filter((r) => r.status === "sent").length;
      return {
        content: [
          {
            type: "text",
            text: `Sent ${sent}/${results.length} as ${fromEmail}.\n${JSON.stringify(
              results,
              null,
              2
            )}`,
          },
        ],
      };
    }
  );

  return server;
}

// ── MCP endpoint (stateless streamable HTTP; auth enforced per request) ────
app.post("/mcp", async (req, res) => {
  const user = await authenticate(req.header("authorization"));
  if (!user) {
    res.setHeader("WWW-Authenticate", wwwAuthenticate);
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const server = buildServer(user);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// ── Site send endpoint (per-site static Bearer token, not Stytch) ────────
// Sites on Cloudflare (showcase, Cyber Week, ...) have no fixed egress IP, so
// they can't pass SendGrid's IP allowlist. They POST here instead and we send
// from this box. The token picks the site; `from` is limited to that site's
// senders; everything else matches send_email. /api/showcase/send is the
// original path and stays; /api/site/send is the same endpoint.
const siteInput = z.object({
  from: z.object({ email: z.string().email(), name: z.string().optional() }).optional(),
  messages,
});

const siteSend: express.RequestHandler = async (req, res) => {
  const site = siteForToken(req.header("authorization"));
  if (!site) {
    if (config.sites.length) recordAuthFailure("site_token_invalid");
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const parsed = siteInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
    return;
  }

  // Default `from` = the site's first exact (non-wildcard) sender.
  const defaultFrom = site.senders.find((s) => !s.startsWith("*@")) ?? "";
  const fromEmail = (parsed.data.from?.email ?? defaultFrom).toLowerCase();
  if (!siteMaySendAs(site, fromEmail)) {
    res.status(403).json({ error: "sender_not_allowed", from: fromEmail || null });
    return;
  }

  try {
    const results = await sendBatch(
      fromEmail,
      parsed.data.from?.name,
      parsed.data.messages,
      `site:${site.name}`
    );
    const sent = results.filter((r) => r.status === "sent").length;
    res.json({ from: fromEmail, sent, total: results.length, results });
  } catch (err) {
    // Only assertUnderCaps throws here; per-message SendGrid errors are in results.
    res.status(429).json({ error: err instanceof Error ? err.message : "send failed" });
  }
};
app.post("/api/showcase/send", siteSend);
app.post("/api/site/send", siteSend);

// ── Hosted authorization/consent UI (Stytch IdentityProvider) ──────────────
// Serve the built frontend from web/dist. API routes above take precedence;
// these SPA routes just hand back index.html and React does the rest.
const webDist = path.resolve("web/dist");
app.use(express.static(webDist));
for (const spaRoute of ["/authorize", "/login", "/authenticate"]) {
  app.get(spaRoute, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

startRepSync();

app.listen(config.port, () => {
  console.log(`iPromo email connector listening on :${config.port}`);
  console.log(`Resource: ${config.baseUrl}`);
  console.log(`Auth server: ${config.stytch.authorizationServer}`);
});
