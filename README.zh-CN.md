# foragix

foragix 是给 AI agent 用的网页搜索与正文抓取工具：把 19 家供应商的免费额度攒成一个池子，谁还有免费额度就先用谁，用完自动换下一家。

[English](README.md) | 简体中文

## 快速开始

```bash
npx skills add ikelvingo/foragix -g
export TAVILY_API_KEY=<你的key>
```
装好后 agent 按 `SKILL.md` 直接用；`status` 可随时查看装没装好、缺不缺 key。

## 给 key 的方式（优先级从高到低）

1. `--credentials <文件路径>`：指定的 key 文件（任意文件路径都支持；`FORAGIX_CREDENTIALS=<文件路径>` 环境变量与之等价），顶替下面所有方式。
2. `FORAGIX_HOST_ENV=<文件路径>`：声明一个 key 文件（任意文件路径）。
3. 系统环境变量：`export TAVILY_API_KEY=<你的key>`。

无论哪种方式：key 只写值给环境或文件，配置文件里永远只写变量名、不写值。

## 配置参考

配置文件放在 `~/.foragix/config.yaml`（可选：不写就用内置默认，写了的值覆盖默认）。key 从上面「给 key 的方式」里来，配置文件里永远只写变量名、不写值。

```yaml
version: 1                     # 只接受 1
providers:
  - id: tavily                 # 必需，19 个 id 之一
    enabled: true              # 默认 true
    priority: 30               # 覆盖成 30；不写 = 列表位置 ×10，数值小者先试
    credentials:               # 整段不写 = 用该家自己声明的变量名
      - name: TAVILY_API_KEY   # 只写环境变量名，永不写值
        required: true         # 缺变量时不使用该家
    account: {}                # 只有 6 家有专属键（8 个 id），其余 11 个 id 留空
  - id: minimax
    enabled: true              # 默认关闭，这里显式打开
    account:
      base_url: https://api.minimax.io
```

| 服务 | 键 | 取值 | 默认 |
| --- | --- | --- | --- |
| `searxng` | `base_url` | 实例地址 | `https://search.ikelvin.space:8443` |
| `minimax` / `minimax_cn` | `base_url` | `https://api.minimax.io` / `https://api.minimax.cn` | 按 id |
| `zhipu` / `zhipu_cn` | `base_url` | `https://api.z.ai/api/paas/v4` / `https://open.bigmodel.cn/api/paas/v4` | 按 id |
| `zhihu` | `db` | `zhihu` / `global` | `zhihu` |
| `doubao` | `version` | `global` / `custom` | `global` |
| `brave` | `capped_free` | `true` / `false` | `true`（免费额度建立在绑卡上；`false` 拆掉本地预算闸） |

- 重复 `id` 或顶层未知键：启动直接拒绝。
- 某一家内部写错（未知键、凭据名不符、取值越界）：只隔离该家，其余照常。
- 没列出的服务自动带默认值进池；默认关闭的五家是 `minimax`、`minimax_cn`、`zhipu`、`zhipu_cn`、`deepseek`。
- 想用别的配置文件：`--config <路径>`（或环境变量 `FORAGIX_CONFIG`）；指定文件必须真实存在，否则启动失败。

## 记数在哪

搜索记数保存在本机 `~/.foragix/` 里，升级、重装都不会丢；`config.yaml` 也放这里。删掉这个文件夹就是从零开始，换台电脑就是另一份记数。

## 服务清单

| id | 凭据变量 | 默认 |
| --- | --- | --- |
| `searxng` | 无 | true |
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

## 已知限制
- 本地记的用量只是估算，服务商自己的拒绝才算数。
- 记数跟人走：换一台电脑或换一个用户目录，就是另一份独立的记数。
- 只做搜索与正文抓取，不爬站、不操页面。
