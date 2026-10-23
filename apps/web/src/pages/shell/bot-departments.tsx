import { Trans, useLingui } from "@lingui/react/macro";
import type { Department } from "@rakazo/contracts";
import { Switch } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

/** Which departments may use this bot; space owners only. Hidden until a department exists. */
export function BotDepartmentsSection({ botId }: { botId: string }) {
  const { t } = useLingui();
  const ids = useId();
  const [departments, setDepartments] = useState<Department[]>([]);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpc.departments
      .list()
      .then((list) => {
        if (cancelled) return;
        setDepartments(list);
        setMemberIds(
          list
            .filter((department) => department.botIds.includes(botId))
            .map((department) => department.id),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [botId]);

  if (departments.length === 0) return null;

  async function toggle(departmentId: string, on: boolean) {
    const previous = memberIds;
    const next = on
      ? [...previous.filter((id) => id !== departmentId), departmentId]
      : previous.filter((id) => id !== departmentId);
    setMemberIds(next);
    setError(null);
    try {
      const saved = await rpc.bots.setDepartments({ botId, departmentIds: next });
      setMemberIds(saved.departmentIds);
    } catch (err) {
      setMemberIds(previous);
      setError(errorText(err, t`Could not save`));
    }
  }

  return (
    <div className="mt-5" data-testid="bot-departments">
      <p className="text-[14px] text-muted-foreground">
        <Trans>Departments</Trans>
      </p>
      {departments.map((department) => (
        <label
          key={department.id}
          htmlFor={`${ids}-${department.id}`}
          className="mt-2 flex items-center justify-between gap-3 text-[14px] text-muted-foreground"
        >
          <span>{department.name}</span>
          <Switch
            id={`${ids}-${department.id}`}
            checked={memberIds.includes(department.id)}
            onCheckedChange={(checked) => void toggle(department.id, checked)}
          />
        </label>
      ))}
      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
