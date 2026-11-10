import {
  browserSupportsWebAuthn,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { useState } from "react";
import { request } from "./api.ts";
import { Brand, Button, ErrorText, LoginFrame, useAction } from "./ui.tsx";

let enrollmentSecret: string | null = null;
if (location.pathname === "/welcome") {
  enrollmentSecret = new URLSearchParams(location.hash.slice(1)).get("key");
  history.replaceState(null, "", location.pathname + location.search);
}
export function Login({ done, welcome = false }: { done: () => void; welcome?: boolean }) {
  const [copyStatus, setCopyStatus] = useState("");
  const { busy, error, run } = useAction();
  const supported = window.isSecureContext && browserSupportsWebAuthn();
  const enter = async () => {
    if (welcome) {
      const optionsJSON = await request<PublicKeyCredentialCreationOptionsJSON>(
        "/api/passkeys/register/options",
        { token: enrollmentSecret },
      );
      const response = await startRegistration({ optionsJSON });
      await request("/api/passkeys/register/verify", { response });
      enrollmentSecret = null;
      history.replaceState(null, "", "/");
    } else {
      const optionsJSON = await request<PublicKeyCredentialRequestOptionsJSON>(
        "/api/passkeys/authenticate/options",
        {},
      );
      const response = await startAuthentication({ optionsJSON });
      await request("/api/passkeys/authenticate/verify", { response });
    }
    done();
  };
  return (
    <LoginFrame>
      <Brand />
      <h1>{welcome ? "Welcome to AllGather" : "Sign in to AllGather"}</h1>
      <p>
        {welcome
          ? "Create a passkey to enter. Next time, use your passkey to sign in."
          : "Use your passkey to open your workspace."}
      </p>
      <p className="muted small">
        {location.host}
        {welcome && " · This browser will have owner access."}
      </p>
      {!supported && (
        <p role="alert">
          Passkeys require a supported browser and a secure connection. Open AllGather using its
          HTTPS address, or localhost for local setup.
        </p>
      )}
      {welcome && !enrollmentSecret ? (
        <p role="alert">
          Open the complete login link from your server. If you refreshed this page, generate a new
          link with the command below.
        </p>
      ) : (
        <Button
          variant="primary"
          className="login-enter"
          disabled={busy || !supported}
          onClick={() => void run(enter)}
        >
          {busy
            ? "Waiting for your passkey…"
            : welcome
              ? "Create passkey and enter"
              : "Sign in with passkey"}
        </Button>
      )}
      <ErrorText>{error}</ErrorText>
      {welcome && (
        <p className="muted small">
          The link works once and expires after five minutes. Cancelling passkey creation does not
          use the link.
        </p>
      )}
      <p className="muted small">
        {welcome ? "Need a new link?" : "First time here, or lost your passkey?"} Run this command
        on your AllGather server:
      </p>
      <div className="login-command">
        <code>allgather-server login</code>
        <Button
          aria-label="Copy login command"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText("allgather-server login");
              setCopyStatus("Command copied.");
            } catch {
              setCopyStatus("Could not copy. Select and copy the command above.");
            }
          }}
        >
          Copy
        </Button>
      </div>
      <p className="muted small" role="status">
        {copyStatus}
      </p>
    </LoginFrame>
  );
}
