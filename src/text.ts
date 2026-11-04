/**
 * Turn a message's HTML into a readable plain-text alternative.
 *
 * Real 1:1 mail from a mail client always carries a text/plain part next to the
 * HTML. HTML-only mail is a common trait of bulk/marketing sends, so when the
 * caller doesn't supply `text` we derive one. This is deliberately simple (no
 * dependency): block tags become line breaks, links keep their URL, images are
 * dropped, entities are decoded and whitespace is tidied.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1].toLowerCase() === "x" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? whole;
  });
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, "");

export function htmlToText(html: string): string {
  let s = html;
  // Drop non-content blocks entirely.
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(head|style|script|title)\b[\s\S]*?<\/\1>/gi, "");
  // Image tokens / images carry no text.
  s = s.replace(/\[\[IMG:[^\]]*\]\]/g, "");
  s = s.replace(/<img\b[^>]*>/gi, "");
  // Links: keep the text, add the URL when it differs from the text.
  s = s.replace(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_m, _q, href: string, inner: string) => {
    const text = decodeEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
    const url = decodeEntities(href).trim();
    if (!url || url.startsWith("#") || /^javascript:/i.test(url)) return text;
    const bare = url.replace(/^mailto:/i, "");
    if (!text || text === url || text === bare) return bare;
    return `${text} (${bare})`;
  });
  // Structure → line breaks.
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<\/(p|div|h[1-6]|table|ul|ol|blockquote|section|article|header|footer)>/gi, "\n\n");
  s = s.replace(/<\/tr>/gi, "\n");
  s = s.replace(/<\/t[dh]>/gi, " ");
  s = s.replace(/<hr\b[^>]*>/gi, "\n\n");
  s = decodeEntities(stripTags(s));
  // Tidy whitespace.
  s = s.replace(/\r\n?/g, "\n");
  s = s.replace(/[ \t ]+/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}
