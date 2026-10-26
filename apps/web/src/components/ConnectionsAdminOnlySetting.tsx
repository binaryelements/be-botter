import { Trans } from "@lingui/react/macro";
import { Label, Switch, toast } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

const showError = (error: unknown) => toast.error(errorText(error));

/** The deployment owner's switch that stops staff adding servers, tokens and accounts. */
export function ConnectionsAdminOnlySetting() {
  const id = useId();
  const [on, setOn] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void rpc.deployment
      .get()
      .then((settings) => setOn(settings.connectionsAdminOnly))
      .catch(showError);
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
        onCheckedChange={(checked) => void change(checked).catch(showError)}
      />
      <Label htmlFor={id} className="text-[14px] font-normal text-foreground/75">
        <Trans>Only admins add bots and connections</Trans>
      </Label>
    </div>
  );
}
