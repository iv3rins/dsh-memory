# Known limitations

This file lists what the plugin does **not** do, and what it does with less
confidence than a reader might assume. It is deliberately blunt: a memory plugin that
overstates itself is worse than one that forgets, because a confident wrong memory is
harder to correct than an acknowledged blank.

## Verified against a real host

- Mounting into a real cordis context with the real `ToolRuntime`, registering all 15
  tools, executing them through the registry's own checks, and disposing cleanly.
  (`tests/mount.mjs`)
- The harness's enforced JSON Schema subset accepts every tool declaration.
  (`tests/tools.mjs`)
- `agent/pre-step` injection returns messages through the decision, and dedupe scans
  the session surface. (`tests/inject.mjs`)
- State, decisions, blockers, and the document index survive a simulated restart, and
  a real moving git HEAD makes the memory report itself stale instead of fresh.
  (`tests/continuity.mjs`)
- All 15 tools still register and respond when `commands` and `workingDirectory` are
  absent. (`tests/degrade.mjs`)
- Protected paths are refused and the originals stay byte-identical; a hostile
  proposal title cannot redirect a write out of `docs/proposals/`.
  (`tests/safety.mjs`)
- The host's own `evaluatePluginCompatibility` accepts this manifest, rejects an
  unsatisfiable range, and throws on a malformed one; `engines.dsh` takes priority over
  `peerDependencies` exactly as the host implements it. (`tests/compat.mjs`)
- `cordis.patch.yml` resolves through the host's own `bundlePatchPaths` to one existing
  file whose insert row names a loadable plugin. (`tests/patch.mjs`)
- The full memory loop, driven through the real services rather than by calling our own
  functions: a `compaction/summary` event dispatched on `session/event` writes atoms to
  disk with provenance, the next `agent/pre-step` waterfall returns a recall message
  containing them within the count limit, replaying the same compaction adds nothing, a
  repeat of the same atom set is not re-injected, and a forgotten atom is absent from
  the following recall. (`tests/loop.mjs`)
- The plugin installs into a real profile with one `dsh plugin add` command, appears in
  `dsh.profile.bundles` automatically, loads at host startup, and serves all fifteen
  tools plus a live-updating L1 baseline and a per-step recall block. (observed in a
  running desktop session)

## Not verified end to end

- **The GUI session run was shallow.** The plugin is installed in the `desktop` profile
  and all fifteen tools, the baseline, and per-step recall were exercised in a real
  session, but that session was not task-heavy: no real compaction, no resume, no branch
  switch, and no long-horizon multi-session use. Those are the conditions the plugin is
  designed for and the ones it has been least exposed to.
- **The router subagent has never run against a live model.** `runRouter` is covered by
  unit tests with a stubbed delegate (including timeout, abort, malformed reply, and
  unknown ids), and the delegate's construction is checked against the real
  `startActivation` signature — but no real spawn has been observed producing a real
  selection. The `smart` tier degrades to deterministic selection if the router fails,
  so the failure mode is a missed improvement, not a broken step.
- **Injection is observed, but the compaction-shadow case is not.** The L1 baseline
  arrived in the running session and updated live after a `state_update`, and the recall
  block arrives with its own source kind. The *shadowing* case — a recall message removed
  from the surface by a real compaction, so it should be sent again — is covered by
  `tests/loop.mjs` against a constructed session, not against a real compaction.
- **The `agent/created` start `source` is not relied on.** Only `startup` was observed
  being announced in the local build. Resume/clear/compact handling is therefore a
  fast path, and correctness rests on the surface scan instead.

## Behavioural limits by design

- **Search is lexical.** Token matching with weighted fields — no embeddings, no
  synonyms, no stemming beyond lowercasing. A query in different words than the
  document will miss. `memory_search` is a finder, not a understanding.
- **Atom scoring is lexical too.** The gate ranks by overlap, kind, reinforcement, and
  recency. A memory phrased nothing like the request will rank low — which is why hard
  constraints get a capped share of the budget regardless of wording, and why the router
  tier exists at all.
- **Atoms are not authoritative documents.** A recalled atom is a sentence with
  provenance, not a spec. It can be stale, it can be an oversimplification of what the
  summary said, and it is framed as data. Anything that matters belongs in a document,
  where `memory_read` can return the whole section.
- **`memory_forget` is a tombstone, not a deletion.** The record stays in
  `atoms.jsonl` as evidence and the tombstone is sticky, so re-extraction cannot undo
  the decision. A reader of the file still sees the text.
- **One router call per step, at most.** `routerCooldownSteps` and the per-turn identity
  cache keep `always` from spending twice on the same request, and `routerTimeoutMs`
  bounds a single call. A slow router costs latency, not the step: the deterministic
  answer is used instead.
- **Router output is untrusted.** Only ids from the supplied digest are honoured; an id
  the router invents is discarded and counted in `rejected`. The router never writes to
  the store.
- **Extraction is deliberately conservative.** A deterministic parser over the
  compactor's known section headings, not a model call. What it cannot parse becomes no
  atom — a missing atom costs one search, a fabricated one corrupts every later turn.
- **Harness boilerplate is filtered, not stored.** Runtime-context preambles, checkpoint
  headers, and the plugin's own recall block are recognized and dropped before they
  become atoms. The filter is anchored and specific; a genuine rule that happens to start
  with one of those phrases would be dropped.
- **State is written by tool calls only.** The plugin never scrapes a conversation to
  infer progress. An agent that does not call `state_update` produces no state memory,
  and a session that ends without `state_handoff` leaves no handoff note.
- **No git operations.** It reads branch, HEAD, dirtiness, and remote to compute
  staleness. It never commits, branches, merges, or pushes.
- **No cross-project query.** One project root per call. A monorepo's sub-projects are
  separate memories.
- **No client UI.** No sidebar panel, no status indicator. Everything is tools,
  commands, and injected context.
- **`docs_sync` never rewrites authoritative docs.** It refuses `AGENTS.md`,
  `docs/decisions/`, `docs/adr/`, and `.git/`, and writes proposals to
  `docs/proposals/`. That refusal is the design, not a missing feature.
- **`architecture_check` implements one rule kind.** `forbid-import`, checked with a
  regex scan over JavaScript, TypeScript, C#, and Java. It is not a type-aware
  analyzer; it does not resolve re-exports or dynamic paths built at runtime.
- **`architecture_check` line numbers are regex-derived.** A computed or generated
  import may be reported at the wrong line. The file and resolved target are
  trustworthy; the line is a hint.

## Environment limits

- **Requires Node 20+**, matching the harness.
- **Windows is the only tested platform.** Paths are normalized through one helper and
  containment is checked case-insensitively on Windows, which is where the risk lives;
  Linux and macOS are intended to work but have not been run.
- **The host packages come from an extraction, not an install.** `npm run test:host`
  links `node_modules/@deepseek-ai` at `_research/asar-nm`, which is a dump of the
  installed Desktop payload. A host upgrade makes that copy stale; re-extract before
  trusting a passing host test after upgrading DSH.
- **`_research/` is not part of the published package.** The published files are `lib`,
  `core`, `cordis.patch.yml`, `README.md`, and `LIMITATIONS.md`. The extraction exists
  only to make the host tests runnable from this checkout.
- **Concurrent writers are serialized by a lock file**, not by a database. A process
  killed mid-write leaves a lock that is stolen after 30 seconds. Two agents writing
  the same project within that window will see a conflict rather than corruption, but
  conflicts are a normal cost here, not an exception path.

## Deliberately out of scope for this version

Vector search. Automatic commits. Automatic rewriting of authoritative documentation.
Cross-project knowledge graphs. A UI. Each of these would change the plugin's risk
profile — the current design's whole claim is that it only ever writes inside
`.dsh-memory/` (plus `docs/proposals/` when explicitly asked).
