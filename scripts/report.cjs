// Activity report for the connector. Run on the server:
//   node /home/deploy/app/scripts/report.cjs
const path = require("path");
const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
const db = new Database(path.join(__dirname, "..", "connector.sqlite"), { readonly: true });
const q = (sql) => db.prepare(sql).all();

const today = new Date().toISOString().slice(0, 10);

console.log(`\n===== iPromo Connector activity  (${new Date().toISOString()}) =====`);

console.log("\n--- CONNECTED USERS ---");
console.table(
  q(`SELECT email, first_connected_at, last_seen_at, auth_count
     FROM connections ORDER BY last_seen_at DESC`)
);

console.log(`\n--- SENDS TODAY (${today}) per user ---`);
console.table(
  q(`SELECT sender_email,
            SUM(status='sent') AS sent,
            SUM(status='error') AS errors
     FROM send_log WHERE day = '${today}'
     GROUP BY sender_email ORDER BY sent DESC`)
);

console.log("\n--- RECENT SENDS (last 20) ---");
console.table(
  q(`SELECT ts, sender_email, to_emails, subject, status, sendgrid_id, error
     FROM send_log ORDER BY id DESC LIMIT 20`)
);

console.log("\n--- AUTH FAILURES (last 20) ---");
console.table(q(`SELECT ts, reason, detail FROM auth_failures ORDER BY id DESC LIMIT 20`));

const totals = q(`SELECT
    (SELECT COUNT(*) FROM connections) AS users,
    (SELECT COUNT(*) FROM send_log WHERE status='sent') AS total_sent,
    (SELECT COUNT(*) FROM send_log WHERE status='error') AS total_errors,
    (SELECT COUNT(*) FROM auth_failures) AS auth_failures`)[0];
console.log("\n--- TOTALS ---");
console.log(totals);
