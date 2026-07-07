import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  baseUrl: required("CONNECTOR_BASE_URL").replace(/\/$/, ""),
  port: Number(process.env.PORT ?? 8080),

  stytch: {
    projectId: required("STYTCH_PROJECT_ID"),
    secret: required("STYTCH_SECRET"),
    authorizationServer: required("STYTCH_AUTHORIZATION_SERVER").replace(/\/$/, ""),
  },

  sendgridApiKey: required("SENDGRID_API_KEY"),

  perUserDailyCap: Number(process.env.PER_USER_DAILY_CAP ?? 200),
  globalDailyCap: Number(process.env.GLOBAL_DAILY_CAP ?? 2000),
  allowedSenderDomains: (process.env.ALLOWED_SENDER_DOMAINS ?? "ipromo.com")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
};
