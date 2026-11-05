# 真实会话痕迹审计（2026-11-05）

对 `D:\iverins_workspace\dsh-memory` 的真实运行痕迹做了一次取证审计，用来回答两个问题：

1. 宿主里**真的有**压实（compaction）发生吗？
2. 插件**真的**在压实之后把记忆召回了吗？

审计对象是从 `~/.dsh/sessions/--D-iverins_workspace-dsh-memory--/` 解出的 23 个会话、
87.7 MB 的 `session.v4.jsonl`。解压需要逐帧解码 —— 这些文件是多帧追加的 zstd 流，
`zlib.zstdDecompressSync()` 只解第一帧，会得到 0 字节。

## 结论摘要

| 问题 | 答案 | 证据 |
| --- | --- | --- |
| 有压实痕迹吗 | **有**，19 次 | `compaction/start` ×19、`compaction/summary` ×19、`compaction/prune` ×161 |
| 有基线注入痕迹吗 | **有**，314 次，覆盖 20 个会话 | `source.kind === 'project-memory'` |
| 有召回痕迹吗 | **有**，56 次，但只覆盖 **2** 个会话 | `source.kind === 'project-memory:recall'` |
| 压实后有原子写入吗 | **只 2 次**，对应 2 个 `compactionId` | 原子库 136 条活跃原子，`compactionId` 只有 2 个 |

## 逐会话矩阵

```
session                                        comp sum steps base recall
session-f1122ce5-c3dd-4af6-97d9-a88c6de089ea      4   4   472   10     30
session-1d0dc157-c053-4a52-8f63-645e1bddd185      0   0   179    3     26
session-e5d2208a-6349-4d64-982e-9e6218aae8a5      6   6   824    1      0
session-2600bc2d-ccbd-48a1-8102-e1e264748655      4   4   733   37      0
session-e47402c5-b2b1-413e-a742-0a948a7d603f      4   4   403    1      0
session-3bdd11a9-1b2e-4869-b871-b0a35dc08fd1      1   1    97   31      0
session-1105399c-ed8c-4108-8d7d-85b4d49523a5      0   0   119  119      0
session-3eb4998f-f221-42ca-8ce9-792e8903009a      0   0    76   76      0
（其余 16 个会话：base ≤ 14，recall 均为 0）

TOTAL                                           19  19  3853  314     56
```

按步平均：基线注入 0.081 次/步，压实 0.005 次/步。

## 三个真实发现

### 1. `session/event` 这条缝是通的

19 次压实事件被宿主真实发出，字段完整。**System C 的观察点选对了。**
这是本次审计最有价值的一条：不需要猜 API，宿主自己会广播。

### 2. 基线曾每一步都重发，现在已修好（历史痕迹）

`session-1105399c` 与 `session-3eb4998f` 分别是 **119 次注入 / 119 步**、**76 次注入 / 76 步** ——
每一步都注入一份完全相同的基线（`baselineIdentity` 恒为 `8cf1ce82f3029264`，119 个**不同 seq**）。
时间是 2026-11-03，而 `surfaceHasBaseline` 的去重是 11-05 写的。属修复前的历史痕迹。

`session-1d0dc157` 与 `session-f1122ce5` 里能看到清晰的切换点：
无 `recallIdentity` 的召回（`…98227` → `…99842`）全部早于有 identity 的（`…99925` 之后）。
**当前代码是对的，这两个会话留下了修复前后的分界线。**

### 3. 压实与召回脱节 —— 这是真问题

19 次压实，只有 `f1122ce5` 和 `1d0dc157` 两个会话产生过召回。
其余 17 次压实所在的 4 个会话（`e5d2208a`、`2600bc2d`、`e47402c5`、`3bdd11a9`）**召回数为 0**。

原因是时间差：这 17 次压实的 mtime 是 2026-10-22 和 11-04，
而插件是 11-05 才装上的。**插件装上之前发生的压实，不会被观察到。**

这意味着一个部署现实：**插件只能保护它上线之后的压实。** README 现在没讲这一点。

## 原子库健康状况

| 指标 | 值 | 判断 |
| --- | --- | --- |
| 记录数 / 活跃 / 墓碑 | 137 / 136 / 1 | 正常 |
| 类型分布 | constraint 43、fact 40、pitfall 27、task 20、decision 4、preference 2 | 合理 |
| 完全重复文本 | **0** | 内容寻址的强化生效了 |
| 近似重复（前 60 字符相同） | 2 组 | 可接受，但说明归一化偏弱 |
| **权重分布** | `±2 ×99`、`±4 ×32`、`±5 ×5` | **73% 的原子权重只有 2** |
| 来源 | compaction 130、user-rule 6 | 符合设计 |

权重集中在下限 2 是一个排序质量问题：`STANDING_MIN_WEIGHT = 4` 意味着这 99 条
永远不会被当作常驻硬规则，只能靠词面匹配被捞出来。而其中 `constraint` 有 43 条 ——
**硬规则大量落在权重 2，等于放弃了「不管措辞如何都必须出现」的保护。**

## 缺失的运维能力

审计过程本身暴露了插件缺什么：

1. **没有自检命令。** 要回答「压实有没有写原子」必须手工解 zstd、自己数。
   `/memory-status` 只看库，不看「宿主有没有在压实」。
2. **没有压实计数。** 原子库里没有「我见过多少次压实」的记录，
   所以「19 次压实只写 2 次」这种偏差无法从库内发现。
3. **没有失败可观测性。** `session/event` 回调吞掉异常（设计要求如此，防止拖垮会话），
   但被吞掉的失败没有任何地方记下来。一次提取失败等于永久静默丢失。

---

## 已实施：压实台账（2026-11-05）

上面的第 1、2、3 条已通过新增 `core/compactions.js` 与 `.dsh-memory/state/compactions.jsonl` 解决。

**每条压实一行，包括没有产出原子的那些：**

```json
{"compactionId":"87d5daad-…","sessionId":"…","at":"2026-11-05T10:29:55.921Z","turn":1,
 "summaryChars":15834,"atomsAdded":73,"atomsUpdated":0,"atomsUnchanged":0,
 "statementsSkipped":0,"skipReason":null}
```

`skipReason` 是封闭集合，便于统计而不是靠字符串猜：

| 值 | 含义 |
| --- | --- |
| `extraction-disabled` | `extractOnCompaction: false` |
| `empty-summary` | 摘要渲染后为空 |
| `no-project-root` | 找不到项目根，无处可写 |
| `already-handled` | 同一进程已处理过该 id |
| `no-extractable-statements` | 提取器跑完没找到可存内容 |
| `no-new-knowledge` | 提取到了，但库里全都有，无任何变化 |
| `store-write-failed` | 原子写入失败 |
| `too-many-pending-writes` | 待写入过多被丢弃 |

**`/memory-status` 现在会显示：**

```
compactions observed: 19 (2 wrote atoms, 17 did not)
  silent because: no-extractable-statements 15, store-write-failed 2
  last: 2026-11-05T09:53:11.760Z (fd9440f7)
```

设计约束与原子库一致：追加式、内容为 JSONL、按 `compactionId` 幂等（重放改行不增行）、
上限 500 行、失败只记日志不抛异常（它跑在 `session/event` 回调里）。
台账与原子写入相互独立 —— 原子写失败时台账仍会写下 `store-write-failed`，
这正是「失败可观测」的意思。

验证：`npm test` 里新增了台账用例，覆盖四种 `skipReason`、
重放不增行、以及**原子写失败时台账仍留痕**。

---

## 未修复：提取器会从任意散文里提取原子

写台账测试时发现的第二个问题，比台账缺失更影响记忆质量。

`extractFromSummary` 几乎接受任何文本作为 `fact`：

| 输入 | 结果 |
| --- | --- |
| `The quick brown fox. It jumped.` | 1 条 `fact` |
| `# Summary` | 1 条 `fact`（把标题当事实） |
| ` ``` none ``` ` | 1 条 `fact`（把代码围栏当事实） |
| `Done. The file was read.` | 1 条 `fact` |

设计文档声称提取是「保守的、带样板过滤」，实际只在明显的 harness 样板上有过滤。
后果：每次压实都会把摘要里的叙述性文字变成 `fact` 原子，稀释召回信噪比。
线上库里 40 条 `fact` 中有多少属于这类噪声，目前无法区分 —— 因为没有「原子来自哪种句式」的记录。

**建议**：给 `fact` 增加最低门槛（必须含可判定的断言结构，如主动动词 + 具体名词），
或者把「无门槛事实」单独归为 `note` 类型并默认不参与召回。此项未实施，
因为它会改变现有 136 条原子的召回行为，需要先做 before/after 对照。

---

## 建议的后续架构更新

按价值排序，每条都能直接对应到上面的证据：

### C. 压实后的召回保证

当前 `smart` 档在「选不到相关内容」时才升级路由。压实刚发生时恰恰最需要召回 —— 但
`1d0dc157` 有 26 次召回而 `e5d2208a` 有 6 次压实 0 次召回，说明触发条件不稳定。
建议：`compaction/end` 之后的第一个 `agent/pre-step` 强制至少跑一次召回，
不受 `cooldown` 限制。

### D. 权重校准

`constraint` 类型的原子默认权重从 2 提到 4，让它们进入常驻预算。
或者把 `STANDING_MIN_WEIGHT` 降到 2 但同时限制常驻条数，避免预算被吃光。
需要用真实原子集做一次 before/after 对照，不能凭感觉调。


## 数据留痕

`_audit/` 是从会话日志解出的中间产物（87.7 MB，已 gitignore）。
解压脚本用 node 的 `zstdDecompressSync` 逐帧循环，见本文件的说明。
