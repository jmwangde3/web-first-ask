# D9 test — does Gemini reuse a `--conversation-id` key?

Status: **awaiting a live run** (2026-11-26). No live logged-in Chrome exists on
the dev VM, so this procedure has not been executed. Do not treat D9 as a
defect — or as fixed — until this test has run on Windows with a logged-in
Gemini account.

## Background

`--conversation-id` is a **local key**, not a cloud conversation id. The first
use opens a new conversation and stores its URL in the conversation store;
later uses with the *same key* load that URL and continue the same
conversation (`src/engines/cdp-engine.js` loads the stored session and
navigates to `restoreUrl`; `src/browser/conversation-store.js` owns the file).

On ChatGPT this works: two consecutive asks with the same key returned
`userTurns: 2` and kept the conversation title. The Gemini case has **not**
been re-tested with this same-key method, after an earlier report that a
reused identifier produced a new conversation each turn.

## Preconditions

- Windows, logged-in Gemini account in the Chrome profile wfa uses.
- `wfa doctor` passes; `wfa cdp login --provider gemini` already done.
- No other Gemini turn running with the same key at the same time (same
  conversation runs strictly serial).

## Procedure (manual commands)

Use a fresh key you have never used before, e.g. `d9-test-1`. The two
prompts must be distinguishable so you can tell which answer belongs to
which turn; the second one must reference the first, so a fresh
conversation cannot fake a pass.

```powershell
# Ask #1 — opens a NEW Gemini conversation, stores its URL under the key.
node bin/wfa.js cdp ask --provider gemini --conversation-id d9-test-1 `
  --prompt "Reply with exactly: FIRST-OK" --mode background --json
# Note the task id, then read it back:
node bin/wfa.js cdp read --task-id <id-1> --provider gemini --json

# Ask #2 — SAME key. Must reuse the stored URL, not open a new conversation.
node bin/wfa.js cdp ask --provider gemini --conversation-id d9-test-1 `
  --prompt "Reply with exactly: SECOND-OK, and quote the previous reply's marker word" `
  --mode background --json
node bin/wfa.js cdp read --task-id <id-2> --provider gemini --json
```

Or run the scripted form (does exactly the two asks above, nothing more):

```powershell
node scripts/gemini-conversation-reuse.mjs --key d9-test-1 `
  --prompt1 "Reply with exactly: FIRST-OK" `
  --prompt2 "Reply with exactly: SECOND-OK, and quote the previous reply's marker word"
```

## What to observe

For each ask, record from the `read --json` output:

| Field | Ask #1 | Ask #2 |
|---|---|---|
| `conversationUrl` | (new URL) | must equal ask #1's URL |
| `evidence.userTurns` | 1 | 2 |
| `evidence.title` | (title, may be empty at first) | same as ask #1 |
| `status` | `completed` | `completed` |
| Answer text | contains `FIRST-OK` | contains `SECOND-OK` **and** `FIRST-OK` |

Also inspect the conversation-store entry for the key. On Windows it is:

```
%LOCALAPPDATA%\web-first-ask\conversations\gemini\<sha256("d9-test-1")>.json
```

Record its `conversationUrl` and `turnCount` after each ask (`turnCount`
should go 1, then 2). The scripted harness prints the store path and entry.

## Pass / fail criteria

**PASS** — all of these:

- `conversationUrl` is identical for ask #1 and ask #2;
- `userTurns` is 1 after ask #1 and 2 after ask #2;
- ask #2's answer quotes `FIRST-OK` (proves it saw the earlier turn);
- the store entry's `conversationUrl` equals that URL and `turnCount` is 2.

**FAIL** — any of these:

- ask #2's `conversationUrl` differs from ask #1's (new conversation opened);
- `userTurns` is 1 after ask #2 (the second turn landed in a fresh thread);
- ask #2's answer does not contain `FIRST-OK` (no shared context);
- the store entry's URL changed between the two asks (the second ask
  overwrote the stored URL instead of reusing it).

A title difference alone is **not** a failure: Gemini names a conversation
after the first answer, so an empty title on ask #1 is expected. Only a
real mismatch between two non-empty titles counts, and it is reported as
informational, not as a fail.

## If it fails, capture this before doing anything else

1. The store entry file above (copy it aside — do not edit it in place).
2. Both `read --json` outputs (ask #1 and ask #2), including
   `conversationUrl`, `evidence.userTurns`, `evidence.title`.
3. Both task ids and the two conversation URLs from the Gemini UI.
4. Whether the Gemini UI shows one conversation with two user turns or two
   separate conversations (check the sidebar / history).

Then file the result as a confirmed D9 defect with those four items
attached. Do **not** change the reuse code on the basis of an unverified
report, and never auto-resend a prompt to "fix" a failed reuse.

## If it passes

D9 is closed as not-reproduced on the current same-key method. Record the
run date, the two task ids, and the URLs in the backlog entry.
