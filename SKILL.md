---
name: foragix
description: Use when a task needs to search the web, read a page's content, or diagnose why search or fetch is failing.
---

# foragix

Search and Fetch for agents, across multiple third-party providers, with a free-quota
pool and automatic failover.

The frontmatter above is the cross-runtime discovery convention; it is not a requirement
on any particular product. The body stands on its own: it describes a command-line
contract, and nothing here depends on a specific agent, protocol or vendor.

## When to use this

Use it when a task needs to:

- **find pages on the web** from a query → `search`
- **read the content of a known URL** → `fetch`
- **check why search/fetch is failing or unavailable** → `status`

Do not use it as a general-purpose shell or a web browser. It returns search hits and
extracted page text; it does not crawl a site, interact with a page, or keep state
between calls beyond quota bookkeeping.

A normal successful call returns results only. Quota information, which provider
answered, and any mid-call switching are deliberately omitted — you do not need them.
When nothing can serve the request you get a **structured refusal** instead (see below).

## Prerequisites

- **Node.js >= 22.5** (uses the built-in `node:sqlite`; no native dependencies)
- 安装形态是**可复制的技能目录**：完整源码与依赖随包自带，无需构建或安装
- Network egress to the provider APIs
- Credentials in the agent's own environment (its config-directory `.env`, or plain env variables)

## Running it

The skill is a directory that carries its own code and dependency. Put a copy wherever the
agent looks for skills and run its entry:

```bash
node <skill dir>/bin/foragix.mjs search --query "agent client protocol"
```

State is owned by this user (`~/.foragix/`). No build step and no package installation is
needed to run it; Node >= 22.5 plus the directory itself are the whole requirement.

## Commands

```
foragix search --query <text> [--max-results <n>]
foragix fetch  --url <url>
foragix status [--problems]
```

| Command  | Required  | Optional                    | Success payload |
|----------|-----------|-----------------------------|-----------------|
| `search` | `--query` | `--max-results` (1–100)     | `{ ok: true, data: [{ title, url, snippet? }] }` |
| `fetch`  | `--url`   | —                           | `{ ok: true, data: { url, title?, content } }` |
| `status` | —         | `--problems`                | `{ ok: true, providers: [ ... ], isolated: [ ... ] }` |

Global options:

| Option | Meaning |
|---|---|
| `--config <path>` | Config file. Default: `$FORAGIX_CONFIG`, then `~/.foragix/config.yaml`; absent means the built-in defaults |
| `--data-dir <path>` | Writable data directory. Default: `$FORAGIX_DATA_DIR`, then `~/.foragix` |
| `--credentials <path>` | Credential file; replaces the `.env` search entirely when given |
| `--input-json` | Read the request as a JSON object from stdin |
| `--help` | Print usage text (the only non-JSON stdout case) |
| `--version` | Print version as JSON |

`--help` and `--version` are mutually exclusive; giving both is a `usage_error` rather
than a silent choice. A repeated option takes its last value.

Explicit flags win over environment variables, which win over the documented defaults.

### Long or awkward queries

Queries may contain quotes, newlines, or be very long. Prefer passing stdin rather than
assembling a shell string:

```bash
printf '%s' \'{"command":"search","query":"line one\\nline \\"two\\""}\' \
  | foragix --input-json
```

`--input-json` refuses to read from an interactive terminal, so it cannot hang a session.

## Output and exit codes

- **stdout is exactly one JSON object.** Diagnostics go to **stderr** only.
- Read **both** the exit code and the JSON.

| Exit | Meaning | What to do |
|---|---|---|
| `0` | Success, or `status` succeeded | Use `data` / `providers` |
| `2` | Expected refusal, or a configuration/usage problem | Inspect `reason` or `code`; do not blind-retry |
| `1` | Internal or runtime error | Surface it; repeating the same call usually fails again |

If the process fails before Node starts (missing binary, wrong path), no JSON is produced.
That case is outside the contract above.

`status` returns `ok: true` and exit `0` whenever the status could be **read** — even when
every provider is unusable or a provider entry was isolated. Judge availability from
`providers[].usable` and `providers[].state`, never from `ok`.

## Config and credentials

Configuration is an **optional override layer** — the same model as `mmx-cli`:

```
~/.foragix/
├── foragix.db        # quota counters and availability state (runtime)
├── config.yaml       # optional overrides (absent = built-in defaults)
└── .env              # optional credential file
```

Every default lives in the code: both providers enabled, priority = registry order, and
paid usage refused until you opt in. A config file is only needed to change something, so
the first run needs no setup at all.

```yaml
version: 1
allow_paid: false        # a provider that may bill you stays unused until you accept

providers:
  - id: tavily           # enabled, credentials and priority all default
    priority: 10         # lower runs first
  - id: exa
    priority: 20
```

Every field except `id` has a default. Only credential *names* appear, never values.

`--config <path>` or `$FORAGIX_CONFIG` names an override file explicitly; a path named that
way must exist. State goes to `~/.foragix/foragix.db`; `--data-dir` moves it, and if the
directory cannot be written the command fails with `data_dir_unwritable` rather than
inventing a location.

**Credentials: the host is a variable, never a constant.** The default host is the
**current Linux user's environment** — plain `export` lines in your shell. No agent is
ever assumed to be the host. Optional layers, in increasing priority (the later wins,
matching `load_dotenv(override=True)`):

1. (default) the user's process environment;
2. a `.env` in the current working directory;
3. a host layer declared by the variable `FORAGIX_HOST_ENV=/path/to/.env`;
4. `--credentials <path>` — names one file explicitly and replaces sources 2–3.

The format is plain `NAME=value` with `#` comments and quoted values; an empty value counts
as absent. Values never enter the config, the database, or any log.

## Upgrading

State lives in `~/.foragix/foragix.db` and survives upgrades. If an update changes how a
provider is metered, the stored counters stop being comparable and `status` reports
`needs_migration: true` with that provider unusable. The counters are disposable
bookkeeping, so the fix is to delete the database once after such an upgrade:

```bash
rm -f ~/.foragix/foragix.db
```

## Error payloads

Two shapes, both on stdout. Exit code is `2` except for `internal_error`, which is `1`.

**CLI-level** failures carry a stable `code`:

```json
{"ok":false,"code":"config_missing","message":"config file not found: /home/u/my-config.yaml","hint":"omit --config to run on the built-in defaults, or point at an existing file"}
```

`code` is one of `usage_error`, `config_missing`, `config_invalid` (adds `issues: [{path, level, message}]`), `data_dir_unwritable`, `internal_error` (exit `1`).

**Engine-level** refusals describe every provider:

```json
{
  "ok": false,
  "reason": "no_provider_available",
  "retryable": false,
  "retry_after": null,
  "providers": [
    {
      "id": "tavily",
      "state": ["quota_exhausted_month"],
      "usable": false,
      "enabled": true,
      "period": "month",
      "resets_at": 1793491200000,
      "missing_env": null,
      "needs_migration": false,
      "action_for_llm": "monthly quota exhausted; recovers at the period boundary, retrying now is useless"
    }
  ],
  "isolated": []
}
```

| Field | Meaning |
|---|---|
| `reason` | `no_provider_available` · `all_transient` · `config_error` · `state_store_error` |
| `retryable` | Whether retrying can help at all |
| `retry_after` | Epoch milliseconds of the earliest useful retry, or `null` when none |
| `providers[].state` | Array of decoded reasons, e.g. `quota_exhausted_day`, `credential_missing`, `paid_not_allowed` |
| `providers[].resets_at` | Epoch milliseconds, or `null` when the recovery time genuinely is not known |
| `providers[].missing_env` | Array of credential variable **names** (never values), or `null` |
| `providers[].action_for_llm` | Written for you to act on or relay to the user |
| `isolated` | Providers excluded because their config entry was invalid |

An `internal_error` carries a generic `message` plus a closed-set `detail`. The raw
exception text is never put in the JSON: it can contain credentials or internal paths.
Set `FORAGIX_DEBUG=1` to get a redacted diagnostic on stderr while debugging.

`node:sqlite` is still experimental in Node 22, so Node prints an `ExperimentalWarning`
once. The command-line entry suppresses exactly that notice. Programs that import the
library instead of running the command will see it on stderr and may suppress it
themselves with `suppressSqliteExperimentalWarning`.

## Complete example

```bash
# 1. Nothing to configure: defaults are built in. Credentials come from the
#    agent's own environment (host .env or plain variables).
export TAVILY_API_KEY=...

# 2. Check what is usable (do this first when something is wrong)
foragix status --problems
# -> {"ok":true,"providers":[]}   means nothing is wrong

# 3. Search
foragix search --query "agent client protocol" --max-results 5
# -> {"ok":true,"data":[...]}

# 4. Read a page
foragix fetch --url https://example.com
# -> {"ok":true,"data":{"url":...,"content":...}}
```

Branch on the exit code, not on the text:

```bash
foragix search --query "..." > /tmp/out.json
case $? in
  0) jq -r '.data[] | "\(.title)  \(.url)"' /tmp/out.json ;;
  2) jq -r '.reason // .code, (.providers[]?.action_for_llm)' /tmp/out.json ;;
  *) echo "internal error" >&2 ;;
esac
```

## Behaviour worth knowing

- **Failover is automatic.** A provider whose quota ran out or whose endpoint failed is
  skipped; the next available one is used. Switching is transparent to the caller.
- **A provider's availability covers both capabilities.** If a provider offers both
  search and fetch, marking it unavailable affects both until it recovers.
- **Recovery is by event or by time, never by guessing.** Quota and credential problems
  recover at a period boundary or when the credential appears; network faults recover
  when a cooldown expires. A quota block whose reset period cannot be determined is
  reported with `resets_at: null` and does **not** recover on its own.
- **Concurrency.** Each invocation is its own process sharing the same SQLite database.
  Concurrent calls do not corrupt the state; heavy parallel use should still give each
  worker its own `--data-dir`.
- **State belongs to this user.** `~/.foragix/foragix.db` holds the quota bookkeeping.
  Deleting it resets the counters and affects nothing else.

## Known limitations

- **Local counting cannot close a race.** The check happens before the request and the
  counter is written after it, so two processes can both pass the check and overspend.
  The counters are a protective layer; the provider's own refusal (429 / 402) is the
  authority, and foragix stops there and records it.
- **Counters follow the user home.** Another `HOME` (or an explicit `--data-dir`) starts
  from its own counters, so it rediscovers an exhausted provider by being refused once.

## Common mistakes

| Mistake | Consequence | Do instead |
|---|---|---|
| Parsing stderr as the result | Warnings and diagnostics live there | Parse stdout only |
| Treating exit `0` as the only success signal without reading JSON | A refusal is also informative | Read both |
| Reading `status`'s `ok: true` as "a provider is available" | It only means the status was read | Check `providers[].usable` |
| Retrying a `retryable: false` refusal immediately | Same refusal, wasted calls | Wait for `retry_after`, or act on `action_for_llm` |
| Inventing a recovery time when `resets_at` is `null` | Promises a recovery that may not happen | Say the reset period is unknown |
| Putting credential values in the config file | Config is not private storage | Use environment variables or `--credentials` |
| One data dir shared by many parallel workers | Serialised writes, unnecessary contention | Give each worker its own `--data-dir` |
| Assuming one request costs one quota unit | Some providers bill per page or in currency | Rely on the provider's own refusal; do not pre-compute |
