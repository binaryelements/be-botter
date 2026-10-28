import { Trans, useLingui } from "@lingui/react/macro";
import type { CompanySetup, McpServer, PersonaTemplate } from "@rakazo/contracts";
import type { ToolGroupId } from "@rakazo/core";
import { DEFAULT_OFF_GROUPS, disabledToolsFor, groupsOffFor, TOOL_GROUPS } from "@rakazo/core";
import {
  Button,
  Disclosure,
  Input,
  NativeSelect,
  NativeSelectOption,
  Switch,
  Textarea,
} from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { rpc } from "../lib/rpc";
import { SpaceRpcProvider, useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";
import { AdminKeyPage } from "./AdminKey";
import { CompanyModel } from "./model-settings/company-model";
import { useModelSettings } from "./model-settings/use-model-settings";

type Setup = Awaited<ReturnType<typeof rpc.setup.get>>;

function Step({
  title,
  locked = false,
  children,
}: {
  title: ReactNode;
  locked?: boolean;
  children?: ReactNode;
}) {
  return (
    <section className="space-y-3 border-t border-border pt-6">
      <h2 className="text-[15px] font-medium">{title}</h2>
      <fieldset disabled={locked} className="flex flex-wrap items-end gap-2 disabled:opacity-50">
        {children}
      </fieldset>
    </section>
  );
}

function ErrorAlert({ message }: { message: string }) {
  return (
    <p role="alert" className="text-[13px] text-destructive">
      {message}
    </p>
  );
}

function CompanyModelStep() {
  const model = useModelSettings(() => {});
  return <CompanyModel {...model} />;
}

function ToolSwitches({
  off,
  onChange,
  disabled = false,
}: {
  off: readonly ToolGroupId[];
  onChange: (off: ToolGroupId[]) => void;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const names: Record<ToolGroupId, string> = {
    web: t`Web`,
    computer: t`Computer and browser`,
    files: t`Files`,
    media: t`Media`,
    memory: t`Memory and notes`,
    work: t`Work items`,
    delegation: t`Delegation`,
    calls: t`Calls`,
  };
  return (
    <div className="w-full space-y-1">
      <h3 className="text-[13px] text-muted-foreground">
        <Trans>Tools</Trans>
      </h3>
      {TOOL_GROUPS.map((group) => (
        <div key={group.id} className="flex items-center justify-between gap-3 text-[14px]">
          <span aria-hidden>{names[group.id]}</span>
          <Switch
            aria-label={names[group.id]}
            disabled={disabled}
            checked={!off.includes(group.id)}
            onCheckedChange={(on) =>
              onChange(on ? off.filter((id) => id !== group.id) : [...off, group.id])
            }
          />
        </div>
      ))}
    </div>
  );
}

function ConnectionsList() {
  const spaceRpc = useSpaceRpc();
  const { t } = useLingui();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    spaceRpc.mcp.servers
      .list()
      .then((list) => setServers(list.filter((server) => server.shared)))
      .catch((err: unknown) => setError(errorText(err, t`Could not load`)));
  }, [spaceRpc]);
  if (error) return <ErrorAlert message={error} />;
  return (
    <ul className="w-full space-y-1 text-[14px]">
      {servers.map((server) => (
        <li key={server.id}>
          {server.name} <span className="text-muted-foreground">{server.health.status}</span>
        </li>
      ))}
    </ul>
  );
}

export function SetupWizardPage() {
  const { t } = useLingui();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [templates, setTemplates] = useState<PersonaTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [companyName, setCompanyName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [departmentName, setDepartmentName] = useState("");
  const [persona, setPersona] = useState("");
  const [offGroups, setOffGroups] = useState<ToolGroupId[]>([...DEFAULT_OFF_GROUPS]);
  const [ownerEmail, setOwnerEmail] = useState("");
  const [confirmName, setConfirmName] = useState("");

  function pick(template: PersonaTemplate | undefined) {
    setTemplateId(template?.id ?? "");
    setDepartmentName(template?.department ?? "");
    setPersona(template?.instructions ?? "");
    setOffGroups([...DEFAULT_OFF_GROUPS]);
  }

  useEffect(() => {
    let cancelled = false;
    rpc
      .me()
      .then(async (me) => {
        if (cancelled) return;
        // A keyless site's deployment owner keeps the wizard; on a keyed site that is the superadmin.
        const allowed = me.superadmin === true || me.isDeploymentOwner === true;
        setAllowed(allowed);
        if (!allowed) return;
        const [current, list] = await Promise.all([rpc.setup.get(), rpc.setup.templates()]);
        if (cancelled) return;
        setSetup(current);
        setCompanyName(current.companyName ?? "");
        setOwnerEmail(current.ownerEmail ?? "");
        setTemplates(list);
        pick(list[0]);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err, t`Could not load`));
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const merge = (next: CompanySetup) =>
    setSetup((current) => ({ departments: [], ...current, ...next }));
  const refresh = async () => setSetup(await rpc.setup.get());

  if (allowed === false) return <AdminKeyPage />;
  if (!setup) {
    return error ? (
      <main className="mx-auto max-w-2xl px-4 py-8">
        <ErrorAlert message={error} />
      </main>
    ) : null;
  }
  const locked = !setup.companySpaceId;
  const ready = setup.readyAt !== null;
  const email = setup.ownerEmail;
  const company = setup.companyName ?? "";

  return (
    <main className="h-dvh overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-6 px-4 py-8">
        <Link to="/app" className="text-[13px] text-muted-foreground hover:text-foreground">
          <Trans>Open the app</Trans>
        </Link>
        {error ? (
          <div className="sticky top-0 z-10 bg-background py-2">
            <ErrorAlert message={error} />
          </div>
        ) : null}

        <Step title={<Trans>Company</Trans>}>
          <Input
            aria-label={t`Company name`}
            className="min-w-48 flex-1"
            value={companyName}
            maxLength={120}
            disabled={busy || !!setup.companySpaceId}
            onChange={(event) => setCompanyName(event.target.value)}
          />
          <Button
            variant="outline"
            disabled={busy || !companyName.trim() || !!setup.companySpaceId}
            onClick={() =>
              run(async () => {
                merge(await rpc.setup.createCompany({ name: companyName.trim() }));
              })
            }
          >
            <Trans>Save</Trans>
          </Button>
        </Step>

        <SpaceRpcProvider spaceId={setup.companySpaceId}>
          <Step title={<Trans>Company model</Trans>} locked={locked}>
            {locked ? null : <CompanyModelStep />}
          </Step>

          <Step title={<Trans>Departments</Trans>} locked={locked}>
            <NativeSelect
              aria-label={t`Template`}
              className="w-full"
              value={templateId}
              onChange={(event) => pick(templates.find((entry) => entry.id === event.target.value))}
            >
              {templates.map((template) => (
                <NativeSelectOption key={template.id} value={template.id}>
                  {template.department}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Input
              aria-label={t`Department name`}
              className="min-w-48 flex-1"
              value={departmentName}
              maxLength={60}
              onChange={(event) => setDepartmentName(event.target.value)}
            />
            <Textarea
              aria-label={t`Persona`}
              className="w-full"
              value={persona}
              onChange={(event) => setPersona(event.target.value)}
            />
            <ToolSwitches off={offGroups} onChange={setOffGroups} />
            <Button
              variant="outline"
              disabled={busy || !departmentName.trim() || !persona.trim()}
              onClick={() =>
                run(async () => {
                  await rpc.setup.addDepartment({
                    name: departmentName.trim(),
                    instructions: persona.trim(),
                    templateId: templateId || undefined,
                    disabledTools: disabledToolsFor(offGroups),
                  });
                  await refresh();
                  pick(templates.find((entry) => entry.id === templateId));
                })
              }
            >
              <Trans>Add department</Trans>
            </Button>
            <ul className="w-full space-y-1 text-[14px]">
              {setup.departments.map((department) => (
                <li key={department.id} className="space-y-2">
                  <div>
                    {department.name}
                    {department.botName ? (
                      <span className="text-muted-foreground"> {department.botName}</span>
                    ) : null}
                  </div>
                  <ToolSwitches
                    off={groupsOffFor(department.disabledTools)}
                    disabled={busy}
                    onChange={(next) =>
                      run(async () => {
                        await rpc.setup.setDepartmentTools({
                          departmentId: department.id,
                          disabledTools: disabledToolsFor(next),
                        });
                        await refresh();
                      })
                    }
                  />
                </li>
              ))}
            </ul>
          </Step>

          <Step title={<Trans>Connections</Trans>} locked={locked}>
            {locked ? null : <ConnectionsList />}
          </Step>
        </SpaceRpcProvider>

        <Step title={<Trans>Owner</Trans>} locked={locked}>
          <Input
            type="email"
            aria-label={t`Owner email`}
            className="min-w-48 flex-1"
            value={ownerEmail}
            onChange={(event) => setOwnerEmail(event.target.value)}
          />
          <Button
            variant="outline"
            disabled={busy || !ownerEmail.trim()}
            onClick={() =>
              run(async () => {
                merge(await rpc.setup.update({ ownerEmail: ownerEmail.trim() }));
              })
            }
          >
            <Trans>Save</Trans>
          </Button>
        </Step>

        <Step title={<Trans>Ready</Trans>} locked={locked}>
          {ready ? (
            <p className="text-[14px]">
              <Trans>Ready for {email}</Trans>
            </p>
          ) : (
            <Button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  merge(await rpc.setup.markReady());
                })
              }
            >
              <Trans>Mark ready</Trans>
            </Button>
          )}
        </Step>

        <section className="border-t border-border pt-6">
          <Disclosure
            summary={
              <h2 className="text-[15px] font-medium">
                <Trans>Reset</Trans>
              </h2>
            }
          >
            <div className="flex flex-wrap items-end gap-2 pt-3">
              <Input
                aria-label={t`Type ${company} to confirm`}
                placeholder={t`Type ${company} to confirm`}
                className="min-w-48 flex-1"
                value={confirmName}
                disabled={locked}
                onChange={(event) => setConfirmName(event.target.value)}
              />
              <Button
                variant="destructive"
                disabled={busy || locked || confirmName !== company}
                onClick={() =>
                  run(async () => {
                    await rpc.setup.reset({ confirmName });
                    setConfirmName("");
                    await refresh();
                  })
                }
              >
                <Trans>Reset company</Trans>
              </Button>
            </div>
          </Disclosure>
        </section>
      </div>
    </main>
  );
}
