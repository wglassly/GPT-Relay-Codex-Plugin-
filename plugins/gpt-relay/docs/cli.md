# Standalone text relay CLI

This experimental fork adds a terminal entry point for the smallest relay workflow: send one text prompt to the ChatGPT website, wait for the response, and print its Markdown and conversation URL. Codex CLI can invoke this command through its shell tool.

## Setup

Install Node.js 22+ and Google Chrome, then run these commands from the repository root:

```bash
npm ci
npm run relay -- login
```

Sign in to ChatGPT manually in the dedicated Chrome window and leave it open. The CLI does not type credentials or handle verification challenges. Run:

```bash
npm run relay -- ask "Reply with exactly RELAY_OK"
```

The browser stays open across commands. Each `ask` connects to that same browser process and starts a new conversation in one reusable relay tab, rather than opening a tab per question. Earlier conversations remain in ChatGPT history and the local session file. It leaves the latest conversation available for inspection. To quit the dedicated browser normally:

```bash
npm run relay -- close
```

The profile remains on disk. Authentication may expire or require verification; profile persistence does not guarantee that ChatGPT will keep a particular account signed in. If a fresh launch shows a login page, run `login` and sign in again.

## Inputs and output

For a longer prompt, provide a UTF-8 text file. Its contents become the message; the file is not uploaded as an attachment.

```bash
node plugins/gpt-relay/scripts/cli.mjs ask --prompt-file /absolute/path/question.txt
node plugins/gpt-relay/scripts/cli.mjs ask "Explain binary search" --timeout 300 --json
```

Invoke `node` directly when scripting: it writes only the answer (or JSON) to stdout, with progress/errors on stderr, and exits nonzero on failure. `npm run` can add npm's own output prefix. `--timeout` is the answer polling deadline in seconds; browser startup and page preparation are additional. No failed or timed-out prompt is automatically resubmitted. On a timeout, the browser stays open and the command prints the conversation URL when one was captured.

To recover the most recent saved conversation after a timeout or interrupted CLI process, without sending another prompt:

```bash
npm run relay -- poll --timeout 300
```

`poll` reuses the matching open tab when possible. If that tab was closed, it opens the saved conversation URL. It operates on the most recent record in this CLI's session file.

Options:

- `--profile PATH`: dedicated Chrome user-data directory.
- `--chrome PATH`: Chrome executable if it is not in the detected standard location.
- `--timeout SECONDS`: answer deadline, default 600, maximum 86400.
- `--json`: print the upstream result object, including session metadata.
- `--help`: show usage.

## Local state

The default directory is `~/.codex/gpt-relay/cli/`:

- `chrome/`: dedicated Chrome profile, including its locally persisted login state.
- `chrome/.relay-endpoint.json`: PID and loopback debugging port for reconnecting to the running browser.
- `sessions.json`: upstream conversation metadata and responses.

State is stored outside the repository. Do not commit a custom profile or session file. The browser debugging endpoint listens on loopback. The CLI does not extract cookies or copy an existing personal Chrome profile. Use one relay command per profile at a time. Keep the relay profile dedicated to this tool.

## Scope

The CLI uses the current visible ChatGPT selection. Mentioning a model inside the prompt does not change that selection. Model switching, attachments, image generation, Deep Research export, and follow-up messages are outside this initial CLI scope. The original desktop plugin and its defaults remain available.

The adapter recognizes the known English/Chinese composer and send controls. Website changes can require selector updates. Completion uses the upstream stable-text and generation-state checks, so an answer takes a few seconds to settle before it is returned.

## Validation

```bash
npm test
```

The browser adapter tests use locally fulfilled pages, without sending a ChatGPT prompt. They exercise the upstream helper through actual Chrome: one submission, waiting through streaming, Markdown extraction, conversation persistence, and rejecting an anonymous composer before submission. A real ChatGPT login and live prompt are a separate smoke test.

The prototype was also smoke-tested on macOS with a signed-in Chrome session: `ask` returned `RELAY_SECOND_OK` and a conversation URL; `poll` recovered the earlier `RELAY_OK` response without resending. Multiple CLI processes successfully reconnected to the same running browser. Authentication persistence after a full browser shutdown has not been established in this test; keep the dedicated Chrome instance open for the verified workflow.
