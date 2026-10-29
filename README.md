# foragix

An Agent Skill that provides **Search** and **Fetch** over multiple third-party
providers, backed by a **free-quota pool** with automatic failover.

The caller is an LLM, not a human. When one provider's quota runs out or its
endpoint fails, foragix transparently switches to the next one. The LLM only
sees a structured refusal when *nothing* works — and that refusal says what
happened, whether retrying would help, and what to do now.

## Requirements

- Node.js **>= 22.5** (`node:sqlite` is built in — no native dependencies)
- API keys in the current Linux user's environment (`export`); never in the config file

## Install

None. This is a skill: a directory that already contains everything it needs.

```bash
cp -r foragix ~/.agents/skills/          # or wherever your agent looks for skills
node ~/.agents/skills/foragix/bin/foragix.mjs status
```

`src/` and `test/` are for development only and are not needed to run it.

State is owned by this user (`~/.foragix/`)
without losing quota counters.## Configure

Configuration is an optional override layer — the same model as `mmx-cli`:

```
~/.foragix/
├── foragix.db        # quota counters and availability state (runtime)
├── config.yaml       # optional overrides (absent = built-in defaults)
└── .env              # optional credential file
```

Every default lives in the code — both providers enabled, priority = registry order,
paid usage refused until you opt in — so the first run needs no setup at all.

```yaml
version: 1
allow_paid: false        # a provider that may bill you stays unused until you accept

providers:
  - id: tavily           # enabled, credentials and priority all default
    priority: 10         # lower runs first
  - id: exa
    priority: 20
```

Every field except `id` has a default. The file carries **no quota numbers** — each
adapter declares its own preset — and only **credential names**, never values.

`--config <path>` or `$FORAGIX_CONFIG` names an override file explicitly; a path named
that way must exist. State goes to `~/.foragix/foragix.db`; `--data-dir` moves it, and
if it cannot be written the command fails with `data_dir_unwritable` rather than
inventing a location.

**Credentials: the host is a variable, never a constant.** The default host is the current
Linux user's environment — plain `export` lines in your shell. A `.env` in the working
directory beats the environment; `FORAGIX_HOST_ENV=/path/to/.env` is the variable form of a
declared host layer and wins over both; `--credentials <path>` replaces them. No agent is
ever assumed to be the host, and nothing outside the user environment is probed. Values
never enter the config, the database, or any log.

Providers that may cost money stay **disabled** until paid usage is explicitly accepted
(`allow_paid: true`, globally or per provider).

## Known limitations

- Local quota counting cannot close the race between "provider looks available" and "request
  is made"; the provider's own refusal is the authority.
- Counters follow the user home: another `HOME` (or an explicit `--data-dir`) starts from
  its own state.

## Upgrading

State lives in `~/.foragix/foragix.db` and survives upgrades. If an update changes how a
provider is metered, the stored counters stop being comparable and `status` reports
`needs_migration: true` with the provider unusable. The counters are disposable, so delete
the database once after such an upgrade: `rm -f ~/.foragix/foragix.db`.

## Use

The product surface is a command. Any agent that can run a script can use it — no
protocol, no SDK, no vendor-specific format.

```bash
foragix search --query "agent client protocol" --max-results 5
foragix fetch  --url https://example.com
foragix status --problems
```

stdout is exactly one JSON object; diagnostics go to stderr. Exit codes: `0` success,
`2` expected refusal or configuration problem, `1` internal error.

See `SKILL.md` for the full contract: config discovery order, credential handling, the
structured-refusal shape, and a worked example.

Agents that can load code instead can use the library:

```ts
import { createForagix } from 'foragix';

const foragix = createForagix({
  configPath: '/path/to/config.yaml',
  dataDir: '/path/to/data/dir',
  credentialFilePath: '/path/to/.env',
});

const search = await foragix.search({ query: 'agent client protocol' });
if (search.ok) {
  console.log(search.provider, search.data);
} else {
  console.error(search.reason, search.retry_after);
}
```

A normal response carries **no quota information** — the caller does not need to know
which provider answered or how much quota is left.

## How it works

```
config ──▶ validation ──▶ credentials ──▶ state (SQLite)
                                             │
                                             ▼
                      ┌──────────────▶ routing (pure function)
                      │                    │
                      │                    ▼
                      │              provider adapter ──▶ HTTP
                      │                    │
                      └──── state update ◀┘
```

- **Decision is a single table lookup.** A provider is usable when
  `is_enable = 1` and `is_available = 0`. Nothing is computed, predicted or
  ranked.
- **Many reasons can coexist.** Unavailable state is a bitmask, so "monthly
  quota exhausted" and "credential missing" are tracked independently; clearing
  one does not make the provider usable.
- **Persistent vs transient causes.** Quota, credential and payment-gate
  reasons recover on an *event* (period boundary, credential appearing,
  fingerprint change); network and short-window rate-limit reasons recover on
  *time* (`retry_after` expiry).
- **Only determinable causes may set a bit.** A transient network fault sets a
  cooldown, never a permanent disable — otherwise a provider would be locked
  out forever with no way to recover.
- **Routing is a pure function.** No randomness, no time, no process identity.
  Candidates are ordered by `priority` ascending, then by provider id
  ascending, so ties resolve deterministically.
- **State changes are short transactions.** Network calls never happen while a
  write transaction is open.
- **Fail closed.** If the state store cannot be read or written, no provider is
  called and the failure is reported as `state_store_error`.

## Storage

The SQLite database lives in the **user home** (`~/.foragix/`), not inside the
npm package — the package cache is disposable, the counters are not. On first
load the runtime applies the authoritative DDL from `sql/schema.sql`
directly; every table is `CREATE TABLE IF NOT EXISTS`, so there is no seed
artifact and no build step around it.

Load-time validation runs three independent checks — schema version, per-column
structure probe, and a DDL fingerprint — because each one alone can let a
mismatched database through. There is deliberately **no automatic migration**:
a semantic change that silently rewrites quota bookkeeping would be worse than
a loud failure.

## Layout

```
bin/foragix.mjs    # executable entry (thin shim over the compiled CLI)
SKILL.md           # vendor-neutral invocation contract for agents

src/
├── cli.ts         # argument parsing, config discovery, JSON output, exit codes
├── config/        # config loading, validation, spelling suggestions
├── credentials/   # credential resolution and fingerprints (hashes only)
├── db/            # SQLite adapter, bitmask, period keys, schema checks
├── errors/        # HTTP classification and redaction
├── providers/     # adapter contract + Tavily / Exa implementations
├── routing/       # pure-function candidate selection
├── runtime/       # runtime database bootstrap
├── state/         # state machine: resets, gates, cooldowns
└── engine.ts      # orchestration

sql/schema.sql     # authoritative DDL
test/              # unit, CLI and cross-process tests
```

## Development

Everything below is for working on the skill itself; running it needs none of this.

```bash
npm run check       # type-check only
npm run build       # compile to dist/
npm test            # build, then run the test suite
npm pack            # produce the publishable tarball (bin/dist/sql/SKILL.md)
```

## Current providers

| Provider | Capabilities | Notes |
|---|---|---|
| `tavily` | search, fetch | Free 1,000 credits/month, no bank card |
| `exa` | search, fetch | USD-balance quota; may incur cost, requires explicit `allow_paid` |

Additional providers are not implemented yet — `src/providers/registry.ts`
lists each one with the reason, so the gap is explicit rather than silent.

## Design documents

The design documents (PRD, configuration format, runtime model) are **not part
of this repository**. Source comments reference them by section number; the
documents themselves are maintained separately.
