# DSH Project Memory

English · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · [Español](./README.es.md)

DSH Project Memory is a plugin for DeepSeek Harness (DSH). It keeps task progress and useful project notes across sessions. When DSH replaces a long conversation with a summary, the plugin saves facts, decisions, and rules it finds in that summary. It stores them with the project so an agent can look them up later.

In v0.2.0, the plugin searches groups of related notes called memory clusters. If you configure a routing model, it can propose notes for the current task. The execution model decides which notes to load.

## Install and start

Use Node.js 20 or later and DSH `>=0.2.0-rc.0 <0.3.0`. The Windows commands below add the plugin to the `desktop` profile and link it to your local checkout.

```powershell
git clone https://github.com/iv3rins/dsh-memory.git
$checkout = (Resolve-Path .\dsh-memory).Path
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add -w "link:$checkout"
```

Restart DSH and open a session in the project you want the plugin to remember. Ask the agent to run `project_inspect` to check the project folder. Run `/memory-init` or ask the agent to call `project_init` to initialize memory. Use `/memory-status` to check the saved state and note counts.

## Use project memory

The plugin works with three kinds of information. Your Markdown files remain the source for project documentation. The plugin indexes selected files so the agent can find and read them. Task state holds progress, blockers, and next steps. Memory notes hold short facts, decisions, and rules that can be useful again.

| To do this | Use this |
| --- | --- |
| Find and read project documentation | `memory_search`, `memory_read` |
| Read task state or save progress | `state_get`, `state_update` |
| Leave a note for the next session | `state_handoff` or `/memory-handoff` |
| Look up notes for a task | `memory_intent` |
| Search notes by keyword without a routing model | `memory_recall` or `/memory-recall` |
| Save a fact, rule, or decision | `memory_remember` |
| Retire a note so future searches skip it | `memory_forget` |

The sidebar shows which recent conversation summaries produced notes. It also shows saved notes and routing model settings. Use `/memory-route` to preview a recall decision without calling the routing model.

## Review recalled notes

The plugin searches for clusters that match the task, its files, or its vocabulary. With a routing model configured, automatic recall can offer note IDs, types, cluster IDs, and any related files for review. The execution model can inspect the project before it decides which notes to load.

1. To ask for notes directly, call `memory_intent` with a `task_summary`. Include the relevant paths in `affected_modules` when you know them.
2. To accept notes, call `memory_intent` again with the `proposal_id` and the IDs to load in `accept_memory_ids`. An empty list rejects the entire proposal.
3. To try again, pass the `proposal_id` and `feedback` that describes what you found in the project. This rejects the current proposal. The next search uses the feedback and skips notes rejected during this review. You can repeat this step.

The routing model can report that it found no relevant notes. A failed routing model request also ends the lookup without delivering note text.

| `routerTier` | What automatic recall does |
| --- | --- |
| `off` | Uses local matching and makes no model calls. |
| `smart` (default) | Uses local matching first. It can ask the routing model if the match is weak or empty and candidate notes are available. A strong match can produce a proposal without a model call. |
| `always` | Asks the routing model when candidate notes are available. |

Without a configured routing model, local matching can return notes directly. A direct `memory_intent` lookup can ask the configured routing model even when the local match is strong.

## Configure a routing model

For a model served by DSH, set `routerProvider` and `routerModel` in the profile. For an independent service, open **Configure routing model** in the sidebar. Enter the **Base URL** and an API key if the service requires one. Choose **Fetch models**, select a model, then choose **Use this model**.

Use HTTPS for a remote service. A local service can use a loopback address such as `http://127.0.0.1:8080/v1`. DSH saves the API key in its credential store. The connection applies to all projects in the profile. Each model request sends the task and excerpts of candidate notes to the selected service. Choose **Restore DSH routing model** to remove the independent connection.

| Setting | Default | Purpose |
| --- | --- | --- |
| `injectContext` | `true` | Adds a short project briefing and enables automatic recall. |
| `injectRecall` | `true` | Enables note recall, including `memory_intent`. |
| `recallBudget` / `recallLimit` | `400` / `8` | Limits tokens and notes in automatic recall. |
| `routerStrategy` | `task` | Focuses model selection on the task. Other values are `compliance` and `orient`. |
| `routerTimeoutMs` / `routerDigestBudget` | `20000` / `900` | Sets the timeout in milliseconds and the estimated input token limit per model call. |

The routing tier, strategy, DSH provider and model, and recall limits can vary by project. An existing `localRouterEndpoint` setting still works with a loopback chat-completions endpoint.

## Where memory lives

The plugin stores task state in `.dsh-memory/state/current.json` and notes in `.dsh-memory/memory/atoms.jsonl`. It also stores project settings, a history of state changes, and an index of your Markdown files under `.dsh-memory/`. The index can be rebuilt from the source files.

The first write that changes an older note store moves its notes into clusters. The migration keeps note IDs, source details, and records of forgotten notes. Use v0.2.0 or later to read the migrated file. Forgetting a note marks it as retired in the store. The mark keeps the note out of search and prevents the plugin from adding it again from a later summary.

## Run the tests

Run `npm test` for unit tests. On a development machine with DSH installed, run `npm run setup` to link the host packages. Then run `npm run test:all` to include the host integration tests.

The test suite checks store migration, model requests, and the approval flow. Model tests use simulated responses. Live model accuracy and the speed of clustered search still need measurement. See [test coverage and limits](./LIMITATIONS.md) for details.

## License

[MIT](./LICENSE) © 2026 iverins
