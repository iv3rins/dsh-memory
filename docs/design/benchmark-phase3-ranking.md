# Phase 3: delivery integrity, semantic categories, and how far the ranking can be pushed (2026-11-06)

The brief named two production problems and asked for a controlled comparison. One of the
two turned out not to be a production problem at all. That finding is the most useful thing
in this document, so it comes first.

## Headline

| change | answer-holder retrieval | accuracy |
|---|---|---|
| **limit 8 → 12** | **61.3% → 71.0%** (paired 6:0, exact McNemar **p = 0.031**) | 22.5% → 27.5% (not established) |
| semantic category routing | 71.0% → 72.6% (+1 question) | 22.5% → 22.5% (no effect) |
| standing share 0.4 → 0.25 | 72.6% → 72.6% | 22.5% → 22.5% (no effect) |
| delivery-integrity checker | no defect found to fix — see below | — |

So: **one real improvement, in retrieval**, not in accuracy; **one mechanism that fires but
does not pay off** (semantic categories); **one non-defect** (the delivery failures).

Nothing here is declared an accuracy improvement, because nothing here established one.

## 1. The 13 DELIVERY_FAILURE rows were a measurement bug, not a product bug

This is the first thing the brief asked for, and the answer contradicts the premise.

**What Phase 2 reported:** 13 rows where a memory id was selected but its key fact was
missing from the delivered text.

**What replaying them showed:** all 13 were already complete. The rendered block is
byte-identical across repeats (13/13 stable over 3 repeats each), and every required value
was present.

**Root cause of the false labels**, in `scripts/bench/phase2.mjs`:

```js
const deliveredText = recalled.block          // what was measured
...
const context = `${summary}\n\n${recalled.block}`   // what the model actually received
```

The check compared values against the recall block only, while the model was given the
summary **plus** that block. A fact delivered by the summary was scored as lost. Fixing the
measurement moved the count from 13 to 7; triaging those 7 showed all of them were holders
whose wording differs from the answer's, so the strict predicate failed while the atom's
text was present. **Real content loss: 0 of 80.**

Verified by two independent scripts:
- `scripts/bench/delivery-determinism.mjs` — the block is deterministic and the value is
  present;
- `scripts/bench/delivery-triage.mjs` — for each of the 7, the holder's own text is in the
  block.

This does not mean the delivery path was fine by construction. It means the evidence
offered for a defect did not survive replay, and a benchmark that ships such a finding is
worse than one that ships none.

## 2. What did exist: a silent truncation cap

`MAX_ATOM_CHARS = 480` and `normalizeAtomText` applies it with `slice()`. An atom longer
than that is stored as a prefix and **nothing downstream could tell a short fact from a
truncated one**. The bench stores never hit the cap (max 303 chars), but the live project
store has **11 of 401 atoms sitting exactly at 480**.

Fixed by reporting rather than by raising the cap:
- `atomTextTruncated(value)` — would storing this drop characters?
- `atomMayBeTruncated(atom)` — is this stored text at the cap, and therefore possibly a prefix?
- `renderAtoms` now tags such an atom `possibly truncated at 480 chars` and appends one
  block-level line: `(N of M atom(s) reached the 480-character store cap and may be
  incomplete; use memory_read for the full record)`.

Short atoms produce neither tag nor line, so the disclosure cannot become noise the model
learns to ignore.

## 3. Delivery integrity: five states, kept apart

New module `core/delivery.js`, because "the id was in the list" is not evidence the content
arrived:

| state | question | decided by |
|---|---|---|
| selected | did ranking choose it? | id in the selection |
| resolved | did the store return a record? | a live atom with that id |
| rendered | did the renderer emit it? | its text in the recall block |
| delivered | did the model receive it? | its text in the **final context** |
| evidence_verified | is the key fact intact? | a **distinctive** value present |

`integrity: 'verified'` requires the value, not the id. When nothing is checkable the
verdict is `partial`/`unknown`, never `verified` — the id-only assertion the brief forbids.
`delivery_status` is `success` only when every selected atom verified; one missing atom
degrades the whole package to `degraded`.

`isDistinctive` is what stops a common word from counting: `26` and `priority` do not prove
content survived, `1.3.8` and `test_platform_github` do.

## 4. Semantic category routing: implemented, measured, does not pay off

**Implemented** as the brief described, using stable `category_id`s and never colours:
- `core/query-category.js` derives a request's categories;
- only `mod:` and `dom:` vote — `task:` describes the sentence's mood, and every request in
  a working session is `task:feature`;
- `core/gate.js` gains `GATE_WEIGHTS.category` (4.5) and `categoryExplicit` (3), both below
  `rareOverlap` (10) so a broad bucket cannot outrank a precise token;
- an atom matching *only* by category is no longer floored to irrelevance.

**Measured, and the reason it fails is structural:**

| | project_01 | project_02 |
|---|---|---|
| requests carrying a voting category | 44/50 | **30/53** |
| the answer-holder shares it | 25 | **12** |
| any atom shares it (fan-out) | 34 | 17 |

- On the long project, **23 of 53 questions produce no voting category at all**, because
  they are phrased as questions ("what version did we pin") rather than as statements about
  a subsystem.
- Where a category does exist, the distribution is dominated by the least informative
  buckets: `dom:general` ×12, `mod:tests` ×11. A category shared by a fifth of the corpus
  cannot discriminate, for the same reason IDF exists for tokens.
- A worked counter-example, measured directly:

  ```
  question "In src/core/gripspace.rs, how does resolve_manifest_repo_dir fall back?"
    -> ["mod:core"]
  answer-holder atom -> ["dom:process"]
  shared: []            <- the dimensions do not meet
  ```

The mechanism is not broken; it is a weak signal on this data. In the controlled run it
retrieved **one** more answer-holder than the same configuration without it (44 → 45 of 62)
and changed accuracy by zero. `tests/semantic-category.mjs` therefore asserts the
*mechanism* (only mod/dom vote, agreement is computed, absent context leaves the score
untouched, weight ordering), not a benefit — a test claiming a gain would be measuring
noise.

## 5. Ranking: the slot ceiling was the real lever

The brief asked to optimise candidate → final selection. The measurement said the lever is
not scoring, it is the ceiling.

| limit | project_01 | project_02 |
|---|---|---|
| 8 | 76.5% | **31.6%** |
| 12 | 82.4% | **42.1%** |
| 16 | 82.4% | 42.1% |
| 24 | 85.3% | 42.1% |
| 40 | 85.3% | 44.7% |

Most of the recoverable loss is between 8 and 12; beyond 12 the curve is flat. That is why
`take()` now treats the count as a **ceiling** rather than a quota: it still stops at the
limit, but the walk continues while budget remains instead of emitting eight and leaving the
rest unspent. In the controlled run this moved retrieval from 38/62 to 44/62.

The scoring path itself was not rewritten. `category` was the one added term, and it
contributed one question.

## 6. Controlled comparison

Same 80 questions, model, judge and temperature as Phase 2. Each arm is one delta from the
previous.

| arm | change | correct | retrieval | 95% CI (retrieval) | avg ctx tokens |
|---|---|---|---|---|---|
| A | delivery fix, limit 8 | 18/80 = 22.5% | 38/62 = 61.3% | 48.8–72.4% | 2 508 |
| B | limit 12 | 22/80 = 27.5% | **44/62 = 71.0%** | 58.7–80.8% | 2 669 |
| C | + semantic | 18/80 = 22.5% | 45/62 = 72.6% | 60.4–82.1% | 2 670 |
| D | + standing share 0.25 | 18/80 = 22.5% | 45/62 = 72.6% | 60.4–82.1% | 2 670 |

Paired comparisons on accuracy:

| pair | difference | 95% CI | discordant | exact McNemar |
|---|---|---|---|---|
| B − A | +5.0 pp | −2.7 … +12.7 | 7 / 3 | p = 0.344 |
| C − B | −5.0 pp | −13.5 … +3.5 | 4 / 8 | p = 0.388 |
| D − C | 0.0 pp | −6.0 … +6.0 | 3 / 3 | p = 1.000 |

Retrieval, which is where the mechanism acts, is the one comparison that clears:

| pair | changed | exact McNemar |
|---|---|---|
| B − A (retrieval) | 6 improved, 0 regressed | **p = 0.031** |

### The noise floor makes most of this undecidable

Running the same arms twice: A shifted 2 questions, B shifted 2, **C shifted 4**, D shifted 3.
Every accuracy difference above is at or below that spread. The four arm totals were measured
in one pass each and must be read as samples, not fixed values.

**This is why no accuracy improvement is claimed.** The retrieval result survives because it
is a paired, one-directional change (6:0) on a quantity the mechanism directly acts on.

### Lifecycle arm: not evaluable

The brief allowed an explicit "not evaluable" instead of a fabricated one. CodeMemo records
no real usage events, and the lifecycle mechanism ranks by observed usefulness. Inventing
`seen` counts would manufacture the exact signal under test, so arm D tests a *cap change*
instead and the lifecycle mechanism is reported as unmeasured.

## 7. Corrections to the Phase 2 numbers

The brief listed four suspect figures. All four are reconciled in
`scripts/bench/reconcile.mjs`:

| claim | finding |
|---|---|
| Phase 1 C = 20/80, Phase 2 C = 14/80 | Both real. Same 80 questions. **Per-question agreement only 73.8%** (59/80) |
| Phase 2 NONE = 16 | From an earlier run (07-24, before the `v0.12.0` regex fix). Every run is self-consistent (NONE == CORRECT) |
| attribution totals 82 | 82 is the **line count**: 80 questions + 2 `build-cost` records. Attributions sum to 80 |
| different runs mixed? | Yes, in the sense that matters: Phase 2's C arm is a sample, and 26% of its per-question verdicts differ between runs |

That 73.8% agreement is the most important number in this section. It means **a single run
of arm C cannot be quoted as a measurement**, and any A/B comparison built on one pass per
arm inherits that variance. It is also the reason this document reports paired results and a
noise floor rather than four point estimates.

## 8. Memory Package

The structured result the brief specified, produced by the recall path:

```json
{
  "task_id": "task_001",
  "categories": ["mod:core", "dom:constraint"],
  "hot_memories": [
    {
      "id": "398af76541518605",
      "content": "The croniter dependency is pinned to 1.3.8 in pyproject.toml.",
      "source_ids": ["bench:session_005"],
      "integrity": "verified"
    }
  ],
  "cold_references": [
    { "id": "9f8e7d6c5b4a3210", "summary": "The SQLite schema is defined inline in cli.py…", "retrievable": true }
  ],
  "delivery_status": "success"
}
```

Two notes on the real shape, so the example is not mistaken for invented fields:

- `source_ids` is taken from the atom's **tags**, not from `source.sessionId`. In a
  compaction-derived atom `source` is `{ sessionId: null, compactionId: null, seq: null }`;
  when the atom came from a compaction, `compactionId` carries the provenance instead.
- `id` is the 16-hex content address the store assigns, not a sequential `mem_001`.

`integrity: "verified"` is set by `verifyDelivery` only when a distinctive value from the
atom was found in the final context. Cold references carry a gist, never full text, exactly
as the existing cold-memory invariant requires.

Memory remains **retrieval data**: nothing in this phase promotes an atom into a system or
developer message. The rendered block keeps its "recalled project memory" header and its
provenance tags.

## 9. What was not done

- **The scoring formula was not rewritten.** The brief said not to redo the store, compaction
  or the plugin, and the measurement did not justify a redesign: the ceiling was the lever.
- **The router subagent was not invoked** in the controlled run. `routerTier: 'off'` in every
  arm, so the semantic-routing comparison isolates the *deterministic* category term. The
  brief's model-driven category selection remains unmeasured — as does the router's accuracy,
  which has still never been evaluated against a live model.
- **No currency cost.** The endpoint publishes no verified per-token price.
- **`project_03` untouched**, as in Phase 2: image-heavy, 1.9 M tokens, outside the budget
  this harness was built for.

## 10. Reproducing

```
export LLM_BASE_URL=...                  # OpenAI-compatible /v1
node tests/delivery.mjs                  # five states, no model calls
node tests/truncation.mjs                # the 480-char disclosure
node tests/semantic-category.mjs         # the mechanism, not a benefit
node scripts/bench/delivery-reverse.mjs  # inject 3 delivery defects, expect red
node scripts/bench/truncation-reverse.mjs
node scripts/bench/reconcile.mjs         # the four Phase 2 figures
node scripts/bench/ranking-probe.mjs     # limit vs recovery, no model calls
node scripts/bench/semantic-reach.mjs    # how often the category term can fire
node scripts/bench/phase3.mjs --all      # the four-arm run
node scripts/bench/phase3-analyze.mjs    # paired statistics + noise floor
```

All gates are reverse-verified: injecting the defect each guards makes it fail
(3/3 delivery, 2/2 truncation, 2/2 phase-2 gates).

## 11. The honest bottom line

1. **The 13 delivery failures did not exist.** They were a benchmark that measured the wrong
   string. Real content loss: zero.
2. **A real defect existed next door**: a 480-character store cap applied silently. It now
   announces itself.
3. **Ranking improved where it could be measured**: answer-holder retrieval 61.3% → 71.0%,
   paired 6:0, p = 0.031, by raising the slot ceiling from 8 to 12.
4. **Semantic category routing is not worth its complexity on this data** — it fires on
   fewer than half the questions and moves accuracy by zero. It is implemented, tested and
   documented, and the honest recommendation is to keep it off by default until a corpus
   exists where requests name subsystems.
5. **No accuracy improvement is claimed**, because the run-to-run spread of a single arm
   (up to 4 of 80 questions) exceeds every between-arm difference observed.
