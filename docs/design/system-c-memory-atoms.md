# System C — memory atoms 与稀疏路由

阶段 1/2 的设计把插件拆成 System A（文档知识）与 System B（开发状态）。两者都有一个
共同前提：**信息要么在文档里，要么被工具显式写进 `state/current.json`**。但真实会话里
最大的一类信息落在两者之间 —— 它只存在于对话上下文中，然后被压实（compaction）抹掉。

本文是补上的第三套系统，以及它为什么必须存在、边界在哪里。

---

## 1. 问题：压实是有损的，且损失不可寻址

Harness 的压实器（`@deepseek-ai/dsh-compaction-basic`）把前序回合替换成一份固定
`##` 结构的摘要（Primary Request and Intent / Key Technical Concepts / Files and Code /
Errors and Fixes / Pending Jobs / Current Work / Next Step / Critical Context）。之后：

- 被摘要丢掉的细节，在余下会话里永久消失；
- 即使摘要保留了某句，它也是**写给读者看的散文**，不是可寻址的记录。下一个请求没有
  办法说"给我那份摘要里关于 Windows 路径的两条约束"。

所以问题不是"摘要写得不够好"，而是**摘要这个形态本身不可检索**。

## 2. 为什么不直接换掉压实

`ctx.compaction` 是每个 context **只能有一个**实现的 service，替换它会与
`dsh-compaction-basic` 冲突，且要重写整个 harness 的摘要逻辑 —— 收益是零，风险是全局的。

本插件只**观察**压实：监听 `session/event` 上的
`compaction/start` / `compaction/summary` / `compaction/end`。这是唯一被允许的位置。

这条观察通道有三个硬约束，直接决定了 System C 的形态：

| 约束 | 后果 |
| --- | --- |
| 回调是 fire-and-forget，异常被 harness 吞掉 | 写入**绝不能抛**，否则失败无声无息 |
| 事件可能重放（resume 时） | 写入必须**按 `compactionId` 幂等** |
| 无返回值、无确认 | 任何"等它写完再继续"的设计都不可能成立 |

## 3. 数据模型：atom

一条 atom 是一个句子级、可寻址、带出处的记忆记录：

```jsonc
{
  "id": "a34d4af142b99de0",     // hash(kind + 归一化文本) —— 内容即身份
  "kind": "constraint",          // constraint|decision|fact|task|preference|pitfall|summary|question
  "text": "Never rewrite AGENTS.md from a tool call.",
  "tags": ["critical context"],
  "files": [],
  "weight": 5,                   // 1..5
  "confidence": 0.8,
  "seen": 1,                     // 重复见到则 +1，而不是新增副本
  "createdAt": "…", "updatedAt": "…",
  "source": { "sessionId": "…", "compactionId": "…", "seq": 1940 },
  "forgotten": false
}
```

设计要点：

- **内容寻址**。id 是 `kind + 归一化文本` 的哈希，所以"又见到同一句话"是强化（`seen++`），
  不是追加副本。这让重放天然幂等，不需要额外的去重表。
- **出处是数据的一部分**。`source.compactionId` 让渲染出的记忆块能说"这条来自某次摘要"，
  否则模型会把一份过时的摘要当成当前指令。
- **墓碑是粘性的**。`memory_forget` 不删行，而是写 `forgotten: true`；合并时
  `forgotten = existing.forgotten || incoming.forgotten`。如果允许"后写覆盖"，下一次
  提取就会把用户明确要求忘掉的东西复活 —— 那等于忘记功能不存在。
- **文件即日志**。`atoms.jsonl` 一行一条，只追加。上限 `MAX_ATOM_RECORDS=1200`
  时按（未忘 → 强化次数 → 新旧）裁剪，裁剪后重写整个文件。

## 4. 检索：稀疏门控，而不是全量注入

把记忆全部塞进上下文不叫记忆，叫第二份上下文。有用的是门控的**三个性质**：

1. **稀疏** —— 许多条里选少数几条；
2. **可解释** —— 每条入选都有理由（重叠 / 稀有词 / 类型 / 强化 / 新近度）；
3. **有上限** —— 一个调用方无法意外突破的 token 天花板。

评分是确定性的：

```text
score = 6·overlap + 10·rareOverlap + 1.5·kindPriority + 2·seen + 3·(weight−2)
      + 4·(confidence−0.5) + 4·recency
```

`rareOverlap` 用店内的 document frequency 加权 —— 一个只出现在两条记忆里的词，
比一个到处都是的词更能定位。

### 4.1 两级混合，对应稀疏 MoE 的两个层次

- **专家 = kind**。一组的 logit 取它最强成员的分数（`best + 0.25·runnerUp`），
  所以一条锋利的约束胜过五条含糊的事实。
- **组内 = atom**。组内按相关性、强化、新近度竞争。

softmax 给出门控分布，`EXPERT_THRESHOLD=0.12` 以下不激活，`MAX_ACTIVE_EXPERTS=3` 封顶。

**一个实现上的坑**：softmax 必须作用在**归一化后**的 logit 上。直接对 0–70 的原始分
做 softmax，`exp(48)` 会饱和成 one-hot，表面上"稀疏"，实际是只激活一个专家，且对
其余所有类型都判断错误。归一化方式是按非零 logit 的均值缩放。

### 4.2 常驻规则先占预算

这是整套系统的存在理由。一条硬约束（"never rewrite AGENTS.md"、"必须传 baseRev"）
恰恰是**丢失后会产生错误动作**的那类记忆，而它的措辞通常和触发它的请求毫无重合：
"帮我整理一下文档" 和 "never rewrite AGENTS.md" 共享零个词。纯按重叠排序，会在它最
重要的时刻丢掉它。

所以 `constraint` 类且 `weight >= 4` 的 atom 先占一个**封顶**的预算份额
（`STANDING_BUDGET_SHARE=0.4`，同时限制条数与 token）。双向封顶是关键：规则多的店
不能挤掉请求真正相关的内容，无关请求也不能挤掉规则。

常驻入选的 atom 在渲染时标注 `standing rule`，并且**不计入覆盖率**——否则一个无关请求
会因为"有规则兜底"而看起来被回答了，`smart` 档就永远不会升级到路由。

## 5. 三档路由

`decideRoute` 把整个设置收在一个函数里：

| tier | 行为 | 成本 |
| --- | --- | --- |
| `off` | 只走确定性门控 | 免费 |
| `smart`（默认） | 确定性门控，仅在**没选到任何相关内容**或**匹配很弱**时升级给路由子代理 | 近乎免费 |
| `always` | 每步都问路由子代理 | 每步一次调用 |

`smart` 在 `routerProvider` 与 `routerModel` 都设置之前不花任何调用，所以开箱即零成本。

### 5.1 路由子代理必须是不可见的

用 `ctx.subagents.startActivation({...})`，关键是 `delivery: 'caller'`：

- `delivery: 'parent'` 会追加一条**用户可见**的完成通知；
- `delivery: 'caller'` 什么都不发（manager 里 `if (!activation.announced || activation.delivery === 'caller') return`）。

一个记忆路由如果每次都在对话里留下痕迹，用户会以为模型在自言自语。

其它约束：

- `maxDepth: 1` —— 路由是叶子，不能自己再开子代理；
- `request.parent` 必须是**活的** parent agent，`startActivation` 会做身份校验
  （`ctx.get('agents').get(id) !== parent` → `UNAUTHORIZED`）；
- `routerTimeoutMs` **加上**本步的 `signal` 双重限时；
- `runRouter` 用 `Promise.race([delegate, cancelled])` 竞速，所以即使 delegate 不理会
  abort 也一定会 settle —— 否则会挂住一整个 top-level await；
- 子代理只回 id，未知 id 被丢弃并计入 `rejected`；**router 从不写 store**。

### 5.2 缓存与冷却

`routeIdentity({agentId, queryText, tier})` 是 sha256 前缀。同一轮同一个请求不重复路由，
`routerCooldownSteps` 控制同一请求再次路由前要等几步。

## 6. 注入通道与去重

`agent/request` 不能改 messages，唯一支持的注入点是 `agent/pre-step` waterfall：
返回 `{...decision, messages: [...messages, ...outbound]}`。

recall 块是一条**独立消息**，带自己的 source kind（`project-memory:recall`），
携带 `route` / `tier` / `atoms` / `tokens` / `confidence` / `recallIdentity`。
独立成条的理由是可审查性：读 transcript 的人能区分「durable baseline」和
「为这一步算出的排序选择」。

去重**按 atom 集合**，且必须扫 surface 而不是记 flag：

- 记 flag 会在压实后出错 —— 被压实遮掉的 recall 已经不在模型视野里，必须重发；
- 扫 surface 恰好给出正确语义：还能看见就别重复（否则每一步都在重述同一段，
  花掉这个系统本来要省下的预算），看不见就补发。

`recallIdentity` 只哈希 atom id 集合，不含分数和出处 —— 同样的原子集合即使措辞不同
也无新信息可给。

## 7. 提取：确定性的、保守的

不用模型调用：那会让每次压实的成本翻倍，还可能编造用户从未说过的约束。
解析器只认识压实器的固定小节标题，加上一组强烈的措辞线索（never / must / prefers /
error / decided / unknown）。

**宁可漏，不可编**：漏掉的 atom 只花一次搜索，编造的 atom 会污染此后每一个回合。

### 7.1 过滤 harness 自己的样板文本

压实摘要由一个读过全部 transcript 的模型写成，所以它的 `## Critical Context` 常常会
把会话的脚手架也复述进去：runtime-context 前言、checkpoint 头、**本插件自己的 recall
块**、skill catalog 变更通知。

这些字符串是关于会话的，不是关于项目的。一旦入库就会永远被召回：不过期、占预算，
而且因为下一份摘要里还有它，最容易被再次提取成新副本。

所以 `isBoilerplate()` 用一组**锚定且具体**的模式挡掉它们。这里假阴性代价很小
（同小节里真正的内容还会以别的句子留下），假阳性代价是一条有用的 atom，所以模式
写得克制。

## 8. 与 System A / B 的边界

| | System A 文档 | System B 状态 | System C atoms |
| --- | --- | --- | --- |
| 真相源 | 仓库里的 Markdown | `state/current.json` | `memory/atoms.jsonl` |
| 写入 | 工具显式调用 | 工具显式调用 | 压实事件自动 + 工具显式调用 |
| 单位 | 文档 / 小节 | 结构化字段 | 句子级 atom |
| 检索 | `memory_search` / `memory_read` | 全量注入（有预算） | 稀疏门控 + 可选路由 |
| 权威性 | **权威** | 权威 | **非权威**，带出处 |

Atom 不是文档的替代品。一条被召回的 atom 是一句带出处的话，不是一份规格：它可能过时，
可能是对摘要的简化，且注入时被框为数据。**真正重要的内容属于文档**，因为
`memory_read` 能返回完整小节。

## 9. 验证

- `tests/unit/atoms.test.mjs` —— 身份、合并、墓碑、store、裁剪、门控、路由档位、
  提取、用户规则、router（含超时/抛错/中止）、recall（含 router 分歧与降级）、
  压实观察者（重放幂等、畸形事件、写失败被吞）、config。
- `tests/loop.mjs` —— 走真实 service 的闭环：`session/event` 上的压实事件写出带出处的
  atom；下一个 `agent/pre-step` 返回含它们的 recall 消息且在条数上限内；重放不新增；
  同一集合不重复注入；被 forget 的 atom 不出现在下一次 recall。
- 未验证：router 子代理从未对着真实模型跑过（单测用桩覆盖了超时、中止、畸形回复、
  未知 id）。失败时降级为确定性选择，所以最坏情况是少一次改进，而不是坏掉一步。
