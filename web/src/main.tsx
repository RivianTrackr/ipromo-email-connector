import React from "react";
import ReactDOM from "react-dom/client";
// v20 moved createStytchUIClient to the root export (the /ui subpath is gone).
import { StytchProvider, createStytchUIClient } from "@stytch/react";
import { App } from "./App";

// Public token is safe in the browser. The frontend never sees the Stytch secret.
const stytch = createStytchUIClient(import.meta.env.VITE_STYTCH_PUBLIC_TOKEN);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StytchProvider stytch={stytch}>
      <App />
    </StytchProvider>
  </React.StrictMode>
);
