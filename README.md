# foragix

foragix is a web-search and page-fetch tool for AI agents: it pools the free quotas of 19 providers — whoever still has free quota goes first, and spent ones fail over automatically.

**[简体中文 · 中文说明](README.zh-CN.md)**

## Quick start

```bash
npx skills add ikelvingo/foragix -g
export TAVILY_API_KEY=<your key>
```
Once installed, the agent uses it through `SKILL.md`; run `status` any time to check the install and missing keys.

## Ways to hand over a key (highest priority first)

1. `--credentials <file path>`: use this key file (any file path works; the environment variable `FORAGIX_CREDENTIALS=<file path>` is equivalent); it replaces every way below.
2. `FORAGIX_HOST_ENV=<file path>`: declare a key file (any file path).
3. System environment variables: `export TAVILY_API_KEY=<your key>`.

Whichever way: the key value goes only to the environment or that file — the config file always names the variable and never holds the value.

## Configuration reference

The config file lives at `~/.foragix/config.yaml` (optional: omit it to use the built-in defaults; anything you write overrides them). Keys come from the ways above; the config file always names the variable and never holds the value.

```yaml
version: 1                     # only 1 is accepted
providers:
  - id: tavily                 # required; one of the 19 ids
    enabled: true              # default: true
    priority: 30               # overriding to 30; omit = list position ×10, lower runs first
    credentials:               # omit the whole block = each provider's own declared names
      - name: TAVILY_API_KEY   # the environment variable NAME, never the value
        required: true         # without the variable the provider is not used
    account: {}                # only 6 providers have dedicated keys (8 ids), the other 11 stay empty
  - id: minimax
    enabled: true              # default-off; turned on explicitly here
    account:
      base_url: https://api.minimax.io
```

| provider | key | allowed values | default |
| --- | --- | --- | --- |
| `searxng` | `base_url` | instance URL | `https://search.ikelvin.space:8443` |
| `minimax` / `minimax_cn` | `base_url` | `https://api.minimax.io` / `https://api.minimax.cn` | by id |
| `zhipu` / `zhipu_cn` | `base_url` | `https://api.z.ai/api/paas/v4` / `https://open.bigmodel.cn/api/paas/v4` | by id |
| `zhihu` | `db` | `zhihu` / `global` | `zhihu` |
| `doubao` | `version` | `global` / `custom` | `global` |
| `brave` | `capped_free` | `true` / `false` | `true` (the free tier rides on a saved card; `false` removes the local budget brake) |

- A duplicate `id` or unknown top-level keys: startup is refused.
- A wrong entry inside one provider (unknown key, unknown credential name, bad value): only that provider is isolated; the rest keep working.
- Providers not listed join the pool with their defaults; the five default-off ones are `minimax`, `minimax_cn`, `zhipu`, `zhipu_cn`, `deepseek`.
- To use another config file: `--config <path>` (or the env var `FORAGIX_CONFIG`); the file must exist, otherwise startup fails.

## Where the counters live

Search counters are kept on this machine in `~/.foragix/`; upgrades and reinstalls keep them; `config.yaml` also lives there. Deleting the folder starts from zero, and another computer keeps another set of counters.

## Provider list

| id | credential variable | default |
| --- | --- | --- |
| `searxng` | none | true |
| `minimax` | `MINIMAX_GLOBAL_API_KEY` | false |
| `minimax_cn` | `MINIMAX_API_KEY` | false |
| `tinyfish` | `TINYFISH_API_KEY` | true |
| `you` | `YDC_API_KEY` | true |
| `zhihu` | `ZHIHU_API_KEY` | true |
| `anysearch` | `ANYSEARCH_API_KEY` | true |
| `ollama` | `OLLAMA_API_KEY` | true |
| `linkup` | `LINKUP_API_KEY` | true |
| `exa` | `EXA_API_KEY` | true |
| `metaso` | `METASO_API_KEY` | true |
| `firecrawl` | `FIRECRAWL_API_KEY` | true |
| `tavily` | `TAVILY_API_KEY` | true |
| `brave` | `BRAVE_API_KEY` | true |
| `doubao` | `DOUBAO_SEARCH_API_KEY` | true |
| `baidu` | `BAIDU_API_KEY` | true |
| `deepseek` | `DEEPSEEK_API_KEY` | false |
| `zhipu_cn` | `ZHIPU_API_KEY` | false |
| `zhipu` | `ZAI_API_KEY` | false |

## Known limitations
- Locally counted usage is an estimate; the provider's own refusal is the authority.
- Counters follow the machine: another computer or user directory keeps its own separate set.
- Search and page fetching only; no crawling, no page interaction.
