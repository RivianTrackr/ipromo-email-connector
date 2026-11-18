import type { RepProfile } from "./graph.js";

// Rep signatures, built from the rep's Microsoft 365 profile (name, job title,
// phone, email). Outlook signatures can't be read through Graph, so this mirrors
// the iPromo signature builder (ipromo-signature-builder/index.html), using the
// HubSpot-hosted images like its "For IT" version. Light colors only: it lands
// in the recipient's inbox, and Outlook/Gmail handle dark mode themselves.
// Keep the holiday lines in step with the builder when the campaign changes.

const HOSTED = "https://51122294.fs1.hubspotusercontent-na1.net/hubfs/51122294/email-signature/";
const UTM = "utm_source=signature&utm_medium=email&utm_campaign=email-signature";
const LINKS = {
  holiday: `https://holidays.ipromo.com/?${UTM}&utm_content=holiday-catalog-2026`,
  demandx: `https://www.ipromo.com/demandx?${UTM}&utm_content=demandx`,
  site: `https://www.ipromo.com/?${UTM}&utm_content=website`,
  awards: `https://www.ipromo.com/?${UTM}&utm_content=awards`,
};
const C = { name: "#172139", body: "#4A5363", link: "#2C7A89", rule: "#59A6B4", hair: "#D5DCE3" };
const FONT = "Arial,Helvetica,sans-serif";
const AWARDS_ALT = "Inc. 5000 3x honoree and Counselor Best Places to Work 2022";

const esc = (s: string) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function img(file: string, w: number, h: number, alt: string): string {
  return (
    `<img src="${HOSTED}${file}" width="${w}" height="${h}" alt="${alt}" style="display:block;width:${w}px;` +
    `height:${h}px;border:0;outline:none;text-decoration:none;font-family:${FONT};font-size:11px;">`
  );
}
function a(href: string, text: string, color: string, size: number, bold = false, underline = false): string {
  return (
    `<a href="${esc(href)}" style="color:${color};text-decoration:${underline ? "underline" : "none"};` +
    `font-weight:${bold ? "bold" : "normal"};font-family:${FONT};font-size:${size}px;">${text}</a>`
  );
}
function td(inner: string, color: string, size: number, pad: string): string {
  const lh = Math.round(size * 1.45);
  return (
    `<td style="padding:${pad};font-family:${FONT};font-size:${size}px;line-height:${lh}px;` +
    `mso-line-height-rule:exactly;color:${color};">${inner}</td>`
  );
}
const wrap = (inner: string) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;` +
  `mso-table-lspace:0pt;mso-table-rspace:0pt;font-family:${FONT};">${inner}</table>`;

function telOf(phone: string): string {
  const d = phone.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.charAt(0) === "1") return "+" + d;
  return d ? "+" + d : "";
}

export function signatureHtml(p: Pick<RepProfile, "name" | "title" | "phone" | "email">): string {
  let rows = "";
  rows += `<tr>${td(`<strong style="font-weight:bold;">${esc(p.name)}</strong>`, C.name, 16, "0 0 1px 0")}</tr>`;
  if (p.title) rows += `<tr>${td(esc(p.title), C.body, 13, "0")}</tr>`;
  const sep = `<span style="color:${C.hair};">&nbsp;|&nbsp;</span>`;
  const line =
    (p.phone ? a(`tel:${telOf(p.phone)}`, esc(p.phone), C.body, 13) : "") +
    (p.phone && p.email ? sep : "") +
    (p.email ? a(`mailto:${p.email}`, esc(p.email), C.body, 13) : "");
  rows += `<tr>${td(line, C.body, 13, "0")}</tr>`;
  rows += `<tr>${td(a(LINKS.site, "iPromo.com", C.link, 13, true), C.link, 13, "0")}</tr>`;

  const head = wrap(
    "<tr>" +
      `<td valign="top" style="padding:2px 14px 0 0;vertical-align:top;"><a href="${esc(LINKS.site)}" style="text-decoration:none;">` +
      img("sig-ipromo-logo.png", 64, 84, "iPromo, est. 1999") +
      "</a></td>" +
      `<td valign="top" style="padding:0 0 0 14px;border-left:2px solid ${C.rule};vertical-align:top;">${wrap(rows)}</td></tr>`
  );
  let body = `<tr><td style="padding:0;">${head}</td></tr>`;
  body += `<tr>${td(a(LINKS.holiday, "Explore the 2026 Holiday Catalog &#8594;", C.link, 15, true, true), C.link, 15, "16px 0 1px 0")}</tr>`;
  body += `<tr>${td("See your logo in 3D on 60 products.", C.body, 13, "0 0 8px 0")}</tr>`;
  body += `<tr>${td(
    a(LINKS.demandx, "DemandX Company Stores", C.name, 13, true, true) +
      " built in 7 days. No minimums, no inventory, zero waste.",
    C.body,
    13,
    "0"
  )}</tr>`;
  body +=
    `<tr><td style="padding:14px 0 0 0;">` +
    wrap(
      `<tr><td valign="top" align="left" style="padding:0;vertical-align:top;"><a href="${esc(LINKS.awards)}" style="text-decoration:none;">` +
        img("ipromo-awards-3x-honoree-v3@2x.png", 119, 68, AWARDS_ALT) +
        "</a></td></tr>"
    ) +
    "</td></tr>";
  return wrap(body);
}

/** Put the signature at the end of the body (before </body> when the HTML has one). */
export function appendSignature(html: string, sig: string): string {
  const block = `<div style="margin-top:20px;">${sig}</div>`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${block}</body>`) : html + block;
}
