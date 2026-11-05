# dsh-project-memory

**语言：** [English](./README.md) · 简体中文 · [日本語](./README.ja.md) · [Español](./README.es.md)

面向 [DeepSeek Harness](https://github.com/deepseek-ai) 的项目级持久化知识与开发状态记忆插件。

会话结束、上下文被压实、切换分支 —— 这些时刻 agent 会忘掉一切。对于一个跨越几十个会话的项目，代价是反复推导同样的决策、反复阅读同样的文档、反复犯同样的错误。这个插件让项目拥有一份**存在仓库里、而不是存在上下文窗口里**的记忆。

它是一个**纯宿主侧 [cordis](https://github.com/deepseek-ai/cordis) 插件**：注册 agent 工具、一段 system prompt 小节，以及斜杠命令。没有浏览器端，也不修改 DSH 本身。

```
MIT 协议 · Node 20+ · 纯宿主侧，无客户端部分
```

---

## 目录

- [三套系统](#三套系统)
- [它不会做什么](#它不会做什么)
- [安装](#安装)
- [工具](#工具)
- [存储布局](#存储布局)
- [验证](#验证)
- [配置](#配置)
- [已知限制](#已知限制)
- [开源协议](#开源协议)

---

## 三套系统

**System A —— 文档知识。** 仓库里的 Markdown 是真相源。插件索引它、搜索它、按小节读取它。它从不改写你的权威文档；需要提改动时写到 `docs/proposals/`。

**System B —— 开发状态。** 任务、进度、阻塞项、决策、下一步、git 事实、交接笔记，都由一次工具调用落盘，因此能熬过重启与压实。**持久化靠的是那次工具调用。** 从不调用 `state_update` 的 agent 不会得到任何状态记忆 —— 插件不抓取对话来推断进度。

**System C —— 记忆原子（memory atoms）。** 从压实摘要、以及用户明确陈述的规则中提取出的、可寻址的持久记录，再被**有选择地**召回进下一个请求。这是对"压实即丢失"的回答：检查点摘要会替换掉原回合，被它丢掉的细节就此消失；原子让这些内容在上下文窗口之外获得第二次生命，按相关性被检索，而不是靠运气活过那次摘要。

召回走的是稀疏门控，而不是全量倾倒。打分是确定性的（词面重叠、类型优先级、强化次数、新近度），选择是稀疏的（许多条里选少数几条，有排序），成本有硬上限（一个调用方无法意外突破的 token 天花板）。这就是 MemGPT 那套安排 —— 把上下文窗口当工作内存、把存储器当更大的记忆空间、按需交换 —— 只是用混合专家（MoE）的门控来表达：类型即专家，原子在专家内部竞争，softmax 决定**这一次请求**激活哪些专家。

词面打分不够用时，可以让子代理充当路由器。三档：

| `routerTier` | 行为 | 成本 |
| --- | --- | --- |
| `off` | 只走确定性门控。 | 免费 |
| `smart`（默认） | 确定性门控；仅当没选到相关内容或匹配很弱时，才升级给路由器。 | 近乎免费；只有廉价路径失败时才花一次调用 |
| `always` | 每一步都问路由子代理。 | 每步一次调用 —— 配一个便宜的模型 |

在 `routerProvider` **和** `routerModel` 都设置之前，`smart` 不花任何调用，所以开箱即用时插件零成本。

## 它不会做什么

- 不会修改 `AGENTS.md`、`docs/decisions/`、`docs/adr/`、`.git/`。`docs_sync` 拒绝这些路径，并在结果里说明拒绝原因。
- 不会 commit、branch、push。它只记录 git 事实，不执行 git 操作。
- 不会悄悄编造状态。每次变更都经过 `state_update` 的比较并设置（compare-and-set）修订号，并发写入会冲突而不是互相覆盖。

---

## 安装

一条命令。宿主机自己会加上依赖**和** bundle 条目，因为清单里声明了 `dsh.bundle` —— `reconcileProfilePlugins()` 会把任何新装、且带有该声明的依赖提升进去。

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add -w "link:D:\path\to\dsh-memory"
```

随后重启宿主。用 `project_inspect` 验证：能报出项目根目录与已索引文档数，说明插件已生效。

也可以手改 profile（`dependencies` 加一条 + `dsh.profile.bundles` 加一条），但这条路更慢、而且很容易只做对一半 —— 只加依赖不加 bundle 条目，结果是装上了但永远不会加载。

pnpm 会警告 `link:` 依赖不会从目标的 `node_modules` 解析 peer。这里这是预期且无害的：本插件没有运行时依赖，它唯一的 peer（`@deepseek-ai/dsh-llm`）由宿主提供。

bundle 补丁（`cordis.patch.yml`）只插入一行：

```yaml
- insert:
    - id: project-memory
      name: '@dsh-external/dsh-project-memory'
```

默认值不合适时，可以在这一行上给配置：

```yaml
- insert:
    - id: project-memory
      name: '@dsh-external/dsh-project-memory'
      config:
        l0Budget: 300
        l1Budget: 1200
        registerCommands: true
        routerTier: smart
```

### 升级

`engines.dsh` 是 `>=0.2.0-rc.0 <0.3.0`。这个范围故意写窄而不是敞开：宿主的小版本升级就可能改动工具 schema 子集或注入消息的形状，而那样一来本插件会在**挂载时静默失败**，而不是在安装时大声报错。这个范围写的是真正被测过的版本（0.2.1-rc.2）；对着更新宿主重跑测试套件之后再放宽它。

当 `engines.dsh` 存在时，宿主**只**读它，完全忽略 `peerDependencies` 里的范围（`dsh-app-boot` 里的 `unmetRequirements`）。保留 peer 条目是为了声明这个包在运行时会 import 什么，不是第二道门。

`npm run test:host` 直接检查这一点：`tests/compat.mjs` 把真实清单喂给宿主自己的 `evaluatePluginCompatibility`，所以这个范围不可能悄悄和运行时脱节。

---

## 工具

共 15 个。任何陌生会话里，第一个该调的是 `memory_status`。

| 工具 | 回答什么问题 |
| --- | --- |
| `memory_bootstrap` | 一次调用给出新会话所需的全部内容，且在 token 预算内。 |
| `memory_status` | 记忆初始化了没？当前修订号？相对 git 是否陈旧？有多少原子？也可重建索引。 |
| `memory_search` | 哪些文档谈到了这个？带状态/类型/路径过滤，有排序。 |
| `memory_read` | 读一篇文档，或其中某个 `##` 小节；有长度上限，且被框为数据。 |
| `memory_recall` | 已存的原子里哪些与这个问题相关？排序、有预算，带路由与置信度。 |
| `memory_remember` | 存入持久事实、约束与决策，让之后的会话能找回。 |
| `memory_forget` | 按 id 退役原子。墓碑是粘性的：再次提取也无法让它复活。 |
| `state_get` | 当前任务、进度、阻塞项、决策、下一步。 |
| `state_update` | 记录一次变更。比较并设置；冲突会被告知，而不是被覆盖。 |
| `state_handoff` | 写下会话末交接笔记，让下一个会话一上来就有方向。 |
| `project_init` | 为这个项目创建 `.dsh-memory/`。不会自动创建任何东西。 |
| `project_inspect` | 根目录、git 事实、记忆是否存在、索引状态 —— 只读诊断。 |
| `docs_check` | 整套文档里的 front-matter 与状态问题。 |
| `docs_sync` | 更新文档或提出改动建议，拒绝受保护路径。 |
| `architecture_check` | 按 `.dsh-memory/arch.json` 做确定性的 import 规则检查。 |

### 命令

`/memory-status`、`/memory-context`、`/memory-init`、`/memory-handoff`、`/memory-recall`、`/memory-route`、`/memory-forget`、`/memory-sync`、`/architecture-check`。

`/memory-route` 是试运行：它显示当前档位会走哪条路由以及为什么，**不花**任何模型调用。

### 上下文注入

会话第一步，插件注入一段基线（项目身份、git 事实、当前任务、不变量、下一步、阻塞项、决策、文档地图），适配 `l0Budget`/`l1Budget`。它只在身份变化时重发，且发送前会扫一遍会话表面，所以被压实或恢复的会话不会拿到重复内容。重发就是一段基线；什么都没变时不注入。

每一步还可能额外收到一个 **recall 块**：为这一步的请求选出的原子，带类型、出处和分数。它是一条独立消息，有自己的 source kind，所以审阅者能区分"持久基线"和"为这一步算出的排序选择"。它按**原子集合**对会话表面去重 —— 重述模型已经能看到的原子，会花掉这套系统本要省下的预算；而**新的**选择（或已被压实遮掉的那个）仍然会发。

基线以**插件自有、包在 nonce 围栏里的用户消息**形式到达。项目文本是数据，永远不是指令：角色前缀被中和，"ignore previous instructions" 这类措辞被剥除，不可见字符与双向控制字符被移除，代码围栏被闭合，使文档无法逃出这个框。recall 的原子同样套用这套框法。

---

## 存储布局

全部位于项目根下的 `.dsh-memory/`。提交它或忽略它 —— 两种都自洽。提交给团队共享状态；忽略则给每个开发者一份私有的。

```
.dsh-memory/
  project.json          稳定的 projectId + 首次见到的 git 事实
  state/
    current.json        状态文档（schema 2，带修订计数）
    journal.jsonl       已接受写入的追加日志
    .lock               短时写锁
  memory/
    atoms.jsonl         持久原子，一行一条 JSON 记录
    .lock               短时写锁
  index.json            派生缓存 —— 可安全删除，按需重建
  arch.json             可选的架构规则
```

`atoms.jsonl` 是追加式、内容寻址的：原子 id 是"类型 + 归一化文本"的哈希，所以同一句话见到两次是**强化同一条记录**，而不是追加副本。`memory_forget` 写的是墓碑而不是删行 —— 记录留作证据，且墓碑是粘性的，之后的提取无法把它带回来。

`index.json` 是缓存。它错了或被删了，`memory_status` 会重建。`current.json` 损坏时会被改名成 `current.json.corrupt-<时间戳>` 并在结果里报告，而不是被悄悄替换 —— 坏掉的文件是证据。

> 本仓库自己的 `.dsh-memory/` 已被 gitignore：它是插件的**输出**，不是插件本身。想让团队共享记忆的，在自己的项目里取消忽略即可。

---

## 验证

```powershell
npm run setup        # 从已安装的 app.asar 里提取宿主包并链接
npm test             # 14 个单元测试，针对纯 core/ 层（不需要 DSH）
npm run test:host    # 12 项宿主级检查，对着真实 harness
```

`npm run setup` 是 `test:host` 的一次性（且幂等）前置。它从已安装的桌面版负载里读取包，而不是 `npm install`，所以测试跑在插件将来真正载入的那个宿主上。

`npm run test:host` 依次运行：

| 检查 | 证明了什么 |
| --- | --- |
| `smoke.mjs` | 模块图能加载，并导出 cordis 插件形状。 |
| `tools.mjs` | 每个工具 schema 都被 harness 强制的 JSON Schema 子集接受。 |
| `cordis-semantics.mjs` | 插件依赖的服务解析行为，是**量出来的**而不是假设的。 |
| `inject.mjs` | 基线组装、消息打标、基于表面的去重。 |
| `safety.mjs` | 受保护路径被拒、原件字节不变、路径穿越被挡、陈旧写入冲突、段落被框为数据。 |
| `degrade.mjs` | 可选服务缺失时，15 个工具仍全部注册且可用。 |
| `continuity.mjs` | 状态、决策、阻塞项、文档能熬过模拟重启；陈旧度能跟上真实移动的 HEAD。 |
| `root.mjs` | 根目录发现：子目录共享记忆，无关目录不继承，git 与配置可覆盖。 |
| `compat.mjs` | 宿主自己的 `evaluatePluginCompatibility` 接受本清单，并拒绝无法满足的范围。 |
| `patch.mjs` | `cordis.patch.yml` 能通过宿主自己的 `bundlePatchPaths` 解析，并插入一个可加载的插件。 |
| `mount.mjs` | 插件带真实 `ToolRuntime` 挂载进真实 cordis 上下文，并能干净卸载。 |
| `loop.mjs` | 闭环：压实事件通过真实事件总线写出原子，下一步稀疏召回它们，重放幂等，重复不重复注入，forget 被尊重。 |

`npm test` 覆盖路径包含性、front-matter 解析、索引派生、搜索排序、guard 框法、预算适配、架构检查、原子写入、加锁、状态合并，以及整个原子层（身份、墓碑、稀疏门控、路由档位、提取、路由器、召回、压实观察者）。

宿主测试都需要提取出来的包；缺失时会**跳过**（退出码 0）。跳过会打印 `SKIP`，且从不算作通过 —— 如果一次运行里出现 `SKIP`，它什么也没证明。

**测试全绿 ≠ 装好了。** 测试套件是在本仓库自建的 cordis 上下文里挂载插件；只有真的启动宿主，才证明 profile 确实加载了它。两件都做：先 `npm run test:all`，再重启并调用 `project_inspect`。

---

## 配置

每个字段都有可用默认值。非法值会被修复而不是致命 —— 一个记忆插件不该因为配置文件里有个笔误就中断会话。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 则什么都不注册。 |
| `injectContext` | `true` | 向新会话注入基线。 |
| `announceToAgent` | `true` | 在 system prompt 里加那段指引。 |
| `registerCommands` | `true` | 注册 9 个斜杠命令。 |
| `l0Budget` / `l1Budget` | `300` / `1200` | 最小与完整基线的 token 预算。 |
| `l2Budget` | `2000` | 单次读取的 token 预算。 |
| `maxDocuments` | `5000` | 索引文档数上限。 |
| `gitTimeoutMs` | `4000` | git 探测超时；慢 git 永不阻塞一步。 |
| `includePrefixes` | `docs/`、`README.md` 等 | 哪些会被索引。 |
| `excludePrefixes` | `.git/`、`node_modules/` 等 | 哪些永不索引。 |
| `protectedPaths` | `AGENTS.md`、`docs/decisions/` 等 | `docs_sync` 拒绝的路径。 |
| `projectRoot` | 会话 cwd | 覆盖探测到的根目录。 |
| `extractOnCompaction` | `true` | 把压实摘要变成原子。 |
| `extractUserRules` | `true` | 收割用户明确陈述的规则。 |
| `injectRecall` | `true` | 允许某一步收到 recall 块。 |
| `recallBudget` / `recallLimit` | `400` / `8` | 单次召回的 token 上限与原子条数。 |
| `routerTier` | `smart` | `off`、`smart` 或 `always`。见上面的档位表。 |
| `routerProvider` / `routerModel` | `''` / `''` | 路由器用的模型。两者都设置前 `smart` 保持免费。 |
| `routerReasoningEffort` | `''` | 透传给路由器模型（模型支持时）。 |
| `routerTimeoutMs` | `20000` | 单次路由调用的上限。 |
| `routerCooldownSteps` | `1` | 同一请求再次路由前要等几步。 |
| `routerDigestBudget` | `900` | 交给路由器的原子摘要的 token 上限。 |

---

## 项目结构

```
core/          纯 Node，不 import DSH —— 可测试的心脏
  memory.js    原子存储、身份、合并、墓碑
  gate.js      稀疏 MoE 选择与路由决策
  extract.js   从摘要与用户规则做确定性提取
  state.js     状态文档、比较并设置、日志
  indexer.js   文档索引      search.js   词面排序
  context.js   token 预算     guard.js    "数据而非指令"的框法
lib/           cordis 层
  index.js     插件主体、agent/pre-step 注入
  tools.js     15 个 agent 工具   commands.js   9 个斜杠命令
  compaction-memory.js  session/event 观察者
  recall.js    单步召回       router.js    路由提示词与解析
  delegate.js  子代理激活
tests/unit/    纯 core 测试（node --test）
tests/*.mjs    对着真实 harness 的宿主级检查
docs/          设计笔记与文档提议
scripts/       为测试准备的宿主包提取与链接
```

`docs/design/system-c-memory-atoms.md` 深入讲了原子层与门控，包括两个**由测试而非阅读**发现的实现陷阱（对原始分做 softmax 会塌成单个专家；纯按重叠排序会在硬约束最该出现时丢掉它）。

---

## 已知限制

见 [LIMITATIONS.md](./LIMITATIONS.md)。简述：搜索是词面的而非语义的；路由器受 `routerTimeoutMs` 约束，失败时降级为确定性选择；原子不是权威文档；没有自动提交、没有跨项目查询、没有客户端界面。

路由子代理**从未对着真实模型跑过**。单测用桩覆盖了超时、中止、畸形回复、未知 id，其构造也对过真实 `startActivation` 签名 —— 但没有一次真实 spawn 产生过真实选择。失败时会降级为确定性选择，所以最坏情况是少一次改进，而不是坏掉一步。

---

## 开源协议

[MIT](./LICENSE) © 2026 iverins
