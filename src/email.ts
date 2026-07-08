import sgMail from "@sendgrid/mail";
import { config } from "./config.js";

sgMail.setApiKey(config.sendgridApiKey);

export interface Attachment {
  /** Base64-encoded file contents. */
  content: string;
  filename: string;
  /** MIME type, e.g. "application/pdf" or "image/png". */
  type?: string;
  /** "attachment" (default) or "inline" for images referenced via cid: in the HTML. */
  disposition?: "attachment" | "inline";
  /** Required for inline images: the id referenced as <img src="cid:THIS_ID"> in the HTML. */
  contentId?: string;
}

export interface OutgoingMessage {
  to: { email: string; name?: string }[];
  subject: string;
  html: string;
  text?: string;
  cc?: { email: string; name?: string }[];
  bcc?: { email: string; name?: string }[];
  replyTo?: { email: string; name?: string };
  attachments?: Attachment[];
}

export interface SendResult {
  status: "sent" | "error";
  sendgridId?: string;
  error?: string;
}

/** Chars allowed in a token / contentId — keeps the swap from injecting markup. */
const IMG_ID_RE = /^[A-Za-z0-9_-]+$/;

function escapeAttr(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Place an inline image at an exact spot in the body via a plain-text token.
 *
 * Some upstream composers strip author-supplied `<img>` tags — even safe `cid:`
 * references — before the HTML reaches us. A plain-text token survives that
 * sanitizing, so callers write `[[IMG:contentId]]` where the image should sit and
 * we swap it for `<img src="cid:contentId">` here, at the last hop before SendGrid.
 * Optional attributes: `[[IMG:logo|alt=iPromo|width=160]]`.
 *
 * A token is replaced only when the message carries an **inline** attachment whose
 * `contentId` matches; unmatched or malformed tokens are left untouched, so an
 * authoring mistake stays visible instead of becoming a broken-image icon.
 */
export function renderImageTokens(html: string, attachments?: Attachment[]): string {
  if (!html.includes("[[IMG:") || !attachments?.length) return html;

  const inlineIds = new Set(
    attachments
      .filter((a) => (a.disposition ?? "attachment") === "inline" && a.contentId)
      .map((a) => a.contentId as string)
  );
  if (!inlineIds.size) return html;

  return html.replace(/\[\[IMG:([^\]]+)\]\]/g, (whole, body: string) => {
    const [rawId, ...attrParts] = body.split("|");
    const id = rawId.trim();
    if (!IMG_ID_RE.test(id) || !inlineIds.has(id)) return whole; // leave the token as-is

    let alt = "";
    let width = "";
    for (const part of attrParts) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      const key = part.slice(0, eq).trim().toLowerCase();
      const val = part.slice(eq + 1).trim();
      if (key === "alt") alt = val;
      else if (key === "width" && /^\d+$/.test(val)) width = val;
    }

    return (
      `<img src="cid:${id}" alt="${escapeAttr(alt)}"` + (width ? ` width="${width}"` : "") + " />"
    );
  });
}

/**
 * Send one fully-rendered message. `fromEmail` is the VERIFIED identity injected
 * by the server — callers never supply `from`. Tracking (open/click) is on and
 * uses the branded link domain configured in SendGrid (url9892.ipromo.com).
 */
export async function sendOne(
  fromEmail: string,
  fromName: string | undefined,
  msg: OutgoingMessage
): Promise<SendResult> {
  try {
    const [res] = await sgMail.send({
      from: { email: fromEmail, name: fromName },
      replyTo: msg.replyTo ?? { email: fromEmail, name: fromName },
      personalizations: [
        {
          to: msg.to,
          ...(msg.cc ? { cc: msg.cc } : {}),
          ...(msg.bcc ? { bcc: msg.bcc } : {}),
        },
      ],
      subject: msg.subject,
      html: renderImageTokens(msg.html, msg.attachments),
      ...(msg.text ? { text: msg.text } : {}),
      ...(msg.attachments && msg.attachments.length
        ? {
            attachments: msg.attachments.map((a) => ({
              content: a.content,
              filename: a.filename,
              ...(a.type ? { type: a.type } : {}),
              disposition: a.disposition ?? "attachment",
              // SendGrid expects snake_case `content_id`; only meaningful for inline parts.
              ...(a.contentId ? { content_id: a.contentId } : {}),
            })),
          }
        : {}),
      trackingSettings: {
        clickTracking: { enable: true, enableText: false },
        openTracking: { enable: true },
      },
    });
    return { status: "sent", sendgridId: res.headers["x-message-id"] as string | undefined };
  } catch (err: unknown) {
    const message =
      (err as { response?: { body?: { errors?: { message: string }[] } } })?.response?.body
        ?.errors?.map((e) => e.message)
        .join("; ") ?? (err instanceof Error ? err.message : "unknown SendGrid error");
    return { status: "error", error: message };
  }
}
