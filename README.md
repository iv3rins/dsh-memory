# dsh-project-memory

**Languages:** English · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · [Español](./README.es.md)

Project memory for [DeepSeek Harness](https://github.com/deepseek-ai): your documents, your
development state, and durable memory atoms that survive restarts and context compaction.
A host-only cordis plugin, plus one sidebar panel.

```
MIT · Node 20+ · no runtime dependencies
```

## The problem

An agent starts every session blank. So you re-explain the structure, it re-reads the same
documents, it re-makes a decision you settled last week, and it repeats a mistake it
already hit.

Inside one session the same thing happens more quietly. When the context gets long the
harness compacts it: the original turns are replaced by a summary. Context stays
affordable, and everything the summary left out is gone for good.

This plugin gives the project a memory stored **in the repository**, not in a context
window.

## How it works

Three stores, because what you *wrote*, what you *are doing*, and what you *decided* have
different lifetimes:

| system | holds | written by | survives |
|---|---|---|---|
| **A — documents** | your Markdown | you, in git | everything |
| **B — state** | task, progress, blockers, decisions | `state_update` / `state_handoff` | restarts, compaction |
| **C — atoms** | short durable statements | the compaction observer, `memory_remember` | restarts, compaction |

The interesting one is **C**:

```
long session ──▶ compaction ──▶ lossy summary  (what the model sees next)
                     │
                     └──▶ short atoms ──▶ .dsh-memory/memory/atoms.jsonl
                                                   │
next step ──▶ sparse selection for THIS request ───┘
              └──▶ a few atoms, inside a token ceiling
```

Four properties make it cheap enough to run on every step:

1. **Sparse, not dumped.** A handful of atoms out of hundreds, ranked for *this* request.
   A hard token ceiling means cost is set by configuration, not by project size.
2. **Recorded, not scraped.** State and atoms are written by tool calls. An agent that
   never calls `state_update` gets no state memory — a visible failure instead of a quietly
   wrong one. The one deliberate exception: the compaction observer reads compaction
   summaries, which is exactly what system C exists to rescue.
3. **Rules outrank relevance.** A `constraint` atom is *standing*: it is selected before
   any scoring runs and kept even when the request's wording does not match it. A rule
   that only applies when you happen to mention it is not a rule.
4. **Selection never writes.** The optional router subagent may only answer with ids that
   were offered to it; an id it invents is discarded. Mutation stays in deterministic code.

### Router tiers

| `routerTier` | behaviour | cost |
|---|---|---|
| `off` | deterministic gating only | free |
| `smart` (default) | escalates only when the deterministic pass found nothing relevant or matched weakly | free until a provider **and** model are set |
| `always` | every step asks the router | one call per step |

`smart` costs nothing out of the box: it needs both `routerProvider` and `routerModel`.
`routerStrategy` (`task` / `compliance` / `orient`) changes the instructions the router
receives, so two profiles with the same atoms can still recall differently.

### Standing is not weight

Weight (1–5) is a *ranking* input. Standing is an *eligibility* input, decided by kind
(`constraint`), never by weight. Fusing them was a real bug: genuine rules stored at the
default weight silently lost their hard-rule status. Standing atoms still obey the count
and token caps — a budget share, not an exemption.

## Install

```
git clone https://github.com/iv3rins/dsh-memory.git
```

The manifest declares `dsh.bundle`, so one command adds the dependency **and** the bundle
entry:

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add -w "link:D:\path\to\dsh-memory"
```

Restart the host, then call `project_inspect`: a resolved project root and an indexed
document count mean it is live.

`engines.dsh` is `>=0.2.0-rc.0 <0.3.0`, deliberately narrow: a host minor release can
change the tool-schema subset or the message shape, and this plugin would then fail at
mount rather than at install. Widen it after re-running the suite.

## Tools

Eighteen tools. Start any unfamiliar session with `memory_status`.

| Tool | What it answers |
|---|---|
| `memory_status` | Is memory initialized? Which revision? Stale against git? How many atoms? |
| `memory_bootstrap` | Everything a fresh session needs, in one budgeted call. |
| `memory_search` | Which documents discuss this? Ranked, with status/kind/path filters. |
| `memory_read` | Read a document, or one `##` section, framed as data. |
| `memory_recall` | Which stored atoms fit this question? Ranked, budgeted, with route. |
| `memory_intent` | Same, via a structured Task Intent (task, modules, operation, categories). |
| `memory_remember` | Store durable facts, constraints and decisions. |
| `memory_forget` | Retire atoms by id; the tombstone is sticky. |
| `memory_lifecycle` | Inspect and adjust atom tiers (HOT / WARM / COLD). |
| `memory_metrics` | Router calls, latency, cache hits, deliveries versus uses, token cost. |
| `state_get` / `state_update` | Read the state; record a change. Compare-and-set, conflicts reported. |
| `state_handoff` | End-of-session note so the next session starts oriented. |
| `project_init` / `project_inspect` | Create `.dsh-memory/`; read-only diagnosis. |
| `docs_check` / `docs_sync` | Front-matter problems; propose a doc change (never in place). |
| `architecture_check` | Deterministic import-rule check against `.dsh-memory/arch.json`. |

**Commands:** `/memory-status`, `/memory-context`, `/memory-init`, `/memory-handoff`,
`/memory-recall`, `/memory-route`, `/memory-forget`, `/memory-sync`, `/architecture-check`.
`/memory-route` is a dry run: it shows which route the current tier would take, and why,
without spending a model call.

**Sidebar panel.** One sidebar entry opens a dashboard about the question people actually
have — *did compacting my conversation keep the memory?* It shows the last compaction in
one sentence, a newest-first timeline of recent compactions (silent ones dimmed, not
hidden), live and forgotten counts, standing rules, and the breakdown by kind and weight.
Router controls are collapsed by default. It has no control that mutates memory: atoms are
written by compaction and by tools that carry provenance, so removal stays `memory_forget`.
Its two routes (`/project-memory/status`, `/project-memory/config`) are loopback-only.

**Context injection.** On the first step the plugin injects a budgeted baseline (identity,
git facts, task, invariants, next steps, blockers, decisions, document map) and re-sends
only when the identity changes. Each step may also receive a recall block, deduplicated
against the session surface. Both arrive as plugin-owned messages inside a nonce fence:
project text is data, never instructions.

## Configuration

Every field has a working default; invalid values are repaired, never fatal.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `injectContext` / `injectRecall` | `true` | Inject the baseline / per-step recall. |
| `l0Budget` / `l1Budget` / `l2Budget` | `300` / `1200` / `2000` | Tokens: minimal baseline, full baseline, one read. |
| `recallBudget` / `recallLimit` | `400` / `8` | Ceiling and count for one recall. |
| `routerTier` / `routerStrategy` | `smart` / `task` | See the tier table above. |
| `routerProvider` / `routerModel` | `''` / `''` | The router's model. Empty means no router calls. |
| `routerTimeoutMs` / `routerDigestBudget` | `20000` / `900` | Call bound; token ceiling for the digest offered to it. |
| `extractOnCompaction` / `extractUserRules` | `true` | Harvest atoms from summaries and from stated rules. |
| `semanticRouting`, `lifecycleEnabled`, `taskIntentEnabled` | `false` | Opt-in layers; one flag back to `false` restores the earlier behaviour. |
| `protectedPaths` | `AGENTS.md`, `docs/decisions/`, `docs/adr/`, `.git/` | Never written by `docs_sync`. |

Six fields can be overridden per project — `routerTier`, `routerStrategy`,
`routerProvider`, `routerModel`, `recallBudget`, `recallLimit` — in
`.dsh-memory/settings/<project-key>.json`. Everything else stays global on purpose: paths
and write ceilings describe the installation, not a repository.

## Storage

Everything lives under `.dsh-memory/`. Commit it for shared team memory, or ignore it for
a private one — both are coherent.

```
.dsh-memory/
  project.json        stable projectId + first-seen git facts
  state/current.json  the state document (revision-counted)
  state/journal.jsonl append-only log of accepted writes
  state/compactions.jsonl  one row per observed compaction, silent ones included
  memory/atoms.jsonl  durable atoms, one JSON record per line
  memory/metrics.json bounded event counters
  index.json          derived cache — safe to delete
  settings/<key>.json per-project overrides
```

Atom ids are content-addressed (hash of kind and normalized text), so the same statement
seen twice reinforces one record. `memory_forget` writes a tombstone instead of deleting
the line, so a later extraction cannot resurrect it. A corrupt file is renamed aside and
reported, not silently replaced.

## What is measured, and what is not

**Measured** (`docs/design/benchmark-compaction-loss.md`): on 80 questions from a real
dataset, summary-only and tail-only contexts scored 16.3% and 15.0% correct; summary plus
atom recall scored 25.0%. Every confidence interval crosses zero, so this is a consistent
direction, **not an established effect**.

**Not measured**:

- **Router accuracy — zero.** The router subagent has never run against a live model. Its
  tests cover timeout, abort, malformed replies and unknown ids with a stubbed delegate;
  no real spawn has been observed producing a real selection. Its `smart` trigger rate is
  likewise unmeasured: the escalation rules are in `decideRoute`, the frequency with which
  they fire is not.
- **Cost of a full scan.** `gateAtoms` scores every live atom on every recall
  (`core/gate.js`). Measured here — 401-record store, this machine — one `readAtoms` costs
  ≈ 5.6 ms and one `gateAtoms` ≈ 9.4 ms; on uniform synthetic atoms the gate grows
  roughly linearly at ≈ 0.7 / 1.0 / 1.6 / 3.3 ms for 100 / 200 / 400 / 800 atoms. No
  inverted index exists. Standing selection is a separate *pass*, but it reuses the same scan, so
  it is not an independent candidate channel.
- **Parsing cost of `atoms.jsonl`.** Every recall re-reads and re-parses the whole file
  (`lib/recall.js`); there is no in-process snapshot cache. Any cache needs cross-process
  invalidation (another session, another process, or `memory_forget` can rewrite the file),
  which is why it is a design item rather than a patch.

Search is lexical, not semantic. The router degrades to deterministic selection on timeout,
so its worst case is a missed improvement, not a broken step.

## What it will not do

- It will not modify `AGENTS.md`, `docs/decisions/`, `docs/adr/`, or `.git/`. `docs_sync`
  refuses those paths and names the refusal.
- It will not commit, branch, or push. It records git facts; it does not perform git work.
- It will not silently invent state. Every write is compare-and-set; concurrent writes
  conflict instead of overwriting.
- It will not rewrite an authoritative document. Proposals go to `docs/proposals/`.

## Verifying

```powershell
npm run setup        # extract and link host packages (once, idempotent)
npm test             # 14 unit tests for the pure core/ layer
npm run test:host    # 28 chained checks against the real harness
```

The host suite covers the tool schemas the harness enforces, injection and dedupe, the
full compaction → recall → forget loop through real events, safety and path refusal,
graceful degradation, manifest compatibility, panel HTTP behaviour, per-project settings,
and the Client half. A skipped check prints `SKIP` and proves nothing.

**A green suite is not a working install.** The suite mounts the plugin in a context the
repository builds; only launching the host proves the profile loads it. Do both.

## Layout

```
core/   pure Node, no DSH import — the testable heart
        memory.js  gate.js  state.js  retrieval.js  category.js  lifecycle.js
        extract.js  config.js  index.js  search.js  store.js  paths.js  ...
lib/    the cordis layer: index.js  tools.js  commands.js  panel.js  recall.js
        router.js  semantic.js  delegate.js  compaction-memory.js
client.js  the sidebar panel (Client half)
tests/     unit/ (node --test) and *.mjs host checks
docs/      design notes and doc proposals
```

`docs/design/system-c-memory-atoms.md` explains the atom layer in depth, including the two
traps found by testing rather than reading: a softmax over raw scores collapses to one
expert, and ranking purely by overlap discards hard constraints exactly when they matter.

## License

[MIT](./LICENSE) © 2026 iverins
