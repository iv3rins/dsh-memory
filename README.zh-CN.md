# dsh-project-memory

**语言：** [English](./README.md) · 简体中文 · [日本語](./README.ja.md) · [Español](./README.es.md)

为 [DeepSeek Harness](https://github.com/deepseek-ai) 提供项目记忆：你的文档、你的开发状态，以及能扛过重启与上下文压实的持久记忆原子。纯宿主侧 cordis 插件，另配一个侧边栏面板。

```
MIT · Node 20+ · 无运行时依赖
```

## 要解决的问题

每个会话开始时，Agent 都是一张白纸。于是你重复解释项目结构，它重复读同一批文档，重复推翻你上周已经定下的决定，也重复踩同一个坑。

在单个会话内部，同样的损失更安静：上下文一长，harness 就会压实（compaction），原始对话被摘要替代。上下文变得便宜了，而摘要没写下的部分就永久消失了。

这个插件把记忆放在**仓库里**，而不是放在上下文窗口里。

## 工作方式

三套存储，因为「你写了什么」「你正在做什么」「你决定了什么」的生命周期不同：

| 系统 | 存什么 | 由谁写入 | 能扛过 |
|---|---|---|---|
| **A — 文档** | 你的 Markdown | 你，在 git 里 | 一切 |
| **B — 状态** | 任务、进度、阻塞、决定 | `state_update` / `state_handoff` | 重启、压实 |
| **C — 记忆簇** | 按主题聚合的持久记忆原子 | 压实观察器、`memory_remember` | 重启、压实 |

真正有意思的是 **C**：

```
长会话 ──▶ 压实 ──▶ 有损摘要（模型下一步看到的东西）
               │
               └──▶ 记忆簇 ──▶ .dsh-memory/memory/atoms.jsonl
                                        │
下一步 ──▶ 按当前任务定位相关簇 ──────────┘
            └──▶ 从相关簇选出预算内的候选原子
```

四条性质让它便宜到可以每一步都跑：

1. **先定位簇。** 按任务涉及的词语、标签和文件路径匹配主题，再从匹配的簇中选择预算内的候选原子。
2. **记录，而非抓取。** 状态与原子由工具调用写入。从不调用 `state_update` 的 Agent 就没有状态记忆——这是*可见的缺失*，而不是悄悄出错。唯一的例外是刻意的：压实观察器读取压实摘要，那正是系统 C 存在的理由。
3. **确定性召回为常驻规则预留预算。** 即使请求没有字面匹配，常驻约束仍可进入确定性召回。配置路由模型后，提议中的任何原子都由执行模型决定是否加载。
4. **选择只读。** 路由模型只能选择收到的 ID。确定性代码负责写入，并丢弃未知 ID。

### 路由模型档位

| `routerTier` | 行为 | 成本 |
|---|---|---|
| `off` | 只做确定性打分 | 免费 |
| `smart`（默认） | 仅当确定性打分没找到相关项、或匹配很弱时才复核 | 未配置模型时不调用 |
| `always` | 每次符合条件的召回都调用路由模型 | 每次查询至多一次模型调用 |

初始设置没有路由模型。配置 DSH 路由模型需同时填写 `routerProvider` 和 `routerModel`，使用 `routerStrategy`（`task` / `compliance` / `orient`）指定检索指令。

#### 复核记忆提议

配置路由模型后，`agent/pre-step` hook 可以在执行模型开始工作前提供一份提议，其中只有候选 ID、类型、簇 ID 和关联文件。执行模型可先阅读当前项目，再决定加载哪些记忆。手动调用 `memory_intent` 也走同一套流程。

1. 使用 `memory_intent({ task_summary: "解释设置如何保存", affected_modules: ["lib/panel.js"] })` 查询。
2. 将返回的 `proposal_id` 与 `accept_memory_ids` 一起传给 `memory_intent`，只加载获准的记忆正文。传入空列表可拒绝整份提议。
3. 要重新查询，将 `proposal_id` 与 `feedback` 一起传入，说明当前项目里的证据。新查询会利用这些证据并排除此前被拒绝的记忆 ID。执行模型可继续复核，按需要重复此步骤。

路由模型可以返回无记忆。路由模型弃权或调用失败时，本次召回没有记忆正文进入上下文。停用或未配置路由模型时，使用确定性召回。

#### 在面板选择路由模型

在工具栏可以切换已知项目。打开 **配置路由模型**，填入 OpenAI 兼容的 **Base URL**（例如 `http://127.0.0.1:8080/v1`）和服务所需的 API Key。点击 **获取模型**，选中模型后点击 **使用此模型**。远程服务必须使用 HTTPS，密钥保存到 DSH 凭据库。此连接对当前 Profile 的所有项目生效。调用路由模型时，任务意图和记忆候选会发往该服务。点击 **恢复 DSH 路由模型** 可移除独立路由模型配置。

#### 旧版完整本地地址

已有 Profile 配置可以继续使用完整的 chat-completions 地址，例如：

```yaml
routerTier: always
localRouterEndpoint: http://127.0.0.1:8080/v1/chat/completions
localRouterModel: your-local-model
routerTimeoutMs: 20000
```

地址只允许 `127.0.0.1` 或 `[::1]`，并需与 OpenAI API 兼容。本地配置优先于 DSH 路由模型，沿用同一套执行模型复核流程。每次请求独立计时。

### 「常驻」不等于「权重」

权重（1–5）是**排序**输入；常驻是**资格**输入，由类型（`constraint`）决定，从不看权重。把两者混在一起曾是一个真实缺陷：以默认权重存储的真规则会悄悄失去硬规则身份。常驻原子仍受条数与 token 上限约束——那是预算份额，不是豁免。

## 安装

```
git clone https://github.com/iv3rins/dsh-memory.git
```

manifest 声明了 `dsh.bundle`，所以一条命令会同时加依赖**和** bundle 条目：

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add -w "link:D:\path\to\dsh-memory"
```

重启宿主后调用 `project_inspect`：能解析出项目根目录、并给出已索引文档数，就说明已生效。

`engines.dsh` 为 `>=0.2.0-rc.0 <0.3.0`，故意收窄：宿主次版本可能改动工具 schema 子集或消息结构，那样本插件会在**挂载时**失败而非安装时报错。对新宿主重跑测试套件后再放宽。

## 工具

共十八个工具。进入陌生会话时先调 `memory_status`。

| 工具 | 回答什么 |
|---|---|
| `memory_status` | 记忆是否已初始化？哪个修订号？相对 git 是否过期？多少原子？ |
| `memory_bootstrap` | 新会话需要的一切，一次有预算的调用。 |
| `memory_search` | 哪些文档谈到这个？带排序与 status/kind/path 过滤。 |
| `memory_read` | 读一篇文档，或其中一个 `##` 小节，按数据处理。 |
| `memory_recall` | 从项目记忆簇中做确定性检索，返回相关原子。 |
| `memory_intent` | 按任务查询记忆簇，并可接受、拒绝或重新查询提议。 |
| `memory_remember` | 存入持久事实、约束与决定。 |
| `memory_forget` | 按 id 退役原子；墓碑是粘性的。 |
| `memory_lifecycle` | 查看并调整原子层级（HOT / WARM / COLD）。 |
| `memory_metrics` | 路由模型调用数、延迟、缓存命中、交付与确认使用、token 成本。 |
| `state_get` / `state_update` | 读状态；记录变更。CAS 写入，冲突会被告知。 |
| `state_handoff` | 写一条会话收尾，让下一个会话开局即清醒。 |
| `project_init` / `project_inspect` | 创建 `.dsh-memory/`；只读诊断。 |
| `docs_check` / `docs_sync` | 检查 front-matter 问题；提出文档修改（绝不原地改写）。 |
| `architecture_check` | 依据 `.dsh-memory/arch.json` 做确定性 import 规则检查。 |

**命令：** `/memory-status`、`/memory-context`、`/memory-init`、`/memory-handoff`、`/memory-recall`、`/memory-route`、`/memory-forget`、`/memory-sync`、`/architecture-check`。`/memory-route` 是预演：显示当前档位会走哪条路、为什么，且不花一次模型调用。

**侧边栏面板。** 查看最近的压实结果、有效记忆与已遗忘记忆的条数、常驻规则和记忆分布。路由模型控件默认折叠。可用 `memory_forget` 退役记忆。面板接口限本机回环地址访问。

**上下文注入。** 第一步注入预算内的项目基线（身份、git 状态、任务、规则、下一步、阻塞、决定和文档索引），仅在身份变化时重发。每一步还可能收到确定性召回或待复核的记忆提议。基线与召回消息经会话去重，并通过 nonce 围栏标明项目数据。

## 配置

每个字段都有可用默认值；非法值会被修正，绝不致命。

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关。 |
| `injectContext` / `injectRecall` | `true` | 注入基线 / 每步召回。 |
| `l0Budget` / `l1Budget` / `l2Budget` | `300` / `1200` / `2000` | Token：最小基线、完整基线、单次读取。 |
| `recallBudget` / `recallLimit` | `400` / `8` | 单次召回的上限与条数。 |
| `routerTier` / `routerStrategy` | `smart` / `task` | 见上文档位表。 |
| `routerProvider` / `routerModel` | `''` / `''` | DSH 路由模型。 |
| `routerBaseUrl` / `localRouterModel` | `''` / `''` | 独立路由模型的 API 根地址和模型名，可在面板中配置。 |
| `localRouterEndpoint` | `''` | 旧版 Profile 使用的回环 chat-completions 地址。 |
| `routerTimeoutMs` / `routerDigestBudget` | `20000` / `900` | 每次路由模型调用的超时和预计输入 token 预算。 |
| `extractOnCompaction` / `extractUserRules` | `true` | 从摘要与明说的规则里提取原子。 |
| `semanticRouting`、`lifecycleEnabled`、`taskIntentEnabled` | `false` | 可选加层；把该开关设回 `false` 即恢复旧行为。 |
| `protectedPaths` | `AGENTS.md`、`docs/decisions/`、`docs/adr/`、`.git/` | `docs_sync` 永不写入。 |

六个字段可按项目覆盖——`routerTier`、`routerStrategy`、`routerProvider`、`routerModel`、`recallBudget`、`recallLimit`——写在 `.dsh-memory/settings/<project-key>.json`。其余字段刻意保持全局：路径与写入上限描述的是这套安装，而不是某个仓库。

## 存储

一切都在 `.dsh-memory/` 下。提交进 git 就是团队共享记忆，忽略它就是个人私有记忆——两种都自洽。

```
.dsh-memory/
  project.json       稳定的 projectId + 首次见到的 git 事实
  state/current.json  状态文档（带修订号）
  state/journal.jsonl 已接受写入的追加日志
  state/compactions.jsonl 每次观察到的压实一行，含沉默的
  memory/atoms.jsonl  每个有效记忆簇或墓碑各占一行 JSON
  memory/metrics.json 有上限的事件计数
  index.json          派生缓存 —— 可安全删除
  settings/<key>.json 按项目的覆盖设置
```

旧的单原子记录可以直接读取，在下一次实际写入时迁移为簇。原子 ID、来源、常驻规则和墓碑保留。重复观察到同一句话会强化同一个原子。`memory_forget` 写入墓碑，阻止后续重新提取这条记忆。

## 哪些测过，哪些没测

**测过**（`docs/design/benchmark-compaction-loss.md`）：在真实数据集上取 80 个问题，仅给摘要的上下文正确率 16.3%，仅给原始尾部 15.0%，摘要加原子召回 25.0%。所有置信区间都跨零，所以这只是一个**方向一致**的观测，**不是已确立的效果**。

**没测**：

- **路由模型的准确率和调用频率。** 使用模拟路由模型验证了超时、中止、格式错误与未知 ID。尚未测量真实 DSH 路由模型的准确率和 `smart` 档位的调用频率。
- **记忆簇召回的性能。** 每次仍需解析 `atoms.jsonl`，再对匹配簇中的原子排序。现有的全库扫描性能数据来自迁移之前。

## 它不会做什么

- 不会修改 `AGENTS.md`、`docs/decisions/`、`docs/adr/`、`.git/`。`docs_sync` 会拒绝这些路径并说明原因。
- 不会提交、建分支或推送。它只记录 git 事实，不执行 git 操作。
- 不会悄悄臆造状态。每次写入都是 CAS；并发写入会冲突而不是覆盖。
- 不会原地改写权威文档。提议统一写到 `docs/proposals/`。

## 验证

```powershell
npm run setup        # 提取并链接宿主包（一次，幂等）
npm test             # 单元测试
npm run test:host    # 宿主集成测试
```

宿主套件覆盖：harness 强制的工具 schema、注入与去重、经真实事件的完整「压实 → 召回 → 遗忘」闭环、安全与路径拒绝、优雅降级、manifest 兼容性、面板 HTTP 行为、按项目设置，以及 Client 半边。被跳过的检查会打印 `SKIP`，它什么也不能证明。

**套件全绿不等于装好了。** 套件在仓库自建的 cordis 上下文里挂载插件；只有真正拉起宿主才能证明 profile 能加载它。两件事都要做。

## 目录结构

```
core/   纯 Node，不 import DSH —— 可测试的核心
        memory.js  clusters.js  gate.js  state.js  retrieval.js  category.js  lifecycle.js
        extract.js  config.js  index.js  search.js  store.js  paths.js  ...
lib/    cordis 层：index.js  tools.js  commands.js  panel.js  recall.js
        recall-review.js  router.js  semantic.js  delegate.js  compaction-memory.js
client.js  侧边栏面板（Client 半边）
tests/     unit/（node --test）与 *.mjs 宿主检查
docs/      设计说明与文档提议
```

`docs/design/system-c-memory-atoms.md` 深入讲了原子层，包括两个靠测试而非靠阅读发现的坑：对原始分数直接做 softmax 会塌缩成单一专家；纯粹按重合度排序，恰好会在硬约束最重要的时候把它丢掉。

## 开源协议

[MIT](./LICENSE) © 2026 iverins
