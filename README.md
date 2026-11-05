# dsh-project-memory

**Languages:** English · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · [Español](./README.es.md)


Project-level persistent knowledge and development-state memory for [DeepSeek Harness](https://github.com/deepseek-ai).

An agent forgets everything when a session ends, when the context is compacted, or when you switch branches. For a project that outlives dozens of sessions, that means re-deriving the same decisions, re-reading the same documents, and repeating the same mistakes. This plugin gives a project a memory that lives in the repository instead of in a context window.

It is a **host-only [cordis](https://github.com/deepseek-ai/cordis) plugin**: it registers agent tools, a system-prompt section, and slash commands. There is no browser half and no change to DSH itself.

```
MIT licensed · Node 20+ · host-only, no client half
```

---

## Contents

- [Three systems, on purpose](#three-systems-on-purpose)
- [What it will not do](#what-it-will-not-do)
- [Install](#install)
- [Tools](#tools)
- [Storage layout](#storage-layout)
- [Verifying](#verifying)
- [Configuration](#configuration)
- [Known limitations](#known-limitations)
- [License](#license)

---

## Three systems, on purpose

**System A — documentation knowledge.** Markdown in the repository is the source of truth. The plugin indexes it, searches it, and reads named sections. It never rewrites your authoritative docs; when it proposes a change it writes to `docs/proposals/`.

**System B — development state.** Task, progress, blockers, decisions, next steps, git facts, and handoff notes are persisted by a tool call, so they survive a restart or a compaction. **The tool call is what persists.** An agent that never calls `state_update` gets no state memory — the plugin does not scrape conversation.

**System C — memory atoms.** Durable, addressable records extracted from compaction summaries and from rules the user states outright, then *selectively* recalled into the next request. This is the answer to compaction loss: a checkpoint summary replaces the original turns, and everything it drops is gone. Atoms give that content a second life, outside the context window, retrievable by relevance rather than by being lucky enough to have survived the summary.

Recall follows a sparse-gating pattern rather than a dump. Scoring is deterministic (lexical overlap, kind priority, reinforcement, recency), the selection is sparse (few atoms out of many, ranked), and the cost is bounded (a hard token ceiling). That is the MemGPT arrangement — the context window as working memory, the store as the larger memory space, exchanged on demand — expressed as a mixture-of-experts gate: kinds are experts, atoms compete within an expert, and the softmax decides which experts are active for *this* request.

A subagent can serve as the router when lexical scoring is not enough. Three tiers:

| `routerTier` | Behavior | Cost |
| --- | --- | --- |
| `off` | Deterministic gating only. | Free |
| `smart` (default) | Deterministic gating, escalating to the router only when it selected nothing relevant or matched weakly. | Near-free; a call only when the cheap path failed |
| `always` | Every step asks the router subagent. | One call per step — pair it with a cheap model |

`smart` costs nothing until `routerProvider` **and** `routerModel` are both set, so the plugin spends no model calls out of the box.

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
    .lock               short-lived write lock
  memory/
    atoms.jsonl         durable atoms, one JSON record per line
    .lock               short-lived write lock
  index.json            derived cache — safe to delete, rebuilt on demand
  arch.json             optional architecture rules
```

`atoms.jsonl` is append-only and content-addressed: an atom's id is a hash of its kind and normalized text, so seeing the same statement twice reinforces one record instead of appending a copy. `memory_forget` writes a tombstone rather than deleting the line — the record stays as evidence, and the tombstone is sticky so a later extraction pass cannot bring it back.

`index.json` is a cache. If it is wrong or deleted, `memory_status` rebuilds it. A corrupt `current.json` is renamed to `current.json.corrupt-<timestamp>` and reported in the result rather than being silently replaced — the damaged file is evidence.

> This repository's own `.dsh-memory/` is gitignored: it is the plugin's output, not the plugin. A team that wants to share memory should un-ignore it in their own project.

---

## Verifying

```powershell
npm run setup        # extract host packages from the installed app.asar and link them
npm test             # 14 unit tests for the pure core/ layer (no DSH needed)
npm run test:host    # twelve host-level checks against the real harness
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
| `routerProvider` / `routerModel` | `''` / `''` | The router's model. `smart` stays free until both are set. |
| `routerReasoningEffort` | `''` | Passed through to the router model, when the model supports it. |
| `routerTimeoutMs` | `20000` | Upper bound on one router call. |
| `routerCooldownSteps` | `1` | Steps to wait before routing the same request again. |
| `routerDigestBudget` | `900` | Token ceiling for the atom digest handed to the router. |

---

## Project layout

```
core/          pure Node, no DSH import — the testable heart
  memory.js    atom store, identity, merging, tombstones
  gate.js      sparse mixture-of-experts selection and route decision
  extract.js   deterministic extraction from summaries and user rules
  state.js     state document, compare-and-set, journal
  indexer.js   document index      search.js    lexical ranking
  context.js   token budgets       guard.js     data-not-instructions framing
lib/           the cordis layer
  index.js     plugin body, agent/pre-step injection
  tools.js     15 agent tools      commands.js  9 slash commands
  compaction-memory.js  session/event observer
  recall.js    one step's recall   router.js    router prompt and parsing
  delegate.js  subagent activation
tests/unit/    pure-core tests (node --test)
tests/*.mjs    host-level checks against the real harness
docs/          design notes and doc proposals
scripts/       host-package extraction and linking for the tests
```

`docs/design/system-c-memory-atoms.md` explains the atom layer and the gate in depth, including the two implementation traps that were found by testing rather than by reading (a softmax over raw scores collapses to one expert; ranking purely by overlap discards hard constraints exactly when they matter).

---

## Known limitations

See [LIMITATIONS.md](./LIMITATIONS.md). The short version: search is lexical, not semantic; the router is bounded by `routerTimeoutMs` and degrades to deterministic selection; atoms are not authoritative documents; and there is no automatic commit, no cross-project query, and no client UI.

The router subagent has **never run against a live model**. Its unit tests cover timeout, abort, malformed reply, and unknown ids with a stubbed delegate, and its construction is checked against the real `startActivation` signature — but no real spawn has been observed producing a real selection. Failure degrades to deterministic selection, so the worst case is a missed improvement, not a broken step.

---

## License

[MIT](./LICENSE) © 2026 iverins
