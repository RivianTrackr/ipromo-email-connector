import * as stytch from "stytch";
import { config } from "../src/config.js";

const client = new stytch.Client({
  project_id: config.stytch.projectId,
  secret: config.stytch.secret,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const res: any = await client.users.search({
  limit: 20,
  query: { operator: "OR", operands: [] },
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const users = (res.results as any[]).sort((a, b) =>
  String(b.created_at).localeCompare(String(a.created_at))
);
for (const u of users.slice(0, 5)) {
  console.log(
    u.created_at,
    u.user_id,
    "emails:",
    JSON.stringify((u.emails || []).map((e: { email: string }) => e.email)),
    "provider:",
    (u.providers || []).map((p: { provider_type: string }) => p.provider_type).join(",")
  );
}
