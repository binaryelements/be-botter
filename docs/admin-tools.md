# Admin tools

An admin can set up the company by talking to any bot: departments, their people and bots, the
department bot persona, which departments a company connection reaches, and the admin-only switch.
The same bot can also report usage and read the audit trail.

## Who gets them

The tools are offered only while the person talking to the bot is an admin: an owner of the space,
or the deployment owner. Everyone else never sees them. Like the bot management tools, they are only
offered on runs you started (a message you sent, a follow-up to it, or the end of a call), never to
subagents, and each call checks the role again. A bot can still turn them off with **Disabled tools**.

A run that has received a message from a messaging channel or a webhook cannot make admin changes
for the rest of that run.

## Tools

- `admin_info` reads, without approval:
  - `overview`: departments with their people and bots, the bots, company connections and the
    departments they reach, the persona template, and the admin-only switch.
  - `usage`: runs, model calls, tokens and cost per person and per bot over the last `days`
    (default 30).
  - `audit`: the space's audit trail, newest first, with who made each change and whether it came
    through a bot.
- `admin_change` changes the setup. Every call shows an approval card first. Actions:
  `create_department` (also creates its bot from the persona template), `rename_department`,
  `remove_department`, `set_person` (role `member`, `head` or `none` to remove), `set_department_bot`,
  `set_persona_template`, `set_bot_persona`, `set_connection_departments` (an empty list shares the
  connection with everyone) and `set_admin_only` (deployment owner only).

Adding a connection and its credentials stays in Settings, so credentials are never typed into a
chat.

## Audit trail

Every admin change is recorded, whether made in Settings or through a bot. A change made through a
bot carries `via: bot` with the bot and run that made it. The record holds identifiers and kinds,
never persona text or other content.
