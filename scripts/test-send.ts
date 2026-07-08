// Standalone SendGrid deliverability check — validates the email half in
// isolation (restricted API key + domain auth + DMARC) before wiring Claude.
//
//   npm run test:send -- you@ipromo.com jose.castillo@ipromo.com
//
// Then open the received email, "Show original"/headers, and confirm:
//   dkim=pass   dmarc=pass   (spf may be neutral — that's expected via SendGrid)
import { sendOne } from "../src/email.js";

const to = process.argv[2];
const from = process.argv[3];
if (!to || !from) {
  console.error(
    "Usage: npm run test:send -- <to-email> <from-email@ipromo.com>"
  );
  process.exit(1);
}

// A 1x1 red PNG — used both as an inline (cid) image and as a file attachment,
// so one test send exercises both code paths.
const redDotPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const result = await sendOne(from, undefined, {
  to: [{ email: to }],
  subject: "iPromo connector — test send",
  text: "Plaintext test from the iPromo email connector.",
  html:
    "<p>This is a test from the <strong>iPromo email connector</strong>.</p>" +
    "<p>If you're reading this, the SendGrid key and domain authentication work. " +
    "Check the message headers for <code>dkim=pass</code> and <code>dmarc=pass</code>.</p>" +
    '<p>Inline image via cid (should render here): <img src="cid:reddot" width="16" height="16" alt="red dot"></p>' +
    "<p>Inline image via token (should also render here): [[IMG:reddot|alt=red dot|width=16]]</p>" +
    "<p>There should also be a <code>hello.txt</code> file and a <code>red-dot.png</code> attached.</p>",
  attachments: [
    {
      content: redDotPng,
      filename: "red-dot.png",
      type: "image/png",
      disposition: "inline",
      contentId: "reddot",
    },
    {
      content: Buffer.from("Hello from the iPromo email connector.\n").toString("base64"),
      filename: "hello.txt",
      type: "text/plain",
    },
  ],
});

console.log(JSON.stringify(result, null, 2));
process.exit(result.status === "sent" ? 0 : 1);
