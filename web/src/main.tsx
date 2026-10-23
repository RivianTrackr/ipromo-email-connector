import React from "react";
import ReactDOM from "react-dom/client";
// v20 moved createStytchUIClient to the root export (the /ui subpath is gone).
import { StytchProvider, createStytchUIClient } from "@stytch/react";
import { App } from "./App";

// Public token is safe in the browser. The frontend never sees the Stytch secret.
// The SDK must call the project's own domain (the authorization server, e.g.
// https://<project>.customers.stytch.dev), not the default test.stytch.com: the
// consent step's redirect back to Claude carries an `iss` that has to equal the
// issuer in that domain's OAuth metadata, and Claude rejects the connection if not.
const stytch = createStytchUIClient(import.meta.env.VITE_STYTCH_PUBLIC_TOKEN, {
  customBaseUrl: import.meta.env.VITE_STYTCH_BASE_URL || undefined,
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StytchProvider stytch={stytch}>
      <App />
    </StytchProvider>
  </React.StrictMode>
);
