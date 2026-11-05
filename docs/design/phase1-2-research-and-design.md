# dsh-project-memory — 阶段 1/2 调研与架构设计

> 状态：**待用户确认**（确认后才进入阶段 3 实现）。
> 调研对象：本机 DSH 运行时 `0.2.1-rc.2`（Electron 桌面版，`resources/app.asar`），Node 24.21.0，pnpm 11.x，git 2.56.0。
> 证据分级：**【实证】**= 读真实 `.d.ts` / 真实源码 / 本机现存插件；**【文档】**= 官方文档描述；**【待验】**= 未在本机跑通。

---

## 1. 官方插件架构调研结果

### 1.1 运行时与装配模型

- DSH 是 **cordis 4.0.5** 的组合式应用：一切能力（工具、系统提示、会话、存储、FS、命令、技能）都是插件，通过 `ctx`（Cordis Context 代理）互相发现。**【实证】**
- 一个 **profile** 位于 `$DSH_HOME/profiles/<name>`，由两件东西组成：**【实证】**
  - `package.json`：`dependencies` + `dsh.profile.bundles`（有序 bundle 列表），可选 `dsh.profile.patchReload: 'live'|...`。
  - `cordis.patch.yml`：本 profile 自己的 YAML 补丁层。
- **bundle** = 一个 npm 包，其 `package.json` 声明 `dsh.bundle.patch`（一个或有序多个 YAML 文件）。profile 把这些 patch 依次叠在 `@deepseek-ai/dsh-base` 之上。**【实证】**
- 本机已有三层实例可对照：`dsh-base` + `dsh-web-app`（官方）、`@dsh-external/dsh-blender-plugin`、`@deepseek-ai/dsh-ego-browser`、`@deepseek-ai/dsh-experimental-plugin-market-bundle`。**【实证】**
- profile 里 `link:` 依赖会变成 junction（如 `desktop/node_modules/@deepseek-ai/dsh-ego-browser → C:\Users\iveri\plugins\dsh-ego-browser`）。**【实证】**
- 有一个**解析路由层**（`dsh-app-boot` 的 `ResolutionRouter` + `registerHooks`）拦截 profile 目录与 linked root 下的裸模块名，把它路由到安装目录里的同名包。**结论：`link:` 进来的插件可以静态 `import { defineTool } from '@deepseek-ai/dsh-tools'`**——现存两个 linked 插件都这么做且正在运行。**【实证】**
- 装配时会做**版本准入**：manifest 有 `engines.dsh` 则只看它；否则 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的每条 `peerDependencies` 都必须与运行版本兼容；不兼容的 bundle 被跳过并记入 `skippedBundles`（不会崩）。**【文档 + 实证 app-boot 源码】**
- `desktop` profile 被 Electron 独占管理：`dsh --profile desktop --dump-config` 直接报 `profile "desktop" is managed exclusively by the Electron application`。**【实证】** → 桌面端安装走 profile `package.json` 或 `plugin_manager` 工具，不走 CLI。

### 1.2 插件模块契约（已实证）

```ts
export const name = 'project-memory'          // 稳定插件名
export const inject = ['tools', 'systemPrompt'] // 依赖服务；缺失则延迟启动
export const Config: Schema<Config> = ...      // @deepseek-ai/schemastery
export function apply(ctx: Context, config: Config) { /* ctx.effect 自动回收 */ }
```

- 函数式插件（`name/inject/apply/Config`）与 `extends Service` 两种形态都可用；本插件用函数式。**【实证】**
- 一切注册都挂在当前 fiber 上：插件卸载即自动释放（`ctx.effect`）。**【实证 cordis context.d.ts】**
- 事件 API：`ctx.on/once`、`ctx.emit`、`ctx.parallel`、`ctx.serial`、`ctx.bail`、`ctx.waterfall`。**【实证 events.d.ts】**

### 1.3 与本插件相关的真实扩展点（全部读到真实 d.ts）

| 需求 | 官方接口 | 形态 | 证据 |
|---|---|---|---|
| 注册工具 | `ctx.tools.register(defineTool({...}))` | 返回 disposer | 【实证】`dsh-tools` `register(definition: ToolDefinition): () => void` |
| 注入上下文 / 基线记忆 | `agent/pre-step` waterfall → `PreStepDecision` | `{kind:'enter', messages, startsRequestSeries?}` 或 `{kind:'reject'}` | 【实证】`dsh-agent/runtime-types.d.ts:303` |
| 会话开始/恢复信号 | `agent/created`（`source: 'startup'\|'resume'\|'clear'\|'compact'`） | serial，可 await | 【实证】`runtime-types.d.ts:226` |
| 会话头（cwd / fork 来源 / subagent） | `session/created` → `SessionHeader` | emit（**同步抛错会回滚**） | 【实证】`dsh-session/index.d.ts:41` |
| 每个事件（做日志/统计） | `session/event` | emit，post-commit | 【实证】`index.d.ts:61` |
| 回合将结束（可异步落盘） | `agent/turn-stopping` | serial、可 await | 【实证】`runtime-types.d.ts:386` |
| 强制持久化检查点 | `session/flush` | parallel、可 await | 【实证】`index.d.ts:69` |
| 工具生命周期拦截 | `tools/pre-execute`/`execute`/`post-execute`/`result` | 见 docs | 【文档】 |
| 短指引进系统提示 | `ctx.systemPrompt.section({name, order, text})` + `.context()` | 返回 disposer | 【实证】`dsh-system-prompt/index.d.ts:250/269` |
| 斜杠命令 | `ctx.commands.register({name, description, handler})` | handler 收 `CommandInvocation` | 【实证】`dsh-commands/index.d.ts:38/94` |
| 技能 | `ctx.skills.register(...)`；磁盘技能根 `<projectRoot>/.dsh/skills`、`.agents/skills` | 目录 bundle 或平铺 `.md` | 【实证】`dsh-skill-filesystem` README |
| 受控文件读写 | `ctx.fs`（可选服务）：`resolve/stat/readText/writeText/listDir/readByteRange/watch`，写意图 `createIfAbsent` / `replaceIfVersion` | 抽象 FileSystem | 【实证】`dsh-fs/index.d.ts:61+` |
| 工作目录 | `ctx.workingDirectory.get()/ensure()` | — | 【实证】 |
| 键值/域存储 | `ctx.storage.domain` | 用 `$DSH_HOME/storages` | 【实证】base patch |
| 目标（不做） | `ctx.goals`（`dsh-goal`，会话级单一目标、CAS 更新） | 与本插件语义不同 | 【实证】 |

**关键实证 2：消息来源是可合并扩展的 sum type。**
`MessageSourceMap` 可用 `declare module '@deepseek-ai/dsh-llm'` 增补自有 `kind`（`agent-instructions` 就这么做：`kind:'agent-instructions', form:'instructions', baseline?, changes[]`）。`user/message` 的 source 标注 `@persistenceSource user developer`，即**会持久化**。这把“注入的记忆”变成可回溯、可去重、可对账的一等公民。**【实证】** `dsh-llm/message.d.ts:101` + `agent-instructions/src__state.ts:51`。

**关键实证 3：`agent-instructions` 就是本插件的参考实现。**
它在 `agent/pre-step` 里组合 baseline + delta，然后 `syncInbox(agent, claimed, desired)`：用**载荷等值**去重、扫 `agent.session.surface` 判断是否已投递、用 `agent.inbox.prepend('next-step')` 或 `inbox.replace()` 维持唯一一条。这解决了“恢复会话/压缩后重复注入”的核心难题，可直接照抄思路（不复制代码）。**【实证】** `agent-instructions/src__index.ts`。

### 1.4 明确**不存在**的能力（设计必须绕开）

- **进程退出 / 会话结束钩子：找不到。** 现有最接近的是 `agent/turn-stopping`（serial、可 await）与 `session/flush`（parallel、可 await）。**【实证：遍历 dsh-session / dsh-agent 全部事件声明】** → 结论：**状态落盘必须由显式工具驱动 + 回合边界机会式加固**，不能依赖“退出时保存”。
- `tools/*` 与 `agent/request` **不能改写消息内容**（`agent/request` 注释明确“cannot mutate messages”）。**【实证】** → 上下文注入只有 `agent/pre-step` / `agent.inbox` / 系统提示三条路。
- 没有插件的 UI 插槽义务：`dsh.client` 是可选面，MVP 不做客户端 UI。**【实证：blender 插件有 client 面，ego-browser 没有】**

---

## 2. 可以实际使用的扩展点（落到本插件的 11 个逻辑能力）

| 逻辑能力 | 落地方式 | 是否 MVP |
|---|---|---|
| `project.init` | 工具：写 `.dsh-memory/{project.json,config.json,index.json,state/}`；**只创建不改写** | ✅ |
| `project.inspect` | 工具：git/目录/配置/索引/状态汇总 | ✅ |
| `memory.bootstrap` | `agent/created` 预计算快照 + `agent/pre-step` 注入 L0/L1 | ✅ |
| `memory.search` | 工具：索引内关键词/路径/标题/标签检索（无向量库） | ✅ |
| `memory.read` | 工具：按 path + 章节读，回传 `path@hash, kind, status` | ✅ |
| `state.get` | 工具：读 `state/current.json` + 陈旧度判定 | ✅ |
| `state.update` | 工具：CAS 合并写（`rev` 递增）+ 原子替换 + 幂等 | ✅ |
| `state.handoff` | 工具 + `/memory-handoff` 命令：生成交接摘要并落盘 | ✅ |
| `docs.check` | 工具：frontmatter/索引/死链/保护区一致性检查（确定性） | ✅ |
| `docs.sync` | 工具：**只生成提案**到 `docs/proposals/`，不自动改权威文档 | ✅（受限） |
| `architecture.check` | 工具：确定性规则（禁止依赖边/分层/禁用 API）出机器判据，LLM 仅建议 | MVP 简化版 |
| 事件自动研究 | ❌ 无“官方研究触发事件” → 全部走显式工具/命令 + `agent/pre-step` 读快照 | — |

工具名（已比对现有工具目录，无冲突）：

```
memory_status  memory_bootstrap  memory_search  memory_read
state_get      state_update       state_handoff
project_init   project_inspect    docs_check     docs_sync
architecture_check
```

斜杠命令：`/memory-status`、`/memory-handoff`、`/memory-sync`、`/architecture-check`。

---

## 3. 推荐的插件内部模块结构

```
dsh-project-memory/
├── package.json            # name/version/type:module/main/exports/dsh.bundle.patch/engines.dsh/peerDeps
├── cordis.patch.yml        # - insert: [{id: project-memory, name: '@…/dsh-project-memory'}]
├── README.md
├── lib/
│   └── index.js            # 唯一的 host 入口（ESM，无构建步骤的直接发布形态）
├── src/
│   ├── index.ts            # 插件入口：name / inject / Config / apply；只做装配
│   ├── config.ts           # Schemastery Config + 运行期归一化（宽容缺省）
│   ├── project.ts          # 项目识别：git toplevel / realpath / projectId / branch / HEAD / worktree
│   ├── store.ts            # 文件层：路径包含校验、原子写、加锁、JSON 读写、schema 版本迁移
│   ├── state.ts            # System B：current.json + journal.jsonl，CAS/幂等/合并策略
│   ├── indexer.ts          # System A：扫描 docs/**，frontmatter 归类，生成 index.json（可重建）
│   ├── search.ts           # 纯函数检索与排序（标题/路径/标签/词频），无外部依赖
│   ├── context.ts          # L0–L3 预算裁剪 + 渲染（带 path@hash/kind/status 溯源）
│   ├── inject.ts           # agent/created 快照 + agent/pre-step 注入 + inbox 去重同步
│   ├── guard.ts            # 保护区、路径穿越、symlink 逃逸、大小上限、注入内容消毒
│   ├── arch.ts             # 确定性架构规则引擎（import 图边检查）
│   ├── tools/
│   │   ├── memory.ts state.ts project.ts docs.ts arch.ts
│   │   └── shared.ts       # defineTool 封装、输出 schema、渲染
│   ├── commands.ts         # 斜杠命令
│   └── prompt.ts           # systemPrompt.section 的一段短指引（何时用哪些工具）
└── tests/
    ├── unit/*.test.mjs     # node --test，纯函数 + 临时目录
    ├── fixtures/sample-project/{battle,skill,attribute}/…
    └── integration/*.mjs   # profile 装配 + 真实 CLI 往返（可选/需确认）
```

设计约束：

- **无第三方运行时依赖**（除 peer 的 cordis/schemastery 与 dsh 包），不引入数据库、不引入向量库、不联网。
- **纯 JS 可运行**：所有业务逻辑放在不 import DSH 包的模块里，宿主适配层（`index.ts`/`inject.ts`/`tools/*`）单独薄封装 → 单元测试不需要 DSH 环境。
- 只读逻辑（index/search/context 裁剪）与写逻辑（state/store）分离，便于分别测试与分别发权限。

---

## 4. 双系统数据模型

### 4.1 项目身份（稳定 ID，与目录名无关）

```
projectId = .dsh-memory/project.json 里的 uuid v4（首次 init 生成，永不变）
身份锚点  = realpath(git toplevel) 或 realpath(cwd)（无 git 时）
辅助事实  = git remote URL（可空）、worktree 路径、默认分支
```

- 判定顺序：显式配置 `projectRoot` → `SessionHeader.cwd` 向上找最近的 `.git` → `cwd` 本身。**【实证：`dsh-skill-filesystem` 用同一规则，说明项目根语义在 DSH 内是一致的】**
- 已发现的现实问题：**当前工作区 `D:\iverins_workspace\dsh-memory` 不是 git 仓库**（`git rev-parse` 失败）→ 无 git 场景必须是一等公民，不能当异常分支。
- `.dsh-memory/project.json` 被移动/复制到别处时，`projectId` 冲突由 `projectInit` 检出并提示（写入 `machineHint`，不自动改）。

### 4.2 System A —— 文档知识系统（Markdown 为真相源）

| 目录/文件 | 角色 | 谁可写 | 状态标签 |
|---|---|---|---|
| `AGENTS.md` | 项目宪法/硬规则 | **仅人类**（插件永不改写） | `current` |
| `docs/knowledge/**` | 现行规格真相源 | 人类 + 经批准的提案落地 | `current` / `deprecated` |
| `docs/proposals/**` | 未确认提案 | AI 可写 | `proposal` |
| `docs/history/**`、`CHANGELOG.md` | 历史与已完成变更 | 人类/合入流程 | `history` |
| `docs/adr/**` 或 `docs/decisions/**` | 已批准决策（**不可自动改写**） | 仅人类 | `accepted` |
| `.dsh-memory/index.json` | **派生索引，可删可重建** | 插件 | — |

文档元数据（frontmatter，全部可选但推荐）：

```yaml
---
title: 战斗结算规则
status: current        # current | deprecated | proposal | history
kind: spec             # spec | guide | decision | proposal | history
tags: [battle, damage]
supersedes: docs/knowledge/old-battle.md
---
```

分类规则（确定性、可测试）：`kind/status` 显式优先 → 目录映射（`proposals/`→proposal，`history/`→history，`adr|decisions/`→decision/accepted）→ 默认 `current/spec`。
每条索引项包含：`path, title, kind, status, tags, headings[], hash(sha256 前 12), size, mtime, supersedes/supersededBy`。

### 4.3 System B —— 开发状态系统（`state/current.json`）

```jsonc
{
  "schema": 2,
  "rev": 17,                       // CAS 乐观锁：写入必须带 baseRev
  "projectId": "5f0c…",
  "updatedAt": "2026-01-01T00:00:00Z",
  "updatedBy": { "sessionId": "…", "source": "tool|command|turn-stopping" },
  "git": { "branch": "feat/battle", "head": "a1b2c3d", "dirty": true,
           "worktree": "D:\\…", "detached": false },
  "task":   { "id": "T-014", "title": "战斗结算重构", "status": "in_progress", "phase": "3/5" },
  "progress": { "summary": "伤害公式已迁移，技能链未接",
                "lastVerifiedAt": "…", "verifiedBy": "test|manual|null" },
  "next":      [ { "step": "接技能链结算", "why": "T-014 阻塞项" } ],
  "blockers":  [ { "text": "缺少技能表导出", "since": "2026-01-01" } ],
  "decisions": [ { "id": "D-3", "text": "伤害走整数定点", "ref": "docs/decisions/0003-damage.md" } ],
  "invariants":[ "禁止在 UI 层直接算伤害" ],
  "touched":   [ { "path": "src/battle/damage.cs", "why": "公式迁移" } ],
  "openQuestions": [ "技能链是否仍需兼容旧存档？" ]
}
```

写入规则（全部确定性、可单测）：

1. **原子**：同目录临时文件 + `rename`（跨盘 rename 会失败，故 temp 必须同盘同目录）。
2. **幂等**：内容哈希相同则不改 `rev`、不写盘、返回 `unchanged`。
3. **CAS**：调用方给 `baseRev`；不等则返回 `conflict` + 当前 `rev` 与差异摘要，绝不静默覆盖。无 `baseRev` 时按“字段级合并 + 追加型字段去重”写。
4. **并发**：`.dsh-memory/state/.lock`（O_EXCL + 过期时间），优先复用 `@deepseek-ai/dsh-atomic-write` 的 `writeFileAtomic`/`withFileLock`（该包在本机 profile 中存在，**导入可行性【待验】**）。
5. **审计**：每次写追加一行到 `state/journal.jsonl`（`{ts, rev, op, fields, by}`），可回溯、可重放。

### 4.4 陈旧度（staleness）判定

`state.git.{branch,head,dirty}` 与当前 git 事实比对，得出：

| 情况 | 判定 | 注入策略 |
|---|---|---|
| branch 与 head 都相同 | `fresh` | 注入全部 L0/L1 |
| branch 同、head 不同 | `advanced` | 注入 L0 + 提示“HEAD 已前进，请核对” |
| branch 不同 / detached | `branch-changed` | 只注入 L0（任务片段降级为“参考”） |
| 无 git 信息 | `unknown` | 只注入 L0，并明说不确定 |

### 4.5 上下文预算（L0–L3）

| 层 | 触发 | 预算 | 内容 |
|---|---|---|---|
| **L0** | 每个新会话（`startup/resume/clear/compact`）自动 | ≤ 300 tokens | projectId/名字、branch@head、任务一行、头号不变量、可用工具一行 |
| **L1** | 同 L0（若 `fresh`） | ≤ 1200 tokens | L0 + next/blockers/decisions + `current` 文档标题清单（只标题不正文） |
| **L2** | 工具按需 | 单次 ≤ 2000 tokens | `memory_search`/`memory_read` 的具体片段，附 `path@hash` |
| **L3** | 显式请求 | 不限但强制分页 | 整篇文档、diff 摘要、历史目录 |

每条注入内容都带溯源：`[docs/knowledge/battle.md@a1b2c3 current/spec]`。
超出预算时按固定优先级截断：`invariants > task > next > blockers > decisions > 文档标题`，并在末尾写明“已截断 N 项，用 memory_search 取详情”。

---

## 5. 新会话初始化 / 上下文恢复流程

```
① 会话创建
   session/created → 读 SessionHeader.cwd（拿不到就 ctx.workingDirectory.get()）
   监听器绝不同步抛错（会回滚会话）

② agent/created { source }
   ├─ 解析项目根（配置 → .git 向上 → cwd）
   ├─ projectId（有 project.json 用它；否则标记 uninitialized）
   ├─ git 事实（branch/HEAD/dirty/worktree）；无 git 则 unknown
   ├─ 读 state/current.json + 判定 staleness
   └─ 缓存 MemorySnapshot（含 index 的标题清单，hash 校验，避免每次重扫）

③ agent/pre-step（本会话首步，或快照脏了）
   ├─ 按 L0/L1 预算渲染文本
   ├─ createUserMessage({ content, source: { kind:'project-memory',
   │     form:'baseline'|'delta', projectId, baselineIdentity, changes[], paths[] } })
   ├─ 与 baseline 去重：载荷等值 + 扫 session.surface 是否已投递（不做第二次注入）
   └─ 除首步外只发 delta（状态/分支/文档 hash 有变才发）

④ 会话中途
   ├─ 工具调用（memory_search/read/state_update/…）→ 即时生效、可审计
   └─ agent/turn-stopping（serial, await）→ 机会式把 git 事实与 lastActivity 刷新到 journal
                                              （不写业务字段，避免“AI 偷偷改状态”）

⑤ 恢复（source = 'resume' | 'clear' | 'compact'）
   ├─ 重新走 ②③，并对比 baselineIdentity：不一致则整块重发 baseline 而不是 delta
   └─ 若 compaction 之后 surface 里原 baseline 已被 replace 掉 → 允许重发（这正是要
       按 surface 扫描而不是只按内存标记判断的原因）
```

降级路径（都必须可用且明确提示）：无 `.dsh-memory/` → 只注入一次“此项目未初始化，可运行 project_init”。
无 git → L0 里 branch/head 显示 `n/a`。状态损坏（JSON 解析失败）→ 不抛错、把损坏文件改名 `.corrupt-<ts>` 并返回可操作提示。

---

## 6. MVP 实施计划

| 阶段 | 交付 | 验收（**必须真跑**） |
|---|---|---|
| **3.1 骨架** | `package.json`、`cordis.patch.yml`、`name/inject/apply/Config`、空工具集 | `node -e "import('./lib/index.js')"` 成功；`dsh --profile <new> --dump-config` 出现本插件行 |
| **3.2 文件层** | `store.ts`（原子写/锁/路径包含/大小上限）、`project.ts` | 单测：并发 20 写不丢、路径穿越被拒、symlink 逃逸被拒、无 git 场景 |
| **3.3 System B** | `state.ts` + `state_get/state_update/state_handoff` | 单测：幂等、CAS 冲突、损坏恢复、journal 追加；临时项目端到端 |
| **3.4 System A** | `indexer.ts` + `search.ts` + `memory_search/memory_read/docs_check` | 单测：分类规则、hash 变更检测、检索排序、500 篇文档索引 < 500ms |
| **3.5 上下文** | `context.ts` + `inject.ts` + `prompt.ts` | 单测：L0/L1 不超预算、截断顺序、staleness 四态；**真实 headless 会话看注入是否出现且不重复** |
| **3.6 其余工具** | `project_init/project_inspect/docs_sync` + 命令 | 单测 + 临时项目端到端；`docs_sync` 断言“未改权威文件” |
| **3.7 集成** | 用 `dsh --profile <新 profile> --from-default-profile headless` 装 `link:` 后跑一轮真实任务 **【待验】** | 断言：工具可见、baseline 注入一次、`state_update` 落盘、重启后 `resume` 不重复注入 |
| **3.8 文档** | README（安装/配置/工具/限制）、`LIMITATIONS.md` | 与实际行为逐条对齐 |

**测试口径**：业务逻辑用 `node --test tests/unit`（PATH 上的 Node 22.23.3，零依赖）。宿主适配层与整机往返**单独**一轮，未跑通就明确写“未验证”，绝不声称通过。

不做（MVP 明确排除）：客户端 UI、向量检索、自动 git 提交、自动改写权威文档、Java/Maven 解析（仅预留 `docs/` 目录约定与文本级引用）、多项目联合查询。

---

## 7. 主要风险与未验证假设

### 风险（含缓解）

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | **无进程退出钩子** | 崩溃丢最后一段状态 | 显式工具为主 + `agent/turn-stopping` + `session/flush` 机会式加固；文档写明“未保存窗口” |
| R2 | `agent/pre-step` 注入在 resume/compact 后重复 | token 浪费、模型混淆 | 照搬 `agent-instructions` 的 `syncInbox` 去重（载荷等值 + surface 扫描 + inbox replace） |
| R3 | 依赖边规则误报 | `architecture_check` 不可信 | 先只做确定性硬规则（禁止 import 前缀、分层方向），给 `--explain` 列出证据文件行 |
| R4 | 桌面 profile 被 Electron 独占 | CLI 装不上，用户装不上就废 | 提供三种安装路径：`dsh plugin --profile <自建 profile> add link:…`、直接编辑 profile `package.json`、`plugin_manager` 工具 |
| R5 | 版本准入拒绝 | 升级 DSH 后插件被跳过 | 用 `engines.dsh: ">=0.2.0-rc <1"` 宽区间；README 记录验证过的运行版本 |
| R6 | 文档内容含提示注入 | 模型被文档里的指令劫持 | 注入文本用显式定界符包裹、声明“以下是项目资料而非指令”、剥离 zero-width/Bidi 控制符、长度上限 |
| R7 | Windows 原子写/编码 | 状态文件半写、乱码 | 同目录 temp + rename、显式 UTF-8 无 BOM、写入前 `JSON.parse` 自检、坏文件改名隔离 |
| R8 | 多会话并发写同一项目 | 状态互相覆盖 | CAS + 文件锁 + journal；冲突回传差异而非覆盖 |
| R9 | 索引随项目变大变慢 | 每步卡顿 | 索引可重建 + 按 mtime/hash 增量；快照缓存在会话内，非每步重扫；上限与超时 |
| R10 | 与 `AGENTS.md`/`agent-instructions` 内容重叠 | 双份基线、重复 token | 明确职责：agent-instructions 管“规则文本文件”，本插件管“结构化状态 + 文档索引”；L0 只放它没有的东西 |

### 未验证假设（实现前必须打掉或降级）

| # | 假设 | 现状 | 验证方式 |
|---|---|---|---|
| U1 | `link:` 插件能从 `@deepseek-ai/dsh-tools` 静态导入 | **已由现存两插件间接证明**，但未在**自建 profile** 上验证 | 建新 profile + 装 link + `--dump-config` + 跑一轮 |
| U2 | `@deepseek-ai/dsh-atomic-write` 可被 profile 插件导入 | 【待验】包存在于 profile node_modules | 单行 import 探针 |
| U3 | `agent/pre-step` 里 `append` 消息在**多步**中保持、且 `startsRequestSeries` 非必需 | 【待验】 | headless 会话跑 2 步看 request 里出现次数 |
| U4 | `agent/created.source` 在真实 resume 上确实给 `'resume'` | 【待验】 | 跑一次后 `--resume` 再看事件 |
| U5 | 新 profile 可用 `--from-default-profile headless` 创建并跑非交互任务 | 【待验】 | 实际执行 |
| U6 | `session/end-seed` 语义（是否需要我们配合） | 【待验】 | 读类型 + 实测 |
| U7 | `ctx.fs` 在 headless 下可用（不可用则退化为 node:fs） | 【待验】 | 启动时探测 |
| U8 | 文档 frontmatter 现状（真实项目是否已有 `status:`） | 未知 | 首个真实项目跑 `docs_check` 统计 |

### 需要在实现前由你确认的决策

1. **状态是否默认「仅在显式工具调用时写」**（我推荐：是；AI 不得自动改 `task/blockers`，只能追加 `journal` 与 `touched`）。
2. **`docs_sync` 的边界**：只产提案（推荐）还是允许直接改 `docs/knowledge/**`？
3. **MVP 是否包含 `architecture_check`**：包含则给出该游戏项目的分层规则表；不包含则挪到 MVP 之后。
4. **安装方式**：为桌面端单独建一个 profile（如 `pm-dev`），还是在现有 `desktop` 里加依赖（后者需重启、且 Electron 独占）。
5. **是否需要 `Java/Maven/Gradle/Javadoc` 支持进入 MVP**（我推荐：不进，仅预留目录约定）。
