# 项目记忆面板：UI/UX 重构与滚动/导航修复

## 1. 根因（用真实浏览器确认，不是推测）

**滚动**：宿主的 main 区域可能是 `overflow: hidden`。我用真实 Chromium 复现：

| 条件 | 面板高度 | 视口 | 可达 |
|---|---|---|---|
| 宿主 main 可滚动 | 3548px | 889px | 全部可达 |
| 宿主 main `overflow:hidden` | 3548px | 889px | **2659px 不可达** |

旧 CSS 是 `.pm-panel { display:flex; flex-direction:column; padding:…; max-width:760px }` ——
**没有高度约束，没有 `min-height:0`，没有 `overflow-y:auto`**。整棵树里没有任何元素是滚动容器，
所以当宿主不替我们滚动时，内容就永久被裁掉。滚轮、触控板、键盘全部无效，因为无处可滚。

**导航**：面板从未使用槽位提供的 `close`，也没有返回控件，因此进入后无路可回；页面也没有标题、
面包屑或刷新入口。

**信息架构**：所有内容纵向堆在一个 `.pm-panel` 里，统计数据与配置控件混排，没有分区、没有分页、
没有详情视图。

## 2. 修复方式

### 滚动（P0）

```css
.pm-root { display:flex; flex-direction:column; height:100%; min-height:0; overflow:hidden; }
.pm-toolbar { flex:0 0 auto; }   /* 不收缩 */
.pm-tabs    { flex:0 0 auto; }   /* 不收缩 */
.pm-body    { flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain; }
```

`min-height: 0` 是关键：flex 子项默认不肯收缩到内容高度以下，缺了它子项会长到 3548px 而永不溢出。
`overscroll-behavior: contain` 让滚到底的滚动不再传递给后面的页面。

**没有用隐藏内容来掩盖问题**：内容高度不变，只是现在有了真正的滚动容器。

### 导航（P0）

工具栏包含：返回、面包屑（`项目记忆 / <最后两级路径>`）、标题、项目路径、刷新、设置。
返回调用宿主提供的 `props.close`，**不使用 `history.back()`**（在 Electron 里可能离开应用）。
槽位没有提供 `close` 时按钮不渲染，而不是退回到不安全的方式。

### 页面结构

| 标签页 | 内容 |
|---|---|
| 概览 | 有效记忆、常驻约束、Hot/Warm/Cold、容量、最近压实、最近路由、容量明细、项目选择器 |
| 记忆浏览 | 搜索（160ms debounce）、类型/分类/生命周期/状态筛选、排序、分页（每次 +40）、详情抽屉 |
| 压实记录 | 时间线，可展开每次压实的 added/updated/unchanged/摘要大小/跳过原因 |
| 路由轨迹 | 各指标；后端未采集的显示"未采集"，不编数字 |
| 设置 | 路由控件（可编辑）+ 语义/生命周期开关（只读，注明在 profile 改）+ 容量明细 |

### 动效

| 场景 | 时长 |
|---|---|
| 页面切换 | 190ms fade + 4px 上移 |
| 卡片 hover | 120–130ms |
| 抽屉滑入 | 190ms cubic-bezier |
| 展开收起 | 170ms |
| 按钮/tab | 120–150ms |

全部为 CSS transition/animation，无新依赖。所有动画都有 `@media (prefers-reduced-motion: reduce)` 对应块
（`tests/ui.mjs` 断言至少 3 个，且单个时长 ≤ 220ms）。

### 详情抽屉

显示 ID、内容、类型、分类、生命周期、状态、优先级、检索/交付/使用计数、创建/更新时间、
关联文件、标签、来源。交互：Escape 关闭、遮罩点击关闭、打开时焦点进入抽屉、Tab 焦点循环、
`role="dialog"` + `aria-modal`。来源失效时明确显示"原始来源不可用"，而不是留空。

### 容量

不再把 Cold 描述为已删除。区分四个数：有效 / 已归档 / 已遗忘 / 总记录，
并说明「已达到上限：新原子会挤掉较弱的旧原子，旧原子不会从磁盘删除」以及
「Cold 记忆仍在存储中，只是默认不注入上下文」。**未改动任何淘汰算法。**

## 3. 修改文件

| 文件 | 变化 |
|---|---|
| `client.js` | 样式表 7584→15482 字节；新增 ~30 个组件；`MemoryPanel`→`MemoryDashboard`；字典改为只含在用键 |
| `lib/panel.js` | 新增 `buildExplorerCard`（记忆列表 + 分类/生命周期）、`buildCapacityCard`（四类容量） |
| `package.json` | `test:host` 增加 `tests/ui.mjs` |
| `tests/ui.mjs` | 新增：滚动契约、动效预算、导航安全、筛选/分页、抽屉可访问性、诚实性 |
| `scripts/*.mjs` | 新增 8 个：应用改写、i18n 审计/裁剪、渲染验证、静态服务 |

## 4. 测试结果（真实执行）

```
node --test "tests/unit/*.test.mjs"   →  14 pass / 0 fail
npm run test:host                     →  21/21 OK, exit 0
```

**真实浏览器测量**（Chromium，宿主 `overflow:hidden`）：

```
hostMainOverflow      hidden
bodyOverflowY         auto
bodyMinHeight         0px
rootHeight            850px
bodyScrollable        true
maxScroll             3712   （滚轮/键盘可达底部）
atBottom              true
lastAtomFullyVisible  true
toolbarStayedPut      true
horizontalOverflow    false
```

多尺寸（1280×800 / 1440×900 / 1920×1080 / 1024×700 / 820×620）：无横向溢出，
无元素越出右边界，body 始终可滚动。

抽屉：`drawerWithinRoot true`、`scrimCoversRoot true`、`contentScrolls true`（max-height 240px）、
`zOrderDrawerAboveScrim true`、关闭按钮可聚焦。

## 5. 未验证 / 限制（必须说明）

1. **React 运行时行为未经真实点击验证。** 真实 Web GUI 需要凭据（`127.0.0.1:52525` 返回 401），
   `app.asar` 不可读。我验证的是**真实样式表 + 等价标记**在真实浏览器里的布局与几何，
   **不是** React 组件的实际挂载、状态更新与事件处理。后者的保证来自源码级测试（`tests/ui.mjs`）
   与 `tests/client.mjs`，不是运行时观测。
2. **截图未能取得。** Playwright 截图两次返回同一张近乎空白的帧（sha256 相同），
   而同期 DOM 查询证明元素可见、颜色正常、动画已 finished；chrome-devtools 截图两次超时。
   我没有用这些截图做任何判断，也无法提供可信的视觉截图。
3. **宿主插槽的真实尺寸未知。** 我用的是模拟外壳（固定侧栏 + 主区）。真实宿主若给 `main`
   一个有明确高度的容器，效果相同；若它本身已经滚动，则会出现双层滚动条——
   `overscroll-behavior: contain` 让它不至于"滚动锁死"，但这一点无法在此环境验证。
4. **键盘滚动未逐键实测**，只验证了容器可滚动 + 内容为原生可聚焦按钮，
   因此 PageDown/方向键走的是浏览器默认行为。
5. **筛选/分页在真实浏览器里未逐项点击**；数据侧由 `lib/panel.js` 的单元行为与
   `tests/panel.mjs` 覆盖，交互侧由 `tests/ui.mjs` 源码断言覆盖。

## 6. 未改动

Memory Router 算法、Compact 逻辑、Memory 数据语义、插件 API、淘汰算法均未触碰。
新增依赖：0。
