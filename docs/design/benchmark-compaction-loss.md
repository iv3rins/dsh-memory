# Compaction loss and recall: a measured comparison (2026-11-06)

This document reports what was actually measured, on what data, with which model, and
what the numbers do and do not mean. Every figure here comes from a stored run under
`_bench/codememo/results/`; nothing is extrapolated.

## The question

After a long development history is compacted, how much of it can still be recovered?

- by **the compaction summary alone** (what a native checkpoint leaves behind),
- by **nothing** (only the recent tail of the conversation),
- by **the summary plus this plugin's atom recall**.

## Why this dataset

[CodeMemo](https://huggingface.co/datasets/laynepro/codememo-benchmark) pairs realistic
multi-session development transcripts with questions whose answers have a recorded
evidence turn. Three projects are shipped; two were used:

| project | sessions | transcript | questions |
|---|---|---|---|
| `project_01_cli_tool` | 15 | ~17 k tokens | 50 |
| `project_02_multi_repo_tool` | 44 | ~588 k tokens | 53 |

The second is the point of the exercise: 588 k tokens cannot fit in a 6 k-token context,
so the two ends of the comparison are genuinely different information sets rather than
two views of the same text.

`manifest.json` was **not** used as model input. It contains `key_decisions` and
`conventions` lists that overlap two of the questions' reference answers verbatim, which
would have leaked answers into the context.

## Method

40 questions per project, chosen by a deterministic hash of the question id so a rerun
scores the same set. All arms see the same question and the same judge; only the history
differs.

| arm | context handed to the model |
|---|---|
| **A** | the compaction summary only (~1.3 k / ~2.0 k tokens) |
| **B** | the last 6 k tokens of the raw transcript |
| **C** | the same summary as A, plus the atoms `recallForStep` selects (~0.4 k tokens) |

Answers are graded by an LLM judge into `CORRECT` / `PARTIAL` / `WRONG` against the
dataset's own reference answer. `PARTIAL` is reported separately and also folded into a
partial-credit score, so the headline number cannot hide a pile of near-misses.

Model and judge: `deepseek-v4.1-flash`, temperature 0.

Arm C uses the plugin's real code: atoms are written through `recordAtoms` into a
throwaway project root and read back through `recallForStep` with `routerTier: 'off'`.
Routing quality was deliberately excluded — the question was about compaction loss, and
turning the router on would have injected a second unmeasured variable.

Atoms were extracted **per session**, stamped with their source session, by a two-pass
extractor (facts within a window; then "what changed" across the session). 182 atoms for
project 01, 400 for project 02.

## Result

### Pooled, 80 questions

| arm | correct | 95% CI | partial-credit |
|---|---|---|---|
| A — summary only | 13/80 = **16.3%** | 9.7–25.8% | 32.5% |
| B — tail only | 12/80 = **15.0%** | 8.8–24.4% | 20.0% |
| C — summary + recall | 20/80 = **25.0%** | 16.8–35.5% | **41.9%** |

Paired differences (McNemar on discordant pairs):

| comparison | difference | 95% CI |
|---|---|---|
| C − A | **+8.8 pp** | −0.7 … +18.2 |
| C − B | **+10.0 pp** | −1.0 … +21.0 |
| B − A | −1.3 pp | −10.7 … +8.2 |

### By project

| project | A | B | C | C − A |
|---|---|---|---|---|
| `project_01` (17 k tok) | 30.0% | 30.0% | 40.0% | +10.0 pp, CI −7.0 … +27.0 |
| `project_02` (588 k tok) | 2.5% | 0.0% | 10.0% | +7.5 pp, CI −1.0 … +16.0 |

Context cost per answer: A ~1 655 tokens, B ~6 000, C ~1 979.

## What these numbers say

1. **On a small history the summary is competitive.** At 17 k tokens, A and B are
   identical (30.0% each, difference 0.0 pp). Compaction is not the bottleneck when the
   history nearly fits anyway.

2. **On a long history everything collapses, and memory collapses least slowly.** At
   588 k tokens, A drops to 2.5% and B to 0.0%, while C holds 10.0%. The absolute numbers
   are low for all arms — that is the honest finding, not a rounding artefact.

3. **Recall buys back about a third of the partial credit.** Pooled partial-credit goes
   32.5% (A) → 41.9% (C). Answers get closer to right even when they are not scored fully
   correct, which is what a reference-based judge should show when context improves
   without becoming sufficient.

4. **Every interval crosses or touches zero at n=40 per project.** The pooled
   C − A interval is −0.7 … +18.2 pp: consistent with anything from no effect to a
   ~18-point effect. **This is not yet a statistically established improvement.** It is a
   measurement that leans consistently the same way in both projects and in the
   partial-credit score, which is what justifies running a larger sample — not what
   justifies claiming a number.

5. **The consistent-sign, small-magnitude pattern is the result.** C−A is positive in
   both projects individually (+10.0 and +7.5 pp) and in the pooled figure (+8.8 pp), and
   C−B is positive too. Three consistent signs from independent slices is a reason to
   continue, not proof.

## What this does NOT show

- **It does not measure "how much text compaction permanently destroys."** Every question
  in CodeMemo has its answer somewhere in the raw transcript — verified with
  `scripts/bench/where.mjs`, which found 0 of 101 questions answerable *only* from a
  summary. What is measured is **retrievability under a budget**, which is the practical
  question but a narrower claim than "compaction loss".
- **It does not measure routing quality.** `routerTier` was `off`.
- **It does not measure the plugin on a real project.** The atoms were extracted by a
  bench-local extractor, not by the plugin's own compaction observer. The *store and
  recall path* are the plugin's real code; the *extraction prompt* is not.
- **One judge, one model, n=80.** A different judge could move several points.
- **`project_03` was not run.** Its transcripts are image-heavy and its 1.9 M-token
  history is outside the budget this harness was built for.

## Reproducing

The harness reads two things from the environment and never from a literal:

- `LLM_BASE_URL` — an OpenAI-compatible `/v1` endpoint. Required; the scripts refuse to
  guess one, because a private host hard-coded here would be useless to a reader.
- `LLM_MODEL` / `JUDGE_MODEL` — default `deepseek-v4.1-flash`.

The API key is read from the harness's own credential store
(`$DSH_HOME/.credentials.yaml`, else `~/.dsh/.credentials.yaml`), key `AIRELAY_API_KEY`,
and is never printed.

Data: download the three CodeMemo projects into `_bench/codememo/` (transcripts under
`<project>/session_NNN.jsonl`, questions as `<project>-questions.json`). The corpus is
~277 MB and is gitignored.

Then:

```
node scripts/bench/validate.mjs          # questions vs corpus, before spending calls
node scripts/bench/recoverability.mjs project_01_cli_tool 40   # free: can recall reach the evidence at all?
node scripts/bench/codememo.mjs --project project_01_cli_tool --questions 40
node scripts/bench/codememo.mjs --project project_02_multi_repo_tool --questions 40
node scripts/bench/aggregate.mjs      # pooled table, Wilson intervals, paired differences
node scripts/bench/selfcheck.mjs      # structural checks on the stored runs
node scripts/bench/reverse-check.mjs  # injects defects, confirms selfcheck goes red
```

`recoverability.mjs` is worth running first: it costs no model calls and reports whether
the atoms can reach the evidence at all. If that number is low, the answer arms cannot
succeed and the run is wasted.

`selfcheck.mjs` and `reverse-check.mjs` exist because two defects in this harness
produced plausible-looking numbers before being caught: an un-awaited store write (which
made recall return "no atoms are stored") and a summariser that only ever saw the tail of
a 588 k-token transcript (which produced 72 tokens of tool-call debris and zeroed arm A).
Both are now covered by an assertion that has been observed failing.

## Corrections made during this work

Recorded so the numbers are auditable:

| defect | effect if unnoticed | fix |
|---|---|---|
| `curl` without `-L` | downloaded redirect pages instead of data | follow redirects |
| parser read only `message.content` arrays | dropped ~80% of each transcript, including the string-form continuation summaries | accept string content, filter record types |
| `recordAtoms` not awaited | store was empty; recall reported "no atoms are stored for this project yet" | await the write, assert `live` |
| single-call compaction over the tail | summary saw 0.4% of a 588 k-token history, produced 72 tokens | map-reduce over 30 chunks, then reduce |
| "newest run" picked by naive `split('-')` | aggregation reported a superseded run | split on the ISO stamp |

The three runs made before the compaction fix are kept under
`_bench/codememo/results/invalid-broken-compaction/` and are excluded from every figure
above.
