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
| **C — 原子** | 短小的持久陈述 | 压实观察器、`memory_remember` | 重启、压实 |

真正有意思的是 **C**：

```
长会话 ──▶ 压实 ──▶ 有损摘要（模型下一步看到的东西）
               │
               └──▶ 短原子 ──▶ .dsh-memory/memory/atoms.jsonl
                                        │
下一步 ──▶ 只为「这次请求」做稀疏选择 ────┘
            └──▶ 少量原子，受 token 上限约束
```

四条性质让它便宜到可以每一步都跑：

1. **稀疏，而非倾倒。** 从几百条里只取少数几条，且按*本次*请求排序。硬性 token 上限意味着成本由配置决定，而不随项目规模膨胀。
2. **记录，而非抓取。** 状态与原子由工具调用写入。从不调用 `state_update` 的 Agent 就没有状态记忆——这是*可见的缺失*，而不是悄悄出错。唯一的例外是刻意的：压实观察器读取压实摘要，那正是系统 C 存在的理由。
3. **规则优先于相关性。** `constraint` 类原子是**常驻（standing）**的：它在任何打分之前就被选中，且即使本次请求字面不相关也会保留。只在"你恰好提到它"时才生效的规则，不算规则。
4. **选择永不写入。** 可选的 router 子代理只能从交给它的 id 里选，它编造的 id 会被丢弃。写操作只发生在确定性代码里。

### Router 三档

| `routerTier` | 行为 | 成本 |
|---|---|---|
| `off` | 只做确定性打分 | 免费 |
| `smart`（默认） | 仅当确定性打分没找到相关项、或匹配很弱时才升级 | 未同时配置 provider 与 model 前完全免费 |
| `always` | 每一步都问 router | 每步一次调用 |

`smart` 开箱不花钱：必须 `routerProvider` 与 `routerModel` 都填了才会调用。`routerStrategy`（`task` / `compliance` / `orient`）改变发给 router 的指令集，因此原子相同、档位相同的两套配置也可能召回不同结果。

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
| `memory_recall` | 哪些已存原子适配这个问题？带排序、预算与路由。 |
| `memory_intent` | 同上，但用结构化 Task Intent（任务、模块、操作类型、分类）。 |
| `memory_remember` | 存入持久事实、约束与决定。 |
| `memory_forget` | 按 id 退役原子；墓碑是粘性的。 |
| `memory_lifecycle` | 查看并调整原子层级（HOT / WARM / COLD）。 |
| `memory_metrics` | Router 调用数、延迟、缓存命中、投递与确认使用、token 成本。 |
| `state_get` / `state_update` | 读状态；记录变更。CAS 写入，冲突会被告知。 |
| `state_handoff` | 写一条会话收尾，让下一个会话开局即清醒。 |
| `project_init` / `project_inspect` | 创建 `.dsh-memory/`；只读诊断。 |
| `docs_check` / `docs_sync` | 检查 front-matter 问题；提出文档修改（绝不原地改写）。 |
| `architecture_check` | 依据 `.dsh-memory/arch.json` 做确定性 import 规则检查。 |

**命令：** `/memory-status`、`/memory-context`、`/memory-init`、`/memory-handoff`、`/memory-recall`、`/memory-route`、`/memory-forget`、`/memory-sync`、`/architecture-check`。`/memory-route` 是预演：显示当前档位会走哪条路、为什么，且不花一次模型调用。

**侧边栏面板。** 一个侧边栏入口，打开后回答人们真正关心的问题——*压实到底有没有把记忆留住？* 它显示：最近一次压实的一句话结论、由新到旧的压实时间线（沉默的压实变暗而不是隐藏）、活跃与已遗忘原子数、常驻硬规则数，以及按类型与权重的分布。Router 控件默认折叠。面板**没有任何改动记忆的按钮**：原子由压实和带溯源的工具写入，删除只能走 `memory_forget`。它的两条路由（`/project-memory/status`、`/project-memory/config`）仅限回环地址。

**上下文注入。** 第一步注入一份在预算内的基线（身份、git 事实、任务、不变量、下一步、阻塞、决定、文档地图），仅在身份变化时重发。每一步还可能收到一个召回块，并按会话可见面去重。两者都作为插件自有消息、置于 nonce 围栏内送达：项目文本是数据，永远不是指令。

## 配置

每个字段都有可用默认值；非法值会被修正，绝不致命。

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关。 |
| `injectContext` / `injectRecall` | `true` | 注入基线 / 每步召回。 |
| `l0Budget` / `l1Budget` / `l2Budget` | `300` / `1200` / `2000` | Token：最小基线、完整基线、单次读取。 |
| `recallBudget` / `recallLimit` | `400` / `8` | 单次召回的上限与条数。 |
| `routerTier` / `routerStrategy` | `smart` / `task` | 见上文档位表。 |
| `routerProvider` / `routerModel` | `''` / `''` | Router 使用的模型。留空即不调用。 |
| `routerTimeoutMs` / `routerDigestBudget` | `20000` / `900` | 调用时限；交给它的摘要的 token 上限。 |
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
  memory/atoms.jsonl  持久原子，每行一条 JSON 记录
  memory/metrics.json 有上限的事件计数
  index.json          派生缓存 —— 可安全删除
  settings/<key>.json 按项目的覆盖设置
```

原子 id 是内容寻址的（类型与规范化文本的哈希），所以同一句话被看到两次只会强化同一条记录。`memory_forget` 写入墓碑而不是删行，因此后续提取无法让它复活。损坏的文件会被改名隔离并报告，而不是被悄悄替换。

## 哪些测过，哪些没测

**测过**（`docs/design/benchmark-compaction-loss.md`）：在真实数据集上取 80 个问题，仅给摘要的上下文正确率 16.3%，仅给原始尾部 15.0%，摘要加原子召回 25.0%。所有置信区间都跨零，所以这只是一个**方向一致**的观测，**不是已确立的效果**。

**没测**：

- **Router 准确率——零测量。** Router 子代理从未对真实模型运行过。测试用桩覆盖了超时、中止、畸形回复与未知 id；但没有任何一次真实 spawn 被观察到并产出真实选择。它的 `smart` 触发率同样未测：升级判据写在 `decideRoute` 里，但它实际多频繁触发，没有数字。
- **全量扫描的成本。** `gateAtoms` 每次召回都会给每个活跃原子打分（`core/gate.js`）。本机实测——401 条记录的存储——一次 `readAtoms` 约 5.6 ms，一次 `gateAtoms` 约 9.4 ms；在均匀合成原子上，100 / 200 / 400 / 800 条时分别约 0.7 / 1.0 / 1.6 / 3.3 ms，大致呈线性。**没有倒排索引。** 常驻原子的选择是独立的一**轮**（pass），但复用同一次扫描，因此并不构成独立的候选通道。
- **`atoms.jsonl` 的解析成本。** 每次召回都会重读并重解析整个文件（`lib/recall.js`），没有进程内快照缓存。任何缓存都必须支持跨进程失效（另一个会话、另一个进程、或 `memory_forget` 都可能改写该文件），所以这是一个设计议题，而不是一个补丁。

检索是词法的，不是语义的。Router 超时会降级到确定性选择，所以最坏情况是漏掉一次改进，而不是打断这一步。

## 它不会做什么

- 不会修改 `AGENTS.md`、`docs/decisions/`、`docs/adr/`、`.git/`。`docs_sync` 会拒绝这些路径并说明原因。
- 不会提交、建分支或推送。它只记录 git 事实，不执行 git 操作。
- 不会悄悄臆造状态。每次写入都是 CAS；并发写入会冲突而不是覆盖。
- 不会原地改写权威文档。提议统一写到 `docs/proposals/`。

## 验证

```powershell
npm run setup        # 提取并链接宿主包（一次，幂等）
npm test             # 14 个纯 core/ 层单元测试
npm run test:host    # 28 项按序链接的对真实 harness 检查
```

宿主套件覆盖：harness 强制的工具 schema、注入与去重、经真实事件的完整「压实 → 召回 → 遗忘」闭环、安全与路径拒绝、优雅降级、manifest 兼容性、面板 HTTP 行为、按项目设置，以及 Client 半边。被跳过的检查会打印 `SKIP`，它什么也不能证明。

**套件全绿不等于装好了。** 套件在仓库自建的 cordis 上下文里挂载插件；只有真正拉起宿主才能证明 profile 能加载它。两件事都要做。

## 目录结构

```
core/   纯 Node，不 import DSH —— 可测试的核心
        memory.js  gate.js  state.js  retrieval.js  category.js  lifecycle.js
        extract.js  config.js  index.js  search.js  store.js  paths.js  ...
lib/    cordis 层：index.js  tools.js  commands.js  panel.js  recall.js
        router.js  semantic.js  delegate.js  compaction-memory.js
client.js  侧边栏面板（Client 半边）
tests/     unit/（node --test）与 *.mjs 宿主检查
docs/      设计说明与文档提议
```

`docs/design/system-c-memory-atoms.md` 深入讲了原子层，包括两个靠测试而非靠阅读发现的坑：对原始分数直接做 softmax 会塌缩成单一专家；纯粹按重合度排序，恰好会在硬约束最重要的时候把它丢掉。

## 开源协议

[MIT](./LICENSE) © 2026 iverins
