# dsh-project-memory

**Languages:** English · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · [Español](./README.es.md)


Project-level persistent knowledge and development-state memory for [DeepSeek Harness](https://github.com/deepseek-ai).

## The problem, in plain terms

An AI coding agent has no memory between sessions. Every conversation starts blank, so:

- you explain the same project structure again;
- it re-reads the same documents;
- it re-makes a decision you already settled last week;
- it repeats a mistake it already hit.

There is also a quieter version of the same problem **inside** one session. When the
context gets long, the harness compacts it: the original messages are replaced by a
summary. Context stays affordable, but the summary is lossy — details, exact values and
the reasoning behind a choice that did not fit are gone for good. On a measured 588 k-token
history the summary came out at ~2 k tokens, which is not the same information at all.

This plugin gives a project a memory that lives **in the repository**, not in a context
window.

## How it works

Three storage systems, each with a different job. The split is deliberate: what you
*wrote*, what you *are doing*, and what you *decided* have different lifetimes, and a
single blob would serve all three badly.

| system | holds | written by | survives |
|---|---|---|---|
| **A — documents** | the Markdown you already have | you, in git | everything |
| **B — state** | task, progress, blockers, decisions | `state_update` / `state_handoff` | restarts and compactions |
| **C — atoms** | short durable statements | compaction observer + `memory_remember` | restarts and compactions |

The interesting part is **C**, and how it is read back.

```
  long session
        │
        ├─── context fills ──▶ harness compacts ──▶ summary (lossy)
        │                                              │
        │                                              └──▶ what the model sees now
        │
        └─── each compaction also writes short atoms ──▶ .dsh-memory/memory/atoms.jsonl
                                                              │
   next request ──▶ match the request against the store ──────┘
                        │
                        └──▶ a few atoms that fit the budget, not the whole store
```

Four properties make that cheap enough to run every step:

1. **Sparse, not dumped.** A handful of atoms out of hundreds, ranked for *this* request.
   A hard token ceiling applies, so cost is bounded by configuration rather than by
   project size.
2. **Recorded, not scraped.** System B is written by tool calls. An agent that never calls
   `state_update` gets no state memory — the plugin does not silently harvest your
   conversation.
3. **Rules outrank relevance.** An atom carrying a hard constraint is selected *before*
   any scoring runs, and a router cannot remove it. A rule that only applies when you
   happen to mention it is not a rule.
4. **Selection never writes.** The optional router subagent may only answer with ids that
   were offered to it; an id it invents is discarded. Memory mutation stays with
   deterministic code, so a hallucination cannot corrupt the store.

A subagent can act as that router when lexical matching is not enough. It is off by
default (`smart` with no model configured costs nothing).

## Measured: what compaction loses, and what recall buys back

Numbers below come from a real run on
[CodeMemo](https://huggingface.co/datasets/laynepro/codememo-benchmark), 40 questions per
project, model and judge `deepseek-v4.1-flash`, temperature 0. Three arms see the same
question; only the history differs.

| arm | context given to the model |
|---|---|
| **A** | the compaction summary only (~1.3 k / ~2.0 k tokens) |
| **B** | the last 6 k tokens of raw transcript |
| **C** | the same summary, plus the atoms recalled (~0.4 k tokens) |

Pooled over 80 questions:

| arm | correct | 95% CI | partial credit |
|---|---|---|---|
| A — summary only | 16.3% | 9.7–25.8% | 32.5% |
| B — tail only | 15.0% | 8.8–24.4% | 20.0% |
| **C — summary + recall** | **25.0%** | 16.8–35.5% | **41.9%** |

| comparison | difference | 95% CI |
|---|---|---|
| C − A | **+8.8 pp** | −0.7 … +18.2 |
| C − B | **+10.0 pp** | −1.0 … +21.0 |
| B − A | −1.3 pp | −10.7 … +8.2 |

Split by history length, which is where the shape of the problem becomes visible:

| project | history | A | B | C |
|---|---|---|---|---|
| `project_01` | 17 k tokens | 30.0% | 30.0% | **40.0%** |
| `project_02` | 588 k tokens | 2.5% | 0.0% | **10.0%** |

**Read this honestly.**

- When the history nearly fits (17 k tokens), a summary is *as good as* the raw recent
  text: A and B are identical at 30.0%. Compaction is not the bottleneck there.
- When it does not fit (588 k tokens), every arm collapses — and memory collapses least
  slowly. The absolute numbers are low for all three.
- **The confidence intervals include zero.** +8.8 pp with an interval of −0.7 … +18.2 is
  consistent with anything from no effect to a ~18-point effect. Two projects and the
  partial-credit score all lean the same way, which is reason to run a larger sample —
  not reason to quote a number as established.
- Recall still improves *partial* answers (32.5% → 41.9%), i.e. context gets closer to
  sufficient without becoming sufficient.

What this does **not** measure: routing quality (`routerTier: 'off'`), or "how much text
compaction permanently destroys" — every question's answer exists somewhere in the raw
transcript, so the measured quantity is *retrievability under a budget*. Full method,
per-question data, and the defects found while building it:
[`docs/design/benchmark-compaction-loss.md`](./docs/design/benchmark-compaction-loss.md).

It is a **host-only [cordis](https://github.com/deepseek-ai/cordis) plugin**: it registers agent tools, a system-prompt section, and slash commands. It also ships one small **Client half** — a sidebar panel, which reads the host over two loopback routes and adds nothing to the host's work. No change to DSH itself.

```
MIT licensed · Node 20+ · host-only plugin + one sidebar panel
```

---

## Contents

- [The problem, in plain terms](#the-problem-in-plain-terms)
- [How it works](#how-it-works)
- [Measured: what compaction loses, and what recall buys back](#measured-what-compaction-loses-and-what-recall-buys-back)
- [Three systems, on purpose](#three-systems-on-purpose)
- [What it will not do](#what-it-will-not-do)
- [Install](#install)
- [Tools](#tools)
- [Storage layout](#storage-layout)
- [Verifying](#verifying)
- [Configuration](#configuration)
- [Per-project settings](#per-project-settings)
- [Project layout](#project-layout)
- [Known limitations](#known-limitations)
- [License](#license)

---

## Three systems, on purpose

The table in [How it works](#how-it-works) states what each system is *for*. This
section states the design decisions behind them, which is where the disagreements usually
are.

**System A — documentation knowledge.** Markdown in the repository is the source of truth. The plugin indexes it, searches it, and reads named sections. It never rewrites your authoritative docs; when it proposes a change it writes to `docs/proposals/`.

**System B — development state.** Persisted only by a tool call. The rule is that the plugin never scrapes a conversation to guess what you are doing: an agent that does not call `state_update` gets no state memory, which is a visible failure rather than a quietly wrong one.

**System C — memory atoms.** Extracted from compaction summaries and from rules the user states outright, then *selectively* recalled into the next request. A checkpoint summary replaces the original turns, and everything it drops is gone; atoms give that content a second life outside the context window, retrieved by relevance rather than by having been lucky enough to survive the summary. [Measured above](#measured-what-compaction-loses-and-what-recall-buys-back): +8.8 pp on answered questions, and a much larger effect on a 588 k-token history than on a 17 k-token one.

Recall follows a sparse-gating pattern rather than a dump. Scoring is deterministic (lexical overlap, kind priority, reinforcement, recency), the selection is sparse (few atoms out of many, ranked), and the cost is bounded (a hard token ceiling). That is the MemGPT arrangement — the context window as working memory, the store as the larger memory space, exchanged on demand — expressed as a mixture-of-experts gate: kinds are experts, atoms compete within an expert, and the softmax decides which experts are active for *this* request.

A subagent can serve as the router when lexical scoring is not enough. Three tiers:

| `routerTier` | Behavior | Cost |
| --- | --- | --- |
| `off` | Deterministic gating only. | Free |
| `smart` (default) | Deterministic gating, escalating to the router only when it selected nothing relevant or matched weakly. | Near-free; a call only when the cheap path failed |
| `always` | Every step asks the router subagent. | One call per step — pair it with a cheap model |

`smart` costs nothing until `routerProvider` **and** `routerModel` are both set, so the plugin spends no model calls out of the box. The **strategy** (`routerStrategy`) decides what the router is asked to prioritise — `task`, `compliance`, or `orient` — so two profiles with the same atoms and the same tier can still recall differently.

### Two independent properties

An atom has a **weight** (1–5: how important it is) and a **standing** flag (whether it is a rule that must hold). They are separate on purpose, and conflating them was a real bug:

- weight is a *ranking* input — a high-weight fact outranks a low-weight fact;
- standing is an *eligibility* input — a standing rule is kept **even when it does not match the current request**, because a rule that only applies when you happen to mention it is not a rule.

Standing is decided by kind (`constraint`), never by weight. `STANDING_MIN_WEIGHT` was the old gate and is now deprecated: it silently dropped every constraint stored at weight 2, which on a real store meant 32 of 66 hard rules were ineligible. Standing atoms still obey the count and token caps — a budget share, not an exemption — so this is not a rules wall; on a measured real recall only one atom was kept *purely* on standing, and the rest genuinely matched.

The router cannot override this. Standing atoms are selected before the router is consulted, and a router that answers with nothing (or answers badly, or times out) leaves them in place. The router chooses what to *add*, never what to *remove*.

## What it will not do

- It will not modify `AGENTS.md`, `docs/decisions/`, `docs/adr/`, or `.git/`. `docs_sync` refuses those paths and names the refusal.
- It will not commit, branch, or push. It records git facts; it does not perform git operations.
- It will not silently invent state. Every mutation goes through `state_update` with a compare-and-set revision, and concurrent writes conflict instead of overwriting.

---

## Install

Clone it first:

```
git clone https://github.com/iv3rins/dsh-memory.git
```

One command. The host adds the dependency **and** the bundle entry itself, because the manifest declares `dsh.bundle` — `reconcileProfilePlugins()` promotes any newly installed dependency that carries one.

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add -w "link:D:\path\to\dsh-memory"
```

Restart the host afterwards. Verify with `project_inspect`: the project root and an indexed document count mean the plugin is live.

Editing the profile by hand also works (`dependencies` entry plus a `dsh.profile.bundles` entry), but it is the slower path and easy to get half-right — a dependency without the bundle entry installs and then never loads.

pnpm warns that a `link:` dependency does not resolve peers from the target's `node_modules`. That is expected and harmless here: this plugin has no runtime dependencies, and its one peer (`@deepseek-ai/dsh-llm`) is supplied by the host.

The bundle patch (`cordis.patch.yml`) inserts one row:

```yaml
- insert:
    - id: project-memory
      name: '@dsh-external/dsh-project-memory'
```

Config can be supplied on that row if the defaults do not fit:

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

### Upgrading

`engines.dsh` is `>=0.2.0-rc.0 <0.3.0`. It is deliberately narrow rather than open: a minor host release can change the tool-schema subset or the injected message shape, and this plugin would then fail *silently at mount* rather than loudly at install. The range states what has actually been tested (0.2.1-rc.2); widen it after re-running the suite against a newer host.

When `engines.dsh` is present the host reads **only** it and ignores `peerDependencies` ranges entirely (`unmetRequirements` in `dsh-app-boot`). The peer entry is kept as a declaration of what the package imports at runtime, not as a second gate.

`npm run test:host` checks this directly: `tests/compat.mjs` feeds the real manifest to the host's own `evaluatePluginCompatibility`, so the range cannot drift out of sync with the runtime without a test failing.

---

## Tools

Fifteen tools. `memory_status` is the one to call first in any unfamiliar session.

| Tool | What it answers |
| --- | --- |
| `memory_bootstrap` | Everything a fresh session needs, in one call, within a token budget. |
| `memory_status` | Is memory initialized? What revision? Is it stale against git? How many atoms? Can also rebuild the index. |
| `memory_search` | Which documents discuss this? Ranked, with status/kind/path filters. |
| `memory_read` | Read a document, or one `##` section of it, bounded and framed as data. |
| `memory_recall` | Which stored atoms are relevant to this question? Ranked, budgeted, with route and confidence. |
| `memory_remember` | Store durable facts, constraints, and decisions so a later session can find them. |
| `memory_forget` | Retire atoms by id. The tombstone is sticky: re-extraction cannot resurrect them. |
| `state_get` | The current task, progress, blockers, decisions, next steps. |
| `state_update` | Record a change. Compare-and-set; conflicts are reported, not overwritten. |
| `state_handoff` | Write an end-of-session note so the next session starts oriented. |
| `project_init` | Create `.dsh-memory/` for this project. Nothing is created automatically. |
| `project_inspect` | Root, git facts, memory presence, index state — read-only diagnosis. |
| `docs_check` | Front-matter and status problems across the documentation set. |
| `docs_sync` | Update a document or propose a change, refusing protected paths. |
| `architecture_check` | Deterministic import-rule check against `.dsh-memory/arch.json`. |

### Commands

`/memory-status`, `/memory-context`, `/memory-init`, `/memory-handoff`, `/memory-recall`, `/memory-route`, `/memory-forget`, `/memory-sync`, `/architecture-check`.

`/memory-route` is a dry run: it shows which route the current tier would take and why, without spending a model call.

### Sidebar panel

The plugin adds one entry to the left sidebar — **project memory** — which opens a panel. It leads with the question people actually open it to ask: **did compacting my conversation keep the memory?**

- **the last compaction, in one sentence** — how many atoms it wrote and when, or the reason it wrote none. A last compaction older than a day says so, because a plugin that quietly stopped working looks exactly like one that is idle;
- **a timeline of recent compactions**, newest first, one row each: atoms written (or the skip reason), the turn, and the size of the summary it read. Silent compactions are dimmed rather than hidden — "the last five wrote nothing" is precisely the signal this panel must not suppress;
- live and forgotten atom counts, **how many are standing hard rules**, the breakdown by kind and by weight, and — when the store is at its ceiling — a warning that new atoms are displacing old ones rather than accumulating;
- the project picker and the Global / This project switch;
- collapsed by default: the router controls — **when** to route (`off` / `smart` / `always`), **what to prioritise** (`task` / `compliance` / `orient`), and the provider/model. The collapsed row still shows the current tier and strategy, so the setting is never hidden, only its controls. Routing is a tuning knob, not the point of the panel, and it no longer occupies the first screen.

The strategy is not decoration: each value sends a different instruction set to the router model, so the same atoms are weighed differently. `compliance` asks the router to hold rules that govern the files in play even when their wording looks unrelated to the request; `task` asks it to prefer what this step is about to do; `orient` asks it to prefer how the subsystem works, for requests that want to understand rather than act.

Saving goes through the host's `configEditor`, so a change takes effect the same way any other config change does — no hand-edited YAML that only applies after a restart and disagrees with the running config in the meantime. If a profile does not expose `configEditor`, the panel says so instead of reporting a save that did not happen.

The panel has no controls that change memory. Atoms are written by compaction and by tools that carry provenance and honour tombstones; a browser button that deleted one would bypass both, so removal stays `memory_forget`.

The panel finds its project without a running session. The profile setting wins, then the most recently served project, then the host's working directory. The recency record is a small file under the harness home (`$DSH_HOME`, or `~/.dsh`) — the one place that outlives a restart, since it is the index of the `.dsh-memory` directories rather than a copy of one. Without it, a freshly started host answered "no project root" while the project it should have read was on disk with a full atom store, which is indistinguishable from lost memory.

Its two endpoints are loopback-only. They reveal project memory and can change how routing behaves, so a request from another host is refused rather than served.

### Context injection

On the first step of a session the plugin injects a baseline (project identity, git facts, current task, invariants, next steps, blockers, decisions, document map) that fits `l0Budget`/`l1Budget`. It re-sends only when the identity changes, and it checks the session surface before sending so a compacted or resumed session is not given a duplicate. A re-send is a baseline; nothing is injected when nothing changed.

Each step may additionally receive a **recall block**: the atoms selected for that step's request, with their kind, provenance, and score. It is a separate message with its own source kind, so a reviewer can tell the durable baseline from a ranked selection. It is deduplicated by atom set against the session surface — re-stating atoms the model can already see would spend the budget this system exists to protect, while a *new* selection (or one shadowed by compaction) is still sent.

The baseline arrives as a **plugin-owned user message inside a nonce fence**. Project text is data, never instructions: role prefixes are neutralized, "ignore previous instructions" phrasing is stripped, invisible and bidirectional characters are removed, and code fences are closed so a document cannot escape the frame. The same framing applies to recalled atoms.

---

## Storage layout

Everything lives under `.dsh-memory/` in the project root. Commit it or ignore it — both are coherent. Committing gives the team shared state; ignoring gives each developer a private one.

```
.dsh-memory/
  project.json          stable projectId + first-seen git facts
  state/
    current.json        the state document (schema 2, revision-counted)
    journal.jsonl       append-only log of accepted writes
    compactions.jsonl   one row per observed compaction, silent ones included
    .lock               short-lived write lock
  memory/
    atoms.jsonl         durable atoms, one JSON record per line
    .lock               short-lived write lock
  index.json            derived cache — safe to delete, rebuilt on demand
  arch.json             optional architecture rules
  settings/
    <project-key>.json  per-project overrides — present only for projects that have one
```

`atoms.jsonl` is append-only and content-addressed: an atom's id is a hash of its kind and normalized text, so seeing the same statement twice reinforces one record instead of appending a copy. `memory_forget` writes a tombstone rather than deleting the line — the record stays as evidence, and the tombstone is sticky so a later extraction pass cannot bring it back.

`compactions.jsonl` is the operational record: one row per compaction this plugin witnessed, including the ones that produced no atoms, each with a `skipReason` from a closed set (`empty-summary`, `no-extractable-statements`, `store-write-failed`, and so on). The atom store can only show successes, so without this file a broken extractor and an idle project look identical. `/memory-status` summarizes it.

`index.json` is a cache. If it is wrong or deleted, `memory_status` rebuilds it. A corrupt `current.json` is renamed to `current.json.corrupt-<timestamp>` and reported in the result rather than being silently replaced — the damaged file is evidence.

> This repository's own `.dsh-memory/` is gitignored: it is the plugin's output, not the plugin. A team that wants to share memory should un-ignore it in their own project.

---

## Verifying

```powershell
npm run setup        # extract host packages from the installed app.asar and link them
npm test             # 14 unit tests for the pure core/ layer (no DSH needed)
npm run test:host    # fifteen host-level checks against the real harness
```

`npm run setup` is the one-time (and idempotent) prerequisite for `test:host`. It reads the packages out of the installed Desktop payload rather than `npm install`, so the tests run against the exact host this plugin will load into.

`npm run test:host` runs, in order:

| Check | What it proves |
| --- | --- |
| `smoke.mjs` | The module graph loads and exports the cordis plugin shape. |
| `tools.mjs` | Every tool schema is accepted by the harness's enforced JSON Schema subset. |
| `cordis-semantics.mjs` | The service-resolution behaviour the plugin depends on, measured rather than assumed. |
| `inject.mjs` | Baseline composition, message tagging, and surface-based dedupe. |
| `safety.mjs` | Protected paths refused, originals byte-identical, traversal blocked, stale writes conflict, passages framed as data. |
| `degrade.mjs` | All 15 tools still register and work when optional services are absent. |
| `continuity.mjs` | State, decisions, blockers, and documents survive a simulated restart; staleness tracks a real moving HEAD. |
| `root.mjs` | Root discovery: subdirectories share memory, unrelated directories do not, git and config override. |
| `compat.mjs` | The host's own `evaluatePluginCompatibility` accepts this manifest, and rejects an unsatisfiable one. |
| `patch.mjs` | `cordis.patch.yml` resolves through the host's own `bundlePatchPaths` and inserts a loadable plugin. |
| `mount.mjs` | The plugin mounts into a real cordis context with the real `ToolRuntime`, and disposes. |
| `loop.mjs` | The closed loop: a compaction event writes atoms through the real event bus, the next step recalls them sparsely, a replay is idempotent, a repeat is not re-injected, and a forget is honoured. |
| `panel.mjs` | The sidebar's endpoints over real HTTP: they report the same store and ledger the tools read, the compaction timeline is newest-first with a per-row verdict, write settings only through the host's `configEditor`, reject a value outside the accepted set, refuse a non-loopback peer, and disclose a corrupt line instead of reporting an empty store. |
| `recent.mjs` | The recency record that makes the panel work after a restart: it honours `$DSH_HOME`, survives a fresh read, stays ordered, de-duplicated and capped, performs no write when the root is already current, and turns a corrupt or unwritable file into "no history" rather than an exception. |
| `projects.mjs` | Per-project settings: one directory has one key whatever the spelling, the merge returns a copy rather than writing through the profile, an override applies to its own project only, removing the last key deletes the file, a non-overridable key is refused, a corrupt file is reported instead of read as empty, the project list is de-duplicated, and the panel refuses to honour a project path it does not know. |
| `client.mjs` | The Client half: one sidebar entry and one *matching* main panel, every string present in both languages with the same placeholders, and routes and choices identical to the host's. |

`npm test` covers path containment, front-matter parsing, index derivation, search ranking, guard framing, budget fitting, architecture checking, atomic writes, locking, state merging, and the whole atom layer (identity, tombstones, the sparse gate, route tiers, extraction, the router, recall, and the compaction observer).

Each host test needs the extracted packages and *skips* (exit 0) when they are absent. A skip is printed as `SKIP` and never counted as a pass — if a run shows `SKIP`, it proves nothing.

**A green suite is not the same as a working install.** The suite mounts the plugin in a cordis context the repository builds; only launching the host proves the profile actually loads it. Do both: `npm run test:all`, then restart and call `project_inspect`.

---

## Configuration

Every field has a working default. Invalid values are repaired, not fatal — a memory plugin should not stop a session because a config file has a typo.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; `false` registers nothing. |
| `injectContext` | `true` | Inject the baseline into new sessions. |
| `announceToAgent` | `true` | Add the guidance section to the system prompt. |
| `registerCommands` | `true` | Register the nine slash commands. |
| `l0Budget` / `l1Budget` | `300` / `1200` | Token budgets, minimal and full baseline. |
| `l2Budget` | `2000` | Token budget for a single read. |
| `maxDocuments` | `5000` | Cap on indexed documents. |
| `gitTimeoutMs` | `4000` | Git probe timeout; a slow git never blocks a step. |
| `includePrefixes` | `docs/`, `README.md`, … | What gets indexed. |
| `excludePrefixes` | `.git/`, `node_modules/`, … | What never does. |
| `protectedPaths` | `AGENTS.md`, `docs/decisions/`, … | Paths `docs_sync` refuses. |
| `projectRoot` | session cwd | Override the detected root. |
| `extractOnCompaction` | `true` | Turn a compaction summary into atoms. |
| `extractUserRules` | `true` | Harvest rules the user states outright. |
| `injectRecall` | `true` | Let a step receive a recall block. |
| `recallBudget` / `recallLimit` | `400` / `8` | Token ceiling and atom count for one recall. |
| `routerTier` | `smart` | `off`, `smart`, or `always`. See the tier table above. |
| `routerStrategy` | `task` | `task`, `compliance`, or `orient`. Selects the instruction set sent to the router model. |
| `routerProvider` / `routerModel` | `''` / `''` | The router's model. `smart` stays free until both are set. |
| `routerReasoningEffort` | `''` | Passed through to the router model, when the model supports it. |
| `routerTimeoutMs` | `20000` | Upper bound on one router call. |
| `routerCooldownSteps` | `1` | Steps to wait before routing the same request again. |
| `routerDigestBudget` | `900` | Token ceiling for the atom digest handed to the router. |

---

## Per-project settings

A profile is one configuration for every repository. That is wrong for at least one setting: the router model that suits a large TypeScript monorepo is not the one you want reviewing recall in a small notes repository, and paying for a router on one project while keeping it free on another is a per-project decision, not a global one.

So six fields can be overridden per project:

`routerTier`, `routerStrategy`, `routerProvider`, `routerModel`, `recallBudget`, `recallLimit`

Everything else stays global on purpose. Paths, budgets for the baseline, extraction switches, and protected paths describe the installation, not a repository; making them per-project would mean a project could change what the plugin is allowed to write.

**How it works.** An override is one small file inside the project:

```
<project>/.dsh-memory/settings/<project-key>.json
{ "schema": 1, "root": "<absolute project root>", "values": { "routerModel": "deepseek-reasoner" } }
```

The key is the absolute path with separators and the drive colon folded into dashes, so `D:\x\proj` and `D:/x/proj/` are the same project on a case-insensitive host. A step resolves `effectiveSettings(profile, root)` once, and everything downstream — the router's model, tier, strategy, the recall budget — uses the merged values. Nothing else in the plugin knows a second layer exists.

**Three rules that matter:**

- A value equal to the global value is still stored as an override. "This project uses `task` even after the profile moves to `compliance`" is a real decision, and silently dropping it would make the project follow the next global edit.
- Removing an override is explicit. Setting the value to `null` deletes it and restores inheritance; the file disappears when its last key goes. An empty file is never left behind, because it would read as a decision nobody made.
- A corrupt settings file is reported, never guessed at. The profile values still apply — one bad file must not take a project's memory offline — and the panel shows the reason.

**In the panel.** The sidebar panel has a project picker, a Global / This project switch, and a marker on every field that is overridden. Nothing is written until you press Save, and the layer you are editing is stated next to the controls rather than only in the picker.

---

## Project layout

```
core/          pure Node, no DSH import — the testable heart
  memory.js    atom store, identity, merging, tombstones
  gate.js      sparse mixture-of-experts selection and route decision
  extract.js   deterministic extraction from summaries and user rules
  state.js     state document, compare-and-set, journal
  projects.js  project registry, per-project settings, effective merge
  indexer.js   document index      search.js    lexical ranking
  context.js   token budgets       guard.js     data-not-instructions framing
lib/           the cordis layer
  index.js     plugin body, agent/pre-step injection
  tools.js     15 agent tools      commands.js  9 slash commands
  compaction-memory.js  session/event observer
  recall.js    one step's recall   router.js    router prompt and parsing
  delegate.js  subagent activation
  panel.js     the sidebar panel's two loopback routes
  recent-projects.js  the cross-restart record of which project was last served
  settings-write.js  persisting a panel change through configEditor
client.js      the sidebar panel (Client half, loaded by the web shell)
tests/unit/    pure-core tests (node --test)
tests/*.mjs    host-level checks against the real harness
docs/          design notes and doc proposals
scripts/       host-package extraction and linking for the tests
```

`docs/design/system-c-memory-atoms.md` explains the atom layer and the gate in depth, including the two implementation traps that were found by testing rather than by reading (a softmax over raw scores collapses to one expert; ranking purely by overlap discards hard constraints exactly when they matter).

---

## Known limitations

See [LIMITATIONS.md](./LIMITATIONS.md). The short version: search is lexical, not semantic; the router is bounded by `routerTimeoutMs` and degrades to deterministic selection; atoms are not authoritative documents; and there is no automatic commit and no cross-project query.

The router subagent has **never run against a live model**. Its unit tests cover timeout, abort, malformed reply, and unknown ids with a stubbed delegate, and its construction is checked against the real `startActivation` signature — but no real spawn has been observed producing a real selection. Its prompt is therefore unmeasured: the strategies change what it is asked for, and no accuracy figure is claimed for any of them. Failure degrades to deterministic selection, so the worst case is a missed improvement, not a broken step.

Extraction is stricter than it used to be — only known compaction sections are read, only Markdown list items become atoms, and a section heading no longer decides a kind — but it is still deterministic pattern matching, not judgement. A paragraph that states a rule without a bullet is not extracted; state it with `memory_remember`.

---

## License

[MIT](./LICENSE) © 2026 iverins
