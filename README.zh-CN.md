# foragix

foragix 是给 AI agent 用的网页搜索与正文抓取工具：把 20 家供应商的免费额度攒成一个池子，谁还有免费额度就先用谁，用完自动换下一家。

[English](README.md) | 简体中文

## 快速开始

```bash
npx skills add ikelvingo/foragix -g
export TAVILY_API_KEY=<你的key>
```

## 本 Skill 提供的工具

- **`search`**：搜索网页，返回相关页面及摘要。
- **`fetch`**：读取指定网页的正文内容。
- **`status`**：查看搜索与读取渠道的可用状态，帮助判断服务暂时不可用的原因。
- **`information`**：直接查询具体信息，例如天气、百科、汇率或知乎内容。除搜索网页和读取页面外，Agent 也可以通过此工具按问题类型优先选择合适的数据源：
  - **天气、空气质量、出行、汇率、行情、节假日、赛事等结构化信息**：优先使用[豆包搜索 Custom（火山如意）](https://docs.volcengine.com/docs/networked-search/huoshan-ruyi-data-structure?lang=zh)，与豆包搜索共用次数。
  - **百度百科词条、词条义项**：优先使用百度百科接口，次数单独计算，每天免费 100 次。
  - **秒懂百科视频信息**：优先使用百度秒懂接口，次数单独计算，每天免费 50 次。
  - **知乎站内内容**：优先使用知乎站内搜索，搜索次数计入知乎每日 5000 次共享额度；知乎搜索结果是摘要。读取知乎页面时仍会尝试获取页面正文，知乎官方全文接口仅支持读取当前账号自己的创作。
  - **其他网页**：继续使用原有网页搜索与正文抓取渠道。

  如果优先数据源没有合适结果，Agent 会按可用渠道继续尝试，并说明结果是否降级。百科内容可能是摘要而非全文；秒懂返回视频信息，不是字幕。供应商免费额度各自计算，超额可能产生费用；本机用量记录不代表供应商账户余额。

> [!TIP]
> 一些 Agent（如 Hermes Agent）自带网页搜索和页面正文提取工具。请关闭这些内置工具，避免路由冲突，让网页搜索与页面读取请求统一交给 foragix 处理。

## 给 key 的方式（优先级从高到低）

1. `--credentials <文件路径>`：指定的 key 文件（任意文件路径都支持；`FORAGIX_CREDENTIALS=<文件路径>` 环境变量与之等价），顶替下面所有方式。
2. `FORAGIX_HOST_ENV=<文件路径>`：声明一个 key 文件（任意文件路径）。
3. 系统环境变量：`export TAVILY_API_KEY=<你的key>`。

无论哪种方式：key 只写值给环境或文件，配置文件里永远只写变量名、不写值。

## 配置参考

配置文件放在 `~/.foragix/config.yaml`（可选：不写就用内置默认，写了的值覆盖默认）。key 从上面「给 key 的方式」里来，配置文件里永远只写变量名、不写值。下表列出 20 家供应商各自可选的 `account` 设置；API key 应放在 `credentials` 或环境变量中，不属于 `account`。

```yaml
version: 1                     # 只接受 1
providers:
  - id: tavily                 # 必需，20 个 id 之一
    enabled: true              # 默认 true
    priority: 30               # 覆盖成 30；不写 = 列表位置 ×10，数值小者先试
    credentials:               # 整段不写 = 用该家自己声明的变量名
      - name: TAVILY_API_KEY   # 只写环境变量名，永不写值
        required: true         # 缺变量时不使用该家
    account: {}                # 可选的服务专属设置，见下表
  - id: minimax
    enabled: true              # 默认关闭，这里显式打开
    account:
      base_url: https://api.minimax.io
```

| 服务 ID | `account` 键 | 填写内容 | 默认值 |
| --- | --- | --- | --- |
| `minimax_cn` | `base_url` | 可选：覆盖 MiniMax 国内 API 地址 | `https://api.minimax.cn` |
| `keenable` | — | 无专属 `account` 设置 | — |
| `searxng` | `base_url` | SearXNG 实例地址 | `https://search.ikelvin.space:8443` |
| `minimax` | `base_url` | 可选：覆盖 MiniMax API 地址 | `https://api.minimax.io` |
| `tinyfish` | — | 无专属 `account` 设置 | — |
| `you` | — | 无专属 `account` 设置 | — |
| `zhihu` | `db` | `zhihu` 调用知乎站内搜索接口；`global` 调用全网搜索接口（`SearchDB=all`） | `zhihu` |
| `anysearch` | — | 无专属 `account` 设置 | — |
| `ollama` | — | 无专属 `account` 设置 | — |
| `linkup` | — | 无专属 `account` 设置 | — |
| `exa` | — | 无专属 `account` 设置 | — |
| `metaso` | — | 无专属 `account` 设置 | — |
| `firecrawl` | — | 无专属 `account` 设置 | — |
| `tavily` | — | 无专属 `account` 设置 | — |
| `brave` | `capped_free` | `true` 保留本地免费额度上限；`false` 取消本地上限 | `true` |
| `doubao` | `version` | `global` 使用 Global Search；`custom` 使用 Custom（火山如意） | `global` |
| `baidu` | — | 无专属 `account` 设置 | — |
| `deepseek` | — | 无专属 `account` 设置 | — |
| `zhipu_cn` | `base_url` | 可选：覆盖智谱国内 API 地址 | `https://open.bigmodel.cn/api/paas/v4` |
| `zhipu` | `base_url` | 可选：覆盖智谱 API 地址 | `https://api.z.ai/api/paas/v4` |

例如，要让知乎 provider 搜全网，在它的配置中这样设置 `db`：

```yaml
- id: zhihu
  account:
    db: global
```

不写 `account` 或保留 `account: {}` 都会使用表中的默认值。
单次搜索显式指定 `site:zhihu` 时，始终调用知乎站内搜索接口，即使 `db` 设置为 `global`。

- 重复 `id` 或顶层未知键：启动直接拒绝。
- 某一家内部写错（未知键、凭据名不符、取值越界）：只隔离该家，其余照常。
- 没列出的服务自动带默认值进池；默认关闭的五家是 `minimax`、`minimax_cn`、`zhipu`、`zhipu_cn`、`deepseek`。
- 想用别的配置文件：`--config <路径>`（或环境变量 `FORAGIX_CONFIG`）；指定文件必须真实存在，否则启动失败。

## 记数在哪

搜索记数保存在本机 `~/.foragix/` 里，升级、重装都不会丢；`config.yaml` 也放这里。删掉这个文件夹就是从零开始，换台电脑就是另一份记数。

## 服务清单

| id | 凭据变量 | 默认 |
| --- | --- | --- |
| `minimax_cn` | `MINIMAX_API_KEY` | false |
| `keenable` | `KEENABLE_API_KEY` | true |
| `searxng` | 无 | true |
| `minimax` | `MINIMAX_GLOBAL_API_KEY` | false |
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

- `keenable`：每月 100,000 次免费搜索与抓取请求共用额度；免费额度用完后的购买额度由 Keenable 账户决定。详见 [REST API 文档](https://docs.keenable.ai/api-reference)。

## 已知限制
- 本地记的用量只是估算，服务商自己的拒绝才算数。
- 记数跟人走：换一台电脑或换一个用户目录，就是另一份独立的记数。
- 只做搜索、正文抓取与信息查询；不爬站、不操页面。
