import * as stytch from "stytch";
import { config } from "../src/config.js";

const client = new stytch.Client({
  project_id: config.stytch.projectId,
  secret: config.stytch.secret,
});

const userId = process.argv[2];
const res = await client.users.delete({ user_id: userId });
console.log("deleted", userId, "status", res.status_code);
