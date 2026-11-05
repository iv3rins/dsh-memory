---
title: GC-Inspired Semantic Memory Routing — 实现说明
status: current
kind: spec
tags: [memory, category, lifecycle, task-intent, retrieval, experiment]
---

# GC-Inspired Semantic Memory Routing

这是一次**增量升级**，不是重写。旧的 gate → router → inject 链路原样保留，新能力叠在它上面，并且**默认全部关闭**。

## 1. 回滚方案（最重要的一条）

所有开关在 `core/config.js` 的 `DEFAULTS` 里都是保守值：

| 开关 | 默认 | 含义 |
|---|---|---|
| `semanticRouting` | `false` | 关闭后候选集与升级前完全一致 |
| `lifecycleEnabled` | `false` | 关闭后每个 live atom 都可注入 |
| `lifecycleAutoSweep` | `false` | 关闭后不回写任何生命周期变更 |
| `taskIntentEnabled` | `false` | 关闭后只用 text-derived query |
| `intentCacheEnabled` | `true` | 但仅在 `taskIntentEnabled` 打开时才有键 |
| `metricsEnabled` | `true` | 关闭后不写任何 telemetry 文件 |

**回滚 = 把一个布尔改回 `false`**。`tests/semantic-integration.mjs` 第 8 节断言：关闭状态下重放一次 recall，行为与升级前一致，且**不产生任何新文件**。

## 2. 数据模型

### 2.1 分类（`core/category.js`）

- `category_id` 是**稳定字符串 id**（`mod:core`、`task:bugfix`、`dom:constraint` 等 18 个），不是颜色。
- 颜色只是 UI token（`blue`/`red`/…），由 id 查表得到；**任何逻辑都不比较颜色**。
- 一条 memory 可属于多个 category（上限 `MAX_ATOM_CATEGORIES = 6`）。
- 分类**在读取时派生**（`resolveCategories`）：存储的 `category_id` 优先，否则由 kind/tags/files/text 确定性推导。这与既有的 `resolveStanding` 同一策略 —— **不需要迁移，不重写 `atoms.jsonl`**。
- 未知 category id 会被丢弃而不是存下：存了但目录不认识，等于永远无法被过滤命中，却看起来已分类。

### 2.2 生命周期（`core/lifecycle.js`）

- tier：`YOUNG` / `HOT` / `WARM` / `COLD`
- `pinned` 独立布尔
- **状态与生命周期分离**：`MEMORY_STATUSES = active | superseded | expired | retired`，与 tier 无交集（有测试断言）
- 计数分离：`retrieved` / `delivered` / `used`（+ `lastUsedAt`、`lastTransition`）
- 存放于 sidecar `.dsh-memory/memory/lifecycle.json`，与 atoms 文件独立

**迟滞**（`LIFECYCLE_THRESHOLDS`）：`hotPromote 5.0` < `hotRepromote 5.4`，`coldDemote 1.2` < `coldRepromote 1.8`。落在带内的分数不改变 tier。

**评分**（规则，不训练模型）：`used×3` + `delivered×0.8` + `retrieved×0.15` + 衰减 recency + importance + dependency − tokenCost。`retrieved` 权重最低且**单独无法晋升**（有测试：50 次检索 + 0 次使用 < `hotRepromote`）。

### 2.3 Task Intent（`core/intent.js`）

按 brief 的字段：`task_summary`（必填）、`project_id`、`affected_modules`、`operation`（封闭集）、`memory_needs`（封闭集）、`max_memory_tokens`（100–8000 钳位），另加可选 `categories`。

- 未知字段被丢弃，不进入 router prompt。
- 缺失 `task_summary` 是唯一硬失败（router 无法猜的字段）。
- 规范化字段名：内部用 camelCase，接受 snake_case 输入。

### 2.4 两阶段检索（`core/retrieval.js`）

1. **确定性召回**：project scope + category + kind + status + lifecycle + gate 排序。
2. **语义重排**：仍是既有 router subagent，只看到候选。

**跨分类补充**：`CROSS_CATEGORY_SHARE = 0.35`、`CROSS_CATEGORY_MIN = 3`。即使分类选错，候选里仍保留一部分分类外原子，**错误的颜色只损失排序，不丢记忆**。`crossCategoryRisk()` 把这个可量化：真实 run 中 `mod:lib` 严格过滤会丢掉 3 个原子。

## 3. 与 brief 的逐项对应

| brief 项 | 落地位置 | 状态 |
|---|---|---|
| 1 Semantic Color Routing | `core/category.js` | 完成 |
| 2 Memory Lifecycle | `core/lifecycle.js` | 完成 |
| 3 Task Intent Protocol | `core/intent.js` + `memory_intent` 工具 | 完成 |
| 4 Two-Stage Retrieval | `core/retrieval.js` | 完成 |
| 5 Lifecycle Scoring | `core/lifecycle.js` | 完成 |
| 6 Task Intent Cache | `core/intent.js` + `lib/semantic.js` | 完成 |
| 7 Compact Integration | `renderMemoryManifest` + `lib/index.js` | 完成 |
| 8 Observability | `core/metrics.js` + 面板 `semantic` 卡片 + `memory_metrics` | 完成 |
| 9 A/B 实验 | `tests/experiment.mjs` | 完成（4 arms） |
| 10 实施要求 | 见下 | 完成 |

**关于 SQLite**：brief 建议优先用 SQLite，但本仓库现有存储是 JSONL + sidecar，且既有 invariant 要求「保留既有数据库」。引入 SQLite 会新增迁移风险和依赖，与「增量升级、不得重写」冲突。因此复用现有存储格式，新增两个独立 sidecar（`lifecycle.json`、`metrics.json`），均可安全删除。

## 4. 观测指标（`core/metrics.js`）

覆盖 brief 要求的 10 项，但**两项诚实标为 null**：

- `recallAtK`：没有 ground-truth 相关性标注 → `null`，`measurable.recallAtK = false`
- `constraintViolationRate`：只有调用方通过 `memory_metrics({ violation: true })` 上报才可测 → `null` 直到有人上报

其余（intent 数、router 调用/延迟、category 命中率、Hot/Warm/Cold 数量、晋升/降级次数、token 成本、cache 命中率）均由真实事件计算。`deliveredWithoutUseRate` 显式区分「送达」与「确认使用」。

## 5. 测试

```
node --test "tests/unit/*.test.mjs"   →  14 pass / 0 fail
npm run test:host                     →  20/20 OK
```

新增：
- `tests/semantic.mjs` — 分类/生命周期/intent/cache/retrieval/metrics 的单元级断言（含迟滞、颜色不参与判断、未测指标为 null）
- `tests/semantic-integration.mjs` — 接缝级：开关真的拦截、COLD 不进正文但可引用、superseded 完全不注入、缓存不跨项目/版本、manifest 不含正文、sidecar 损坏只降级
- `tests/experiment.mjs` — A/B 四臂

## 6. A/B 实验

四臂，每臂相对前一臂只加一个变量：

| arm | 配置 | 结果（fixture） |
|---|---|---|
| A native compact | `routerTier off`, `injectRecall false` | 0 atoms / 0 tokens |
| B + retrieval | 经典 router 路径 | 4 atoms / 229 tokens / hot yes / off-cat yes |
| C + semantic routing | 加 category 候选 | 4 atoms / 229 tokens / off-cat **仍 yes** |
| D + lifecycle | 加生命周期门控 | 3 atoms / 188 tokens / 1 cold ref |

**结论只能是这些**：D 少花 41 tokens 且保留关键约束；C 的分类过滤没有丢掉 off-category 约束。**不能**据此声称准确率——router 全量返回也能拿「hot yes」，所以 token 与 cold ref 列才是判据。

## 7. 已知限制

1. **面板 CSS 与 Debug 视图未经肉眼验证**：本会话无法访问真实 Web UI（`127.0.0.1:62281` 返回 401，`app.asar` 不可读）。面板 `semantic` 卡片有单元测试覆盖其数据，但没有视觉确认。
2. **router 准确率仍是零实测**，不提出任何数字。
3. **分类是规则派生的**，不是模型判断。这个取舍是刻意的（保证稳定与可复现），代价是语义相近但措辞不同的记忆可能落到不同 category —— 跨分类补充检索正是为此而存在。
4. **生命周期在真实 store 上尚未运行过 sweep**（400 条全部仍是 `YOUNG`），因为没有真实使用证据。这是设计意图，不是缺陷。
5. **真实 store 已达 `MAX_LIVE_ATOMS = 400`**，新原子会挤掉旧原子；分类与生命周期不能解决容量问题。
