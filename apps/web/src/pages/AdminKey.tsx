import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Input } from "@rakazo/ui-web";
import { useState } from "react";
import { authClient } from "../lib/auth";

export function AdminKeyPage() {
  const { t } = useLingui();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);

  async function submit() {
    setBusy(true);
    setRefused(false);
    const { error } = await authClient.$fetch("/sign-in/admin-key", {
      method: "POST",
      body: { key },
    });
    if (error) {
      setRefused(true);
      setBusy(false);
      return;
    }
    // A full load so the session store picks up the new cookie.
    window.location.assign("/setup");
  }

  return (
    <main className="flex h-dvh items-center justify-center px-4">
      <form
        className="w-full max-w-sm space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (key && !busy) void submit();
        }}
      >
        <Input
          type="password"
          autoComplete="off"
          aria-label={t`Admin key`}
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        {refused ? (
          <p role="alert" className="text-[13px] text-destructive">
            <Trans>Wrong admin key</Trans>
          </p>
        ) : null}
        <Button type="submit" disabled={!key || busy}>
          <Trans>Continue</Trans>
        </Button>
      </form>
    </main>
  );
}
