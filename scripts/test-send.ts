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

const result = await sendOne(from, undefined, {
  to: [{ email: to }],
  subject: "iPromo connector — test send",
  text: "Plaintext test from the iPromo email connector.",
  html:
    "<p>This is a test from the <strong>iPromo email connector</strong>.</p>" +
    "<p>If you're reading this, the SendGrid key and domain authentication work. " +
    "Check the message headers for <code>dkim=pass</code> and <code>dmarc=pass</code>.</p>",
});

console.log(JSON.stringify(result, null, 2));
process.exit(result.status === "sent" ? 0 : 1);
