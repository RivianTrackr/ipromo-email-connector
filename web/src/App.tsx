import { useEffect, useRef, useState } from "react";
import { IdentityProvider, useStytch, useStytchUser } from "@stytch/react";

const ORIGIN = window.location.origin;
const SESSION_MINUTES = 60;
const RETURN_KEY = "ipromo_return_to";

// Stytch's own API host for this token's environment: where the Microsoft login
// has to start. See startMicrosoftLogin.
const STYTCH_OAUTH_HOST = import.meta.env.VITE_STYTCH_PUBLIC_TOKEN?.startsWith(
  "public-token-test-"
)
  ? "test.stytch.com"
  : "api.stytch.com";

// A branded, centered status screen with a spinner so the transition states never
// look blank or stuck — and reassure the user that Claude will reopen on its own.
function StatusCard({ title, message }: { title: string; message: string }) {
  return (
    <div style={{ maxWidth: 400, textAlign: "center", fontFamily: "system-ui" }}>
      <style>{"@keyframes ipromo-spin{to{transform:rotate(360deg)}}"}</style>
      <div
        style={{
          width: 36,
          height: 36,
          margin: "0 auto 20px",
          border: "3px solid #e5e5ea",
          borderTopColor: "#0071e3",
          borderRadius: "50%",
          animation: "ipromo-spin 0.8s linear infinite",
        }}
      />
      <div style={{ fontSize: 20, fontWeight: 600, color: "#1d1d1f", marginBottom: 8 }}>
        {title}
      </div>
      <div style={{ fontSize: 14, color: "#6e6e73", lineHeight: 1.5 }}>{message}</div>
    </div>
  );
}

// Backs the Stytch "Authorization URL". Flow:
//   /authorize     → if no session, stash this full URL, bounce to /authenticate
//   /authenticate  → OAuth start + callback (headless, same path):
//                      • no token, no session → oauth.microsoft.start()
//                      • ?token= → oauth.authenticate(token), capture the email,
//                        then redirect to the stashed /authorize URL
//   /authorize     → signed in → <IdentityProvider/> consent → back to Claude
//
// Why we capture the email ourselves: Microsoft delivers the address in the OAuth
// access token (upn/email claim), but Stytch's id_token comes back blank so it
// leaves user.emails = []. We decode the access token here and persist the address
// to the user's untrusted_metadata so the connector can read it via users.get.

function returnToStashed() {
  const returnTo = sessionStorage.getItem(RETURN_KEY) ?? `${ORIGIN}/authorize`;
  sessionStorage.removeItem(RETURN_KEY);
  window.location.replace(returnTo);
}

function emailFromAccessToken(accessToken: unknown): string {
  if (typeof accessToken !== "string") return "";
  const part = accessToken.split(".")[1];
  if (!part) return "";
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = JSON.parse(atob(b64 + pad));
    const e =
      json.email || json.upn || json.preferred_username || json.unique_name || "";
    return typeof e === "string" ? e.toLowerCase() : "";
  } catch {
    return "";
  }
}

// Start the Microsoft login on Stytch's own API host, not the project domain the
// SDK is pointed at (main.tsx). Stytch's /oauth/microsoft/start sets its `state`
// cookie with Domain=test.stytch.com (where Microsoft calls back) even when served
// from <project>.customers.stytch.dev, so the browser drops it and every fresh
// login ends in oauth_state_mismatch. Starting on the callback's own host keeps
// the cookie. Everything else (token exchange, consent) stays on the project domain.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function startMicrosoftLogin(stytch: any) {
  const oauth = stytch.oauth;
  const navigate = oauth.navigate.bind(oauth); // the SDK's public redirect hook
  oauth.navigate = (url: URL) => {
    url.host = STYTCH_OAUTH_HOST;
    navigate(url);
  };
  oauth.microsoft.start({
    login_redirect_url: `${ORIGIN}/authenticate`,
    signup_redirect_url: `${ORIGIN}/authenticate`,
  });
}

function AuthenticatePage() {
  const stytch = useStytch();
  const { user, isInitialized } = useStytchUser();
  const ran = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const token = new URLSearchParams(window.location.search).get("token");

  useEffect(() => {
    if (!isInitialized || ran.current) return;
    ran.current = true;
    if (user) {
      returnToStashed();
      return;
    }
    if (token) {
      stytch.oauth
        .authenticate(token, { session_duration_minutes: SESSION_MINUTES })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then(async (res: any) => {
          const email = emailFromAccessToken(res?.provider_values?.access_token);
          if (email) {
            try {
              await stytch.user.update({ untrusted_metadata: { email } });
            } catch (e) {
              console.error("user.update failed", e);
            }
          }
          returnToStashed();
        })
        .catch((err) => {
          console.error("OAuth authenticate failed", err);
          const type = err?.error_type ? `[${err.error_type}] ` : "";
          setError(type + (err?.error_message ?? err?.message ?? JSON.stringify(err)));
        });
    } else {
      startMicrosoftLogin(stytch);
    }
  }, [stytch, user, isInitialized, token]);

  if (error)
    return (
      <pre
        style={{
          fontFamily: "ui-monospace, monospace",
          padding: 24,
          whiteSpace: "pre-wrap",
          color: "#b91c1c",
        }}
      >
        Sign-in error:{"\n"}
        {error}
      </pre>
    );
  return token ? (
    <StatusCard
      title="Signing you in…"
      message="Almost done — you'll be returned to Claude automatically. You can close this tab once Claude reconnects."
    />
  ) : (
    <StatusCard
      title="Redirecting to Microsoft…"
      message="Taking you to sign in with your iPromo account."
    />
  );
}

function AuthorizePage() {
  const { user, isInitialized } = useStytchUser();
  useEffect(() => {
    if (isInitialized && !user) {
      sessionStorage.setItem(RETURN_KEY, window.location.href); // keep Claude's OAuth params
      window.location.replace(`${ORIGIN}/authenticate`);
    }
  }, [isInitialized, user]);

  if (!isInitialized)
    return <StatusCard title="Connecting…" message="Setting things up." />;
  if (!user)
    return <StatusCard title="Redirecting to sign in…" message="One moment." />;
  return (
    <div style={{ textAlign: "center", fontFamily: "system-ui", maxWidth: 440 }}>
      <IdentityProvider />
      <p style={{ fontSize: 13, color: "#6e6e73", marginTop: 16 }}>
        After you approve, you'll be returned to Claude automatically.
      </p>
    </div>
  );
}

export function App() {
  const path = window.location.pathname;
  const page = path.startsWith("/authenticate") ? (
    <AuthenticatePage />
  ) : (
    <AuthorizePage />
  );
  // Center all connector pages (sign-in messages + Stytch consent card).
  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        boxSizing: "border-box",
      }}
    >
      {page}
    </div>
  );
}
