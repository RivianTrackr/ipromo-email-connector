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
  isValidShowcaseToken,
  protectedResourceMetadata,
  wwwAuthenticate,
  type AuthedUser,
} from "./auth.js";
import { sendOne, type OutgoingMessage, type SendResult } from "./email.js";
import { fetchInlineImages } from "./images.js";
import { assertUnderCaps, recordAuthFailure, recordSend } from "./store.js";

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

// ── Showcase site send endpoint (static Bearer token, not Stytch) ──────────
// The showcase runs on Cloudflare with no fixed egress IP, so it can't pass
// SendGrid's IP allowlist. It POSTs here instead and we send from this box.
// `from` is limited to SHOWCASE_SENDERS; everything else matches send_email.
const showcaseInput = z.object({
  from: z.object({ email: z.string().email(), name: z.string().optional() }).optional(),
  messages,
});

app.post("/api/showcase/send", async (req, res) => {
  if (!isValidShowcaseToken(req.header("authorization"))) {
    if (config.showcase.apiToken) recordAuthFailure("showcase_token_invalid");
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const parsed = showcaseInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
    return;
  }

  const fromEmail = (parsed.data.from?.email ?? config.showcase.senders[0] ?? "").toLowerCase();
  if (!config.showcase.senders.includes(fromEmail) || !isAllowedSender(fromEmail)) {
    res.status(403).json({ error: "sender_not_allowed", from: fromEmail || null });
    return;
  }

  try {
    const results = await sendBatch(fromEmail, parsed.data.from?.name, parsed.data.messages);
    const sent = results.filter((r) => r.status === "sent").length;
    res.json({ from: fromEmail, sent, total: results.length, results });
  } catch (err) {
    // Only assertUnderCaps throws here; per-message SendGrid errors are in results.
    res.status(429).json({ error: err instanceof Error ? err.message : "send failed" });
  }
});

// ── Hosted authorization/consent UI (Stytch IdentityProvider) ──────────────
// Serve the built frontend from web/dist. API routes above take precedence;
// these SPA routes just hand back index.html and React does the rest.
const webDist = path.resolve("web/dist");
app.use(express.static(webDist));
for (const spaRoute of ["/authorize", "/login", "/authenticate"]) {
  app.get(spaRoute, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

app.listen(config.port, () => {
  console.log(`iPromo email connector listening on :${config.port}`);
  console.log(`Resource: ${config.baseUrl}`);
  console.log(`Auth server: ${config.stytch.authorizationServer}`);
});
