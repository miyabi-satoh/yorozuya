# Area prompt template

Fill every `{…}`. Keep it in English (fewer tokens) and quote UI strings verbatim in the original language. One prompt per area; the parts outside "Your scope" and "What to look for" are the same for every area.

```
## Goal
Desk check (source-level audit by reading; nothing is built or run) of {app} before {timing}. {2–4 sentences: what the app is, stack with versions, who uses it and how, the actors it admits (anonymous / logged-in / admin / other devices on the LAN / files from outside).} Repo: {absolute path} (branch {branch} at {sha}, clean).

Find defects a real user (or a realistic actor the app's own model admits) would actually hit. {Which OS matters most}, but report other OS bugs too.

## Your scope (read fully, line by line; test modules can be skimmed)
- {files / directories}
- Cross-cutting duty: {optional: one sweep that spans areas, e.g. enumerate every route and check its guard against {doc}; every setting written to disk and whether unknown values survive a save}
{N} other agents cover: {one phrase per other area}. Read into their files only as far as needed to follow a call path.

## Read first for intended behavior
- {repo instruction file}, {design docs / decision records / specs that cover this area}, {manual pages for this area}
- {code navigation tool, if the repo has one}

## What to look for
{Area-specific checklist: 5–10 bullets naming the concrete mechanisms in this area (e.g. "restore: order of table copies vs. triggers", "number inputs: is the value rewritten while typing").}
Always, in addition:
- Data loss: overwrite/delete/move paths, partial failure in the middle of a multi-step operation, retry after a failure, saving a file that was not fully read, unknown values dropped on save
- Stuck states: operations that cannot be cancelled, cancelled UI that still executes, waits with no timeout, a failure that leaves no visible sign, states only a restart clears
- OS-specific traps: path length and encoding (UTF-16 vs bytes, NFC/NFD), case-insensitive file systems, removable/network drives, line endings, keyboard layouts, store-packaged app lifecycle (update/restart/sandboxed paths), sleep/resume
- Convention gaps: the repo's own rules (instruction file, docs) that this code does not follow
- Docs/decision mismatches: behavior that differs from what the docs, decision records or manual say, in a way the user would notice
- Reachable panics/crashes on user-controlled input; blocking work on an async runtime

## Not wanted
Style, naming, refactors, missing tests, purely theoretical issues with no realistic trigger, hardening wishes without a concrete scenario, anything the linters/CI already catch.

## Constraints
- Read-only. Do not edit any file. Do not run builds, tests, servers or package managers. grep/sed/cat and the code navigation tool are fine. No browser tools.
- Do not read places that trigger OS permission dialogs ({e.g. on macOS: ~/Documents, ~/Desktop, ~/Downloads}).
- Dependency behavior: read the pinned version's source ({e.g. ~/.cargo/registry/src/*/<crate>-<version>/, node_modules/<pkg>}; version from the lock file) instead of recalling it.

## Return format (English, itemized, no prose intro; quote UI strings verbatim)
For each finding:
- severity: blocker / high / medium / low
- OS: {list} / all
- location: path:line (and the relevant caller path:line)
- defect: one sentence
- failure scenario: concrete actor/state/inputs → wrong result the user sees
- evidence: the call path you read; mark `CONFIRMED` (read every hop) or `SUSPECTED` (say which hop is unverified and why: OS behavior / dependency not read / runtime value)
- fix direction: one or two sentences
Then: (a) files/line ranges read in full, (b) anything in scope NOT read, (c) things you checked and found sound that a reviewer would likely suspect (short list).
An empty findings list is acceptable — do not pad. Before reporting each finding, re-read the code once more looking for a guard that makes it unreachable.
```
