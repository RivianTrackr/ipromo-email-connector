import * as stytch from "stytch";
import { config } from "../src/config.js";

const client = new stytch.Client({
  project_id: config.stytch.projectId,
  secret: config.stytch.secret,
});

const userId = process.argv[2];
const user = await client.users.get({ user_id: userId });
console.log(JSON.stringify(user, null, 2));
