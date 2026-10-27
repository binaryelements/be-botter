import { Trans, useLingui } from "@lingui/react/macro";
import type { Invitation } from "@rakazo/contracts";
import { Button, Checkbox, Input, Switch } from "@rakazo/ui-web";
import { XIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";

type Mode = "invited" | "organisation";
type Department = { id: string; name: string };

/** Who may sign in to the company, and the people invited to it. */
export function PeopleSettings() {
  const rpc = useSpaceRpc();
  const { t } = useLingui();
  const ids = useId();
  const [mode, setMode] = useState<Mode>("invited");
  const [departments, setDepartments] = useState<Department[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [email, setEmail] = useState("");
  // Chosen departments by id: the person's role in each.
  const [chosen, setChosen] = useState<Record<string, "member" | "head">>({});
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([rpc.company.signInMode.get(), rpc.invitations.list()])
      .then(([current, list]) => {
        if (cancelled) return;
        setMode(current.mode);
        setDepartments(current.departments);
        setInvitations(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err, t`Could not load`));
      });
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err, t`Could not save`));
    } finally {
      setBusy(false);
    }
  }

  const changeMode = (organisation: boolean) =>
    run(async () => {
      const next: Mode = organisation ? "organisation" : "invited";
      setMode((await rpc.company.signInMode.set({ mode: next })).mode);
    });

  const invite = () =>
    run(async () => {
      const result = await rpc.invitations.create({
        email: email.trim(),
        departments: Object.entries(chosen).map(([departmentId, role]) => ({ departmentId, role })),
      });
      setInvitations((current) => [...current, result.invitation]);
      setLink(result.emailed ? null : result.signInUrl);
      setEmail("");
      setChosen({});
    });

  const revoke = (invitationId: string) =>
    run(async () => {
      await rpc.invitations.revoke({ invitationId });
      setInvitations((current) => current.filter((item) => item.id !== invitationId));
    });

  function toggle(departmentId: string, on: boolean) {
    setChosen((current) => {
      const { [departmentId]: _removed, ...rest } = current;
      return on ? { ...rest, [departmentId]: "member" } : rest;
    });
  }

  return (
    <div data-testid="people-settings" className="pt-5">
      <label className="flex items-center gap-3 text-[15px]" htmlFor={`${ids}-mode`}>
        <Switch
          id={`${ids}-mode`}
          checked={mode === "organisation"}
          disabled={busy}
          onCheckedChange={(checked) => void changeMode(checked)}
        />
        {mode === "organisation" ? (
          <Trans>Anyone in our Microsoft organisation</Trans>
        ) : (
          <Trans>Invited people only</Trans>
        )}
      </label>
      <form
        className="mt-6 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void invite();
        }}
      >
        <div className="flex flex-wrap items-end gap-2">
          <label
            htmlFor={`${ids}-email`}
            className="min-w-48 flex-1 text-[14px] text-muted-foreground"
          >
            <Trans>Email</Trans>
            <Input
              id={`${ids}-email`}
              type="email"
              required
              autoComplete="off"
              value={email}
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
              className="mt-1.5"
            />
          </label>
          <Button type="submit" variant="outline" disabled={busy || !email.trim()}>
            <Trans>Invite</Trans>
          </Button>
        </div>
        <ul className="space-y-1.5">
          {departments.map((department) => (
            <li key={department.id} className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <label
                htmlFor={`${ids}-${department.id}`}
                className="flex min-w-48 flex-1 items-center gap-2 text-[14px]"
              >
                <Checkbox
                  id={`${ids}-${department.id}`}
                  checked={department.id in chosen}
                  onCheckedChange={(checked) => toggle(department.id, checked === true)}
                />
                {department.name}
              </label>
              {department.id in chosen ? (
                <label
                  htmlFor={`${ids}-${department.id}-head`}
                  className="flex items-center gap-2 text-[14px] text-muted-foreground"
                >
                  <Checkbox
                    id={`${ids}-${department.id}-head`}
                    checked={chosen[department.id] === "head"}
                    onCheckedChange={(checked) =>
                      setChosen((current) => ({
                        ...current,
                        [department.id]: checked === true ? "head" : "member",
                      }))
                    }
                  />
                  <Trans>Head</Trans>
                </label>
              ) : null}
            </li>
          ))}
        </ul>
      </form>
      {link ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input readOnly value={link} aria-label={t`Sign-in link`} className="min-w-48 flex-1" />
          <Button
            type="button"
            variant="outline"
            onClick={() => void navigator.clipboard?.writeText(link).catch(() => undefined)}
          >
            <Trans>Copy</Trans>
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      <ul className="mt-5 space-y-1.5">
        {invitations.map((invitation) => (
          <li key={invitation.id} className="flex items-center justify-between gap-2 text-[14px]">
            <span className="min-w-0 truncate" dir="auto">
              {invitation.email}
            </span>
            {invitation.acceptedAt ? null : (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t`Revoke ${invitation.email}`}
                disabled={busy}
                onClick={() => void revoke(invitation.id)}
              >
                <XIcon />
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
