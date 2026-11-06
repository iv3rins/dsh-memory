# Phase 2: failure attribution and the oracle ceiling (2026-11-06)

Phase 1 measured three arms and reported +8.8 pp with a confidence interval that included
zero. This phase asks a different question: **where** the loss happens, and how much of it
is recoverable at all.

Nothing here modifies the plugin. No router, compaction, or lifecycle code was touched. The
whole phase is instrumentation plus one new arm.

## The headline

| | arm C (summary + recall) | arm D (labelled evidence) |
|---|---|---|
| correct | 14/80 = **17.5%** [10.7, 27.3] | 47/80 = **58.8%** [47.8, 68.9] |

Paired difference **D − C = +41.3 pp, 95% CI [26.3, 56.2], exact McNemar p < 0.0001**
(discordant: only D 35, only C 2).

Read that carefully. It does **not** say the plugin could be 41 points better. It says:
when the model is handed the passages the dataset marks as evidence, it answers 41 points
more often than when it is handed the summary plus recalled atoms. **35 of 80 questions
(43.8%) are answerable given the right passages and were not answered by the pipeline.**
That 35 is the recoverable headroom, and the attribution below says which stage to blame
for it.

## Task 1 — per-question attribution

Every one of the 80 arm-C rows is stored in
`_bench/codememo/results/phase2-*.jsonl` with the fields the brief asked for:
`question_id`, `project_id`, `ground_truth`, `predicted_answer`, `verdict`,
`required_source_ids`, `required_values`, `extracted_memory_ids`, `candidate_memory_ids`,
`retrieved_memory_ids`, `delivered_memory_ids`, `actual_context_tokens`,
`failure_category`, `failure_detail`, plus token and latency columns.

The classifier walks a ladder, and each rung is decided by an observable fact:

| rung | condition |
|---|---|
| `EXTRACTION_FAILURE` | no stored atom contains the answer's distinctive values |
| `RETRIEVAL_FAILURE` | a matching atom exists but never entered the candidate set |
| `RANKING_FAILURE` | it was a candidate and the final selection dropped it |
| `DELIVERY_FAILURE` | it was selected but its values are absent from the rendered block |
| `REASONING_FAILURE` | the values reached the context and the answer was still wrong |
| `INSUFFICIENT_EVIDENCE` | the labelled evidence itself does not contain the values |
| `UNKNOWN` | nothing above could be established |

`BUDGET_FAILURE` is reachable in the ladder but **did not fire in this run** — see
"what did not happen" below.

### Result

| category | count |
|---|---|
| REASONING_FAILURE | 32 |
| RANKING_FAILURE | 17 |
| NONE (answered correctly) | 16 |
| DELIVERY_FAILURE | 13 |
| INSUFFICIENT_EVIDENCE | 3 |
| UNKNOWN | 1 |

**The bottleneck is not extraction.** Extraction coverage is 100% (project 01) and 92.5%
(project 02). Atoms exist and contain the values. The loss is downstream.

**The largest single recoverable loss is ranking at 588 k tokens.** Final retrieval falls
from 89.7% (project 01, 17 k tokens) to **55.0%** (project 02, 588 k tokens) while
candidate recall stays at 92.5%. The gate finds the atom; the final 8-slot selection
drops it. That is 17 questions, ~21% of the run, attributable to *selection under a
fixed slot count*, not to a missing memory.

**`DELIVERY_FAILURE` at 13 is a real defect, not a category artefact.** In those rows an
atom was selected, its id was in the delivered list, and its distinctive value is still
absent from the rendered block — the block is a truncated or reworded form of the atom.
This is the one finding that points at a fixable bug in rendering rather than a policy
choice.

The single `UNKNOWN` (`p01_q049`) is honest: its reference is
`26 tests -> 36 tests at 87% ... -> 41 tests at 89%`, and every distinctive number is
either two digits or a percentage that appears incidentally in many atoms, so the
classifier cannot tell delivery from coincidence. It is labelled UNKNOWN rather than
guessed.

## Task 2 — oracle evidence arm

Arm D receives the dataset's own `evidence[]` annotations: for each labelled turn, the
turn plus three turns either side, assembled from the session log. It never sees the
reference answer.

**Leakage is checked, not assumed.** `scripts/bench/oracle-check.mjs` compares each
oracle context against its reference answer: **0 of 103 contexts contain the reference
verbatim.** It also reports how many contexts carry a distinctive value from the answer
(37 of 50 in project 01, 32 of 53 in project 02), and names the questions where the
annotated evidence contains *none* of the answer's values — those are dataset defects, and
they are the `INSUFFICIENT_EVIDENCE` rows above.

Two corrections this required, both of which would have invalidated the arm:

1. `evidence.turn_index` indexes **every record** in the session file, not the filtered
   conversation. Indexing the conversation put 7 of 12 evidence positions "outside the
   session". The loader now carries `rawIndex`.
2. The Oracle initially returned `PARTIAL` where the answer was clearly present, because
   the window was too narrow; `ORACLE_WINDOW` is now ±3 turns around the labelled index.

Cost and latency, per question, same model and temperature as C:

| | input tok | output tok | latency |
|---|---|---|---|
| C | 2 616 | 74 | 2 263 ms |
| D | 3 086 | 81 | 2 324 ms |

D costs ~18% more input tokens and ~3% more latency for a 41-point accuracy gain.

## Task 3 — retrieval ceilings, stage by stage

| stage | project 01 (17 k) | project 02 (588 k) |
|---|---|---|
| extraction coverage | 100.0% | 92.5% |
| candidate recall | 100.0% | 92.5% |
| final retrieval | 89.7% | **55.0%** |
| delivery success | 100.0% | 100.0% |
| answer accuracy given oracle evidence | 70.0% | 47.5% |

The gap between "candidate recall" and "final retrieval" is the whole story on the long
project: the pipeline can *see* the right atom and cannot *keep* it.

"Answer accuracy given evidence" is the model's ceiling on this dataset with this judge:
**70% on the short project, 47.5% on the long one**, 58.8% pooled. That is the most
important number for judging the plugin, because **the model cannot be expected to exceed
it even with perfect memory**. At arm C's 17.5% pooled, the realistic headroom is roughly
41 points, not 100. The long project is harder for reasons beyond memory — 44 sessions of
dense Rust work — which is why its ceiling is lower.

## Task 4 — length control

The brief asked for 20 k / 50 k / 100 k / 300 k / 600 k. **Only three of those are usable
on this corpus**, and the reason is a property of the data, not a shortcut:

| target | actual | sessions | questions whose evidence fits |
|---|---|---|---|
| 20 k | 12 837 | 1 | 1 |
| 50 k | 35 831 | 3 | 1 |
| 100 k | 85 235 | 7 | 10 |
| 300 k | 296 704 | 25 | 26 |
| 600 k | 564 341 | 44 | 53 |

Two questions survive truncation at 20 k and 50 k, so those points cannot be paired — the
same questions are not available at every size. Running them anyway would confound
"smaller history" with "different question", so the harness refuses (`length.mjs` prints
`NOT ENOUGH COMMON QUESTIONS` and stops).

Three paired points remain, 10 common questions:

| history | A (summary) | B (tail) | C (summary + recall) |
|---|---|---|---|
| ~85 k | 2/10 (20%) | 0/10 (0%) | 2/10 (20%) |
| ~297 k | 0/10 (0%) | 0/10 (0%) | 2/10 (20%) |
| ~564 k | 2/10 (20%) | 0/10 (0%) | **4/10 (40%)** |

What this suggests, with n=10 and no significance claimed: A does not degrade as the
history grows (its summary stays ~2 k tokens whatever the input), B is near zero at every
size because 6 k tokens of the most recent tail rarely contains the evidence, and C's
advantage widens with history size. That is the expected shape, and it is far too small a
sample to call a curve.

`project_01` cannot contribute a length curve at all: its entire history is 17 k tokens, so
every target above 20 k collapses to the same prefix.

## Task 5 — cost

**One-time build** (paid once per project, amortised over all future queries):

| project | atoms | summary | build time |
|---|---|---|---|
| project_01 | 182 | 1 469 tok of 17 433 | 10.9 s |
| project_02 | 400 | 1 665–2 319 tok of 588 419 | 117.7 s |

**Marginal cost per query** (answer call, both arms pay a judge call as well):

| | answer input | answer output | judge input | judge output | latency |
|---|---|---|---|---|---|
| C | 2 616 | 74 | 220 | 43 | 2 263 ms |
| D | 3 086 | 81 | 226 | 42 | 2 324 ms |

Totals for 80 questions: **C 236 313 tokens, D 274 881 tokens**.

No currency figure is given. The endpoint publishes no per-token price I could verify, and
inventing one would put a made-up number in a report whose whole value is that its numbers
are real. Tokens are the observable unit; that is what is reported.

Router tokens: **zero in this phase.** `routerTier` was `off` in every arm, deliberately —
routing quality is a separate variable and mixing it in would have made the attribution
uninterpretable. The router's cost therefore remains unmeasured (see Phase 1's finding that
the router subagent has never run against a live model).

## Task 6 — statistics

Wilson intervals for single proportions, paired differences with a normal approximation on
the discordant pairs, and an exact McNemar test.

| comparison | difference | 95% CI | discordant | exact McNemar p |
|---|---|---|---|---|
| D − C, pooled | +41.3 pp | [26.3, 56.2] | 35 / 2 | < 0.0001 |
| D − C, project_01 | +40.0 pp | [19.2, 60.8] | 17 / 1 | — |
| D − C, project_02 | +42.5 pp | [21.1, 63.9] | 18 / 1 | — |

**The D − C difference is not the plugin's headroom.** It is the gap between the pipeline
and perfect retrieval of the labelled evidence. It establishes that the failures are
recoverable *in principle*; it says nothing about whether any particular fix captures them.

Project-level results are reported separately and deliberately **not** pooled into a
"typical project" figure: **n = 2**. Two projects cannot estimate between-project variance,
so the pooled interval above describes these 80 questions, not projects in general. Two
independent point estimates landing within 2.5 points of each other is reassuring, not
conclusive — with n=2 a shared corpus artefact would look exactly the same.

## What did not happen

- **`BUDGET_FAILURE` never fired.** Raising the recall budget from 400 to 2000 tokens in
  Phase 1's diagnosis changed nothing, and this run confirms why: the loss is in *which*
  atoms are selected, not in how much room there is. A larger budget would not fix it.
- **Extraction is not the bottleneck.** 92.5–100% coverage. The upstream suggestion to
  tighten extraction would improve noise, not accuracy on these questions.
- **The router was never invoked**, so this phase says nothing about routing quality.

## Limits, stated plainly

1. **Two projects, 80 questions.** Every interval above is wide, and the project-level
   ones cannot be generalised.
2. **The judge is an LLM** (`deepseek-v4.1-flash`, same as the subject). Its ceiling is the
   ~55% "accuracy given evidence"; a stricter or looser judge moves every number.
3. **The atom store was built by a bench-local extractor**, not by the plugin's own
   compaction observer. Store and recall are the real code; the extraction prompt is not.
4. **`actual_context_tokens` is an estimate** (`chars / 4`), matching the plugin's own
   assumption. Real tokenizer counts differ by a few percent.
5. **Facts were extracted from every session, including sessions after a question's
   evidence**, so arm C has access to later information than a real point-in-time agent
   would. This favours arm C if anything; it does not explain a 41-point gap.

## Reproducing

```
export LLM_BASE_URL=...            # OpenAI-compatible /v1
node scripts/bench/attribution.test.mjs   # classifier, no model calls
node scripts/bench/oracle-check.mjs       # answer-leakage guard, no model calls
node scripts/bench/phase2.mjs --all       # 80 questions, arms C and D
node scripts/bench/phase2-analyze.mjs     # ceilings, cost, statistics
node scripts/bench/length.mjs --project project_02_multi_repo_tool --questions 10
```

The classifier test and the oracle guard are reverse-verified: injecting each defect makes
them fail (see `attribution.test.mjs`'s reverse cases and the leakage assertion).

## The one defect worth fixing first

`DELIVERY_FAILURE` = 13 questions where a selected atom's content reached the block in a
form that no longer carries its distinctive value. That is a rendering or truncation bug
in the recall block, it affects 16% of the run, and unlike ranking it is not a trade-off —
there is no reason to prefer a block that loses the value it selected.
