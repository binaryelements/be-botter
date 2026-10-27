import { Trans, useLingui } from "@lingui/react/macro";
import type { Department, DepartmentRole } from "@rakazo/contracts";
import { BOT_INSTRUCTIONS_MAX_LENGTH } from "@rakazo/contracts";
import {
  Button,
  Disclosure,
  Input,
  NativeSelect,
  NativeSelectOption,
  Textarea,
} from "@rakazo/ui-web";
import { XIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";

type UserInput = { email: string; role: DepartmentRole };
type BotOption = { id: string; name: string };

function toUsersInput(users: Department["users"]): UserInput[] {
  return users.map((user) => ({ email: user.email, role: user.role }));
}

/** Departments of the space these settings act on: who and which bots are in each. */
export function DepartmentsSettings() {
  const rpc = useSpaceRpc();
  const { t } = useLingui();
  const ids = useId();
  const [departments, setDepartments] = useState<Department[] | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [bots, setBots] = useState<BotOption[]>([]);
  const [template, setTemplate] = useState("");
  const [savedTemplate, setSavedTemplate] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      rpc.departments.list(),
      rpc.me(),
      rpc.bots.list().catch(() => []),
      rpc.departments.template().catch(() => ({ instructions: "" })),
    ])
      .then(([list, me, botList, persona]) => {
        if (cancelled) return;
        setDepartments(list);
        setIsOwner(me.isSpaceOwner === true);
        setBots(botList.map((bot) => ({ id: bot.id, name: bot.name })));
        setTemplate(persona.instructions);
        setSavedTemplate(persona.instructions);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err, t`Could not load departments`));
      });
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  function replace(updated: Department) {
    setDepartments((current) =>
      (current ?? []).map((department) => (department.id === updated.id ? updated : department)),
    );
  }

  async function addDepartment() {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await rpc.departments.create({ name });
      setDepartments((current) => [...(current ?? []), created]);
      setNewName("");
      // The department comes with its own bot; fetch the roster so it shows by name.
      const botList = await rpc.bots.list().catch(() => null);
      if (botList) setBots(botList.map((bot) => ({ id: bot.id, name: bot.name })));
    } catch (err) {
      setError(errorText(err, t`Could not save`));
    } finally {
      setBusy(false);
    }
  }

  async function removeDepartment(departmentId: string) {
    setBusy(true);
    setError(null);
    try {
      await rpc.departments.remove({ departmentId });
      setDepartments((current) =>
        (current ?? []).filter((department) => department.id !== departmentId),
      );
    } catch (err) {
      setError(errorText(err, t`Could not save`));
    } finally {
      setBusy(false);
    }
  }

  async function saveTemplate() {
    const instructions = template.trim();
    if (!instructions || instructions === savedTemplate || busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await rpc.departments.setTemplate({ instructions });
      setTemplate(saved.instructions);
      setSavedTemplate(saved.instructions);
    } catch (err) {
      setError(errorText(err, t`Could not save`));
    } finally {
      setBusy(false);
    }
  }

  async function saveUsers(department: Department, users: UserInput[]): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      replace(await rpc.departments.setUsers({ departmentId: department.id, users }));
      return true;
    } catch (err) {
      setError(errorText(err, t`Could not save`));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function setBotInDepartment(botId: string, departmentId: string, on: boolean) {
    const current = (departments ?? [])
      .filter((department) => department.botIds.includes(botId) && department.id !== departmentId)
      .map((department) => department.id);
    setBusy(true);
    setError(null);
    try {
      const saved = await rpc.bots.setDepartments({
        botId,
        departmentIds: on ? [...current, departmentId] : current,
      });
      setDepartments((list) =>
        (list ?? []).map((department) => {
          const others = department.botIds.filter((id) => id !== botId);
          return {
            ...department,
            botIds: saved.departmentIds.includes(department.id) ? [...others, botId] : others,
          };
        }),
      );
    } catch (err) {
      setError(errorText(err, t`Could not save`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="departments-settings" className="pt-5">
      {isOwner ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void addDepartment();
          }}
        >
          <label
            htmlFor={`${ids}-name`}
            className="min-w-48 flex-1 text-[14px] text-muted-foreground"
          >
            <Trans>New department</Trans>
            <Input
              id={`${ids}-name`}
              name="department-name"
              value={newName}
              maxLength={60}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setNewName(event.target.value)}
              className="mt-1.5"
            />
          </label>
          <Button type="submit" variant="outline" disabled={busy || !newName.trim()}>
            <Trans>Add department</Trans>
          </Button>
        </form>
      ) : null}
      {isOwner && savedTemplate ? (
        <Disclosure
          className="mt-4"
          summary={<Trans>Department bot persona</Trans>}
          summaryClassName="text-[14px] text-muted-foreground"
        >
          <Textarea
            aria-label={t`Department bot persona`}
            value={template}
            maxLength={BOT_INSTRUCTIONS_MAX_LENGTH}
            disabled={busy}
            onChange={(event) => setTemplate(event.target.value)}
            onBlur={() => void saveTemplate()}
            className="mt-2"
          />
        </Disclosure>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      {departments === null ? null : (
        <ul className={isOwner ? "mt-5 space-y-4" : "space-y-4"}>
          {departments.map((department) => (
            <DepartmentCard
              key={department.id}
              department={department}
              isOwner={isOwner}
              busy={busy}
              onRemove={() => removeDepartment(department.id)}
              onSaveUsers={(users) => saveUsers(department, users)}
              bots={bots}
              onSetBot={(botId, on) => setBotInDepartment(botId, department.id, on)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function DepartmentCard({
  department,
  isOwner,
  busy,
  onRemove,
  onSaveUsers,
  bots,
  onSetBot,
}: {
  department: Department;
  isOwner: boolean;
  busy: boolean;
  onRemove: () => Promise<void>;
  onSaveUsers: (users: UserInput[]) => Promise<boolean>;
  bots: BotOption[];
  onSetBot: (botId: string, on: boolean) => Promise<void>;
}) {
  const { t } = useLingui();
  const ids = useId();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<DepartmentRole>("member");
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [botId, setBotId] = useState("");
  const canManage = department.canManageUsers;
  const departmentBots = bots.filter((bot) => department.botIds.includes(bot.id));
  const otherBots = bots.filter((bot) => !department.botIds.includes(bot.id));

  async function addPerson() {
    const trimmed = email.trim();
    if (!trimmed || busy) return;
    const saved = await onSaveUsers([...toUsersInput(department.users), { email: trimmed, role }]);
    if (saved) {
      setEmail("");
      setRole("member");
    }
  }

  function changeRole(userId: string, nextRole: DepartmentRole) {
    void onSaveUsers(
      department.users.map((user) => ({
        email: user.email,
        role: user.userId === userId ? nextRole : user.role,
      })),
    );
  }

  function removePerson(userId: string) {
    void onSaveUsers(toUsersInput(department.users.filter((user) => user.userId !== userId)));
  }

  return (
    <li
      data-testid={`department-${department.id}`}
      className="rounded-lg border border-border px-3.5 py-3"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[14px] font-medium text-foreground">{department.name}</h3>
        {isOwner && !confirmingRemove ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={busy}
            onClick={() => setConfirmingRemove(true)}
          >
            <Trans>Remove</Trans>
          </Button>
        ) : null}
      </div>
      {confirmingRemove ? (
        <div className="mt-2">
          <p className="text-[13px] text-foreground">
            <Trans>Remove {department.name}? Its people lose access to its bots.</Trans>
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="text-destructive hover:text-destructive"
              data-testid={`department-remove-confirm-${department.id}`}
              disabled={busy}
              onClick={() => void onRemove()}
            >
              <Trans>Remove</Trans>
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmingRemove(false)}>
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </div>
      ) : null}
      {department.users.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {department.users.map((user) => (
            <li key={user.userId} className="flex items-center justify-between gap-3 text-[13.5px]">
              <span className="min-w-0 truncate text-foreground/75">
                {user.name}
                <span className="ms-2 text-muted-foreground">{user.email}</span>
              </span>
              {canManage ? (
                <span className="flex shrink-0 items-center gap-1">
                  <NativeSelect
                    aria-label={t`Role of ${user.name}`}
                    data-testid={`department-role-${user.userId}`}
                    value={user.role}
                    disabled={busy}
                    onChange={(event) =>
                      changeRole(user.userId, event.target.value as DepartmentRole)
                    }
                  >
                    <NativeSelectOption value="member">{t`Member`}</NativeSelectOption>
                    <NativeSelectOption value="head">{t`Head`}</NativeSelectOption>
                  </NativeSelect>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t`Remove ${user.name}`}
                    data-testid={`department-remove-${user.userId}`}
                    disabled={busy}
                    onClick={() => removePerson(user.userId)}
                  >
                    <XIcon />
                  </Button>
                </span>
              ) : (
                <span className="shrink-0 text-muted-foreground">
                  {user.role === "head" ? t`Head` : t`Member`}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {canManage ? (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void addPerson();
          }}
        >
          <label
            htmlFor={`${ids}-email`}
            className="min-w-48 flex-1 text-[14px] text-muted-foreground"
          >
            <Trans>Email</Trans>
            <Input
              id={`${ids}-email`}
              type="email"
              value={email}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
              className="mt-1.5"
            />
          </label>
          <NativeSelect
            aria-label={t`Role`}
            value={role}
            disabled={busy}
            onChange={(event) => setRole(event.target.value as DepartmentRole)}
          >
            <NativeSelectOption value="member">{t`Member`}</NativeSelectOption>
            <NativeSelectOption value="head">{t`Head`}</NativeSelectOption>
          </NativeSelect>
          <Button type="submit" variant="outline" disabled={busy || !email.trim()}>
            <Trans>Add person</Trans>
          </Button>
        </form>
      ) : null}
      {isOwner ? (
        <>
          {departmentBots.length > 0 ? (
            <ul className="mt-3 space-y-1.5">
              {departmentBots.map((bot) => (
                <li key={bot.id} className="flex items-center justify-between gap-3 text-[13.5px]">
                  <span className="min-w-0 truncate text-foreground/75">{bot.name}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t`Remove ${bot.name}`}
                    disabled={busy}
                    onClick={() => void onSetBot(bot.id, false)}
                  >
                    <XIcon />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {otherBots.length > 0 ? (
            <form
              className="mt-3 flex items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!botId) return;
                void onSetBot(botId, true).then(() => setBotId(""));
              }}
            >
              <NativeSelect
                aria-label={t`Bots`}
                className="flex-1"
                value={botId}
                disabled={busy}
                onChange={(event) => setBotId(event.target.value)}
              >
                <NativeSelectOption value="">{t`Select a bot`}</NativeSelectOption>
                {otherBots.map((bot) => (
                  <NativeSelectOption key={bot.id} value={bot.id}>
                    {bot.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <Button type="submit" variant="outline" disabled={busy || !botId}>
                <Trans>Add</Trans>
              </Button>
            </form>
          ) : null}
        </>
      ) : null}
    </li>
  );
}
