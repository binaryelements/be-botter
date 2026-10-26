import { Trans } from "@lingui/react/macro";
import { Label, Switch } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";

/** The deployment owner's switch that stops staff adding servers, tokens and accounts. */
export function ConnectionsAdminOnlySetting() {
  const id = useId();
  const [on, setOn] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void rpc.deployment
      .get()
      .then((settings) => setOn(settings.connectionsAdminOnly))
      .catch(() => undefined);
  }, []);

  async function change(next: boolean) {
    setPending(true);
    try {
      setOn((await rpc.deployment.update({ connectionsAdminOnly: next })).connectionsAdminOnly);
    } finally {
      setPending(false);
    }
  }

  if (on === null) return null;
  return (
    <div className="flex items-start gap-3">
      <Switch
        id={id}
        data-testid="connections-admin-only"
        className="mt-0.5"
        checked={on}
        disabled={pending}
        onCheckedChange={(checked) => void change(checked).catch(() => undefined)}
      />
      <Label htmlFor={id} className="text-[14px] font-normal text-foreground/75">
        <Trans>Only admins add connections</Trans>
      </Label>
    </div>
  );
}
