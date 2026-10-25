import { Trans } from "@lingui/react/macro";
import type { SecurityEvent, SecurityEventType } from "@rakazo/contracts";
import { SECURITY_EVENT_TYPES } from "@rakazo/contracts";
import { Button, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { i18n } from "../lib/i18n";
import { rpc } from "../lib/rpc";

const PAGE = 50;

/** The deployment's security events, newest first; the API serves them to its owner only. */
export function AuditLog({ isDeploymentOwner }: { isDeploymentOwner: boolean }) {
  const titleId = useId();
  const [type, setType] = useState<SecurityEventType | "">("");
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [pending, setPending] = useState(false);
  const requestRef = useRef(0);

  async function load(cursor?: string) {
    const request = ++requestRef.current;
    setPending(true);
    try {
      const page = await rpc.security.events({
        ...(type ? { type } : {}),
        ...(cursor ? { cursor } : {}),
        limit: PAGE,
      });
      if (request !== requestRef.current) return;
      setEvents((current) => (cursor ? [...current, ...page] : page));
      setHasMore(page.length === PAGE);
    } catch {
      if (request === requestRef.current) setHasMore(false);
    } finally {
      if (request === requestRef.current) setPending(false);
    }
  }

  useEffect(() => {
    if (isDeploymentOwner) void load();
    return () => {
      requestRef.current++;
    };
  }, [isDeploymentOwner, type]);

  if (!isDeploymentOwner) return null;
  return (
    <section className="rounded-xl border border-border px-4 py-4" data-testid="audit-log">
      <div className="flex items-center justify-between gap-3">
        <h3 id={titleId} className="text-[15px] font-medium text-foreground">
          <Trans>Audit</Trans>
        </h3>
        <NativeSelect
          aria-labelledby={titleId}
          data-testid="audit-log-type"
          size="sm"
          className="font-mono"
          value={type}
          onChange={(event) => setType(event.target.value as SecurityEventType | "")}
        >
          <NativeSelectOption value="">
            <Trans>All</Trans>
          </NativeSelectOption>
          {SECURITY_EVENT_TYPES.map((value) => (
            <NativeSelectOption key={value} value={value}>
              {value}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <ul className="mt-3 space-y-1 font-mono text-[12.5px]">
        {events.map((event) => (
          <li
            key={event.id}
            data-testid="audit-log-row"
            className="flex flex-wrap justify-between gap-x-3 text-foreground/75"
          >
            <span>{event.type}</span>
            <span className="text-muted-foreground">
              {new Date(event.createdAt).toLocaleString(i18n.locale || "en", {
                dateStyle: "short",
                timeStyle: "short",
              })}
            </span>
            <span className="w-full truncate text-muted-foreground">{event.userId}</span>
          </li>
        ))}
      </ul>
      {hasMore ? (
        <Button
          variant="secondary"
          size="sm"
          className="mt-3 rounded-full"
          data-testid="audit-log-more"
          disabled={pending}
          onClick={() => void load(events.at(-1)?.id)}
        >
          <Trans>Load more</Trans>
        </Button>
      ) : null}
    </section>
  );
}
