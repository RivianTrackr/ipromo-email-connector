import sgMail from "@sendgrid/mail";
import { config } from "./config.js";

sgMail.setApiKey(config.sendgridApiKey);

export interface OutgoingMessage {
  to: { email: string; name?: string }[];
  subject: string;
  html: string;
  text?: string;
  cc?: { email: string; name?: string }[];
  bcc?: { email: string; name?: string }[];
  replyTo?: { email: string; name?: string };
}

export interface SendResult {
  status: "sent" | "error";
  sendgridId?: string;
  error?: string;
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
      html: msg.html,
      ...(msg.text ? { text: msg.text } : {}),
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
