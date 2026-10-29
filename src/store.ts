import Database from "better-sqlite3";
import { config } from "./config.js";

// Single-file SQLite store: audit log + rate-limit accounting.
// At ~4k sends/month this is plenty; no external DB needed.
const db = new Database("connector.sqlite");
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS send_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            TEXT    NOT NULL,          -- ISO timestamp (UTC)
    day           TEXT    NOT NULL,          -- YYYY-MM-DD (UTC), indexed for caps
    sender_email  TEXT    NOT NULL,          -- the verified @ipromo.com identity
    to_emails     TEXT    NOT NULL,          -- JSON array of recipients
    subject       TEXT    NOT NULL,
    status        TEXT    NOT NULL,          -- 'sent' | 'error'
    sendgrid_id   TEXT,
    error         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_send_log_day        ON send_log(day);
  CREATE INDEX IF NOT EXISTS idx_send_log_sender_day ON send_log(sender_email, day);

  -- One row per connected user (upserted on each successful auth).
  CREATE TABLE IF NOT EXISTS connections (
    subject             TEXT PRIMARY KEY,      -- Stytch user id
    email               TEXT NOT NULL,
    first_connected_at  TEXT NOT NULL,
    last_seen_at        TEXT NOT NULL,
    auth_count          INTEGER NOT NULL DEFAULT 0
  );

  -- Auth failures only (successful discovery 401s are NOT logged here).
  CREATE TABLE IF NOT EXISTS auth_failures (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TEXT NOT NULL,
    reason  TEXT NOT NULL,      -- jwt_invalid | no_subject | email_unresolved | domain_not_allowed | showcase_token_invalid
    detail  TEXT
  );
`);

// Added after launch: who actually sent when `from` was a shared address.
// NULL means sender_email was the user's own identity (or the showcase endpoint).
const sendLogCols = db.prepare(`PRAGMA table_info(send_log)`).all() as { name: string }[];
if (!sendLogCols.some((c) => c.name === "sent_by")) {
  db.exec(`ALTER TABLE send_log ADD COLUMN sent_by TEXT`);
}

const utcDay = (iso: string) => iso.slice(0, 10);

export interface SendRecord {
  ts: string;
  senderEmail: string;
  sentBy?: string; // signed-in user, when senderEmail is a shared address
  toEmails: string[];
  subject: string;
  status: "sent" | "error";
  sendgridId?: string;
  error?: string;
}

export function recordSend(r: SendRecord): void {
  db.prepare(
    `INSERT INTO send_log (ts, day, sender_email, sent_by, to_emails, subject, status, sendgrid_id, error)
     VALUES (@ts, @day, @sender, @sentBy, @to, @subject, @status, @sgid, @error)`
  ).run({
    ts: r.ts,
    day: utcDay(r.ts),
    sender: r.senderEmail,
    sentBy: r.sentBy ?? null,
    to: JSON.stringify(r.toEmails),
    subject: r.subject,
    status: r.status,
    sgid: r.sendgridId ?? null,
    error: r.error ?? null,
  });
}

// Count successful sends today for cap enforcement (UTC day).
function countToday(senderEmail?: string): number {
  const day = utcDay(new Date().toISOString());
  if (senderEmail) {
    return (
      db
        .prepare(
          `SELECT COUNT(*) n FROM send_log WHERE day = ? AND sender_email = ? AND status = 'sent'`
        )
        .get(day, senderEmail) as { n: number }
    ).n;
  }
  return (
    db.prepare(`SELECT COUNT(*) n FROM send_log WHERE day = ? AND status = 'sent'`).get(day) as {
      n: number;
    }
  ).n;
}

/** Upsert a connected user on each successful authentication. */
export function recordConnection(subject: string, email: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO connections (subject, email, first_connected_at, last_seen_at, auth_count)
     VALUES (@subject, @email, @now, @now, 1)
     ON CONFLICT(subject) DO UPDATE SET
       last_seen_at = @now, auth_count = auth_count + 1, email = @email`
  ).run({ subject, email, now });
}

/** Record an authentication failure (someone tried but was rejected). */
export function recordAuthFailure(reason: string, detail?: string): void {
  db.prepare(`INSERT INTO auth_failures (ts, reason, detail) VALUES (?, ?, ?)`).run(
    new Date().toISOString(),
    reason,
    detail ?? null
  );
}

/** Throws with a user-facing message if this send would exceed a cap. */
export function assertUnderCaps(senderEmail: string, howMany: number): void {
  if (countToday(senderEmail) + howMany > config.perUserDailyCap) {
    throw new Error(
      `Daily send cap reached for ${senderEmail} (${config.perUserDailyCap}/day). Try again tomorrow.`
    );
  }
  if (countToday() + howMany > config.globalDailyCap) {
    throw new Error(`Global daily send cap reached (${config.globalDailyCap}/day).`);
  }
}
