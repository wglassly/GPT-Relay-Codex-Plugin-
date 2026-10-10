#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { launchChrome } from "./chrome_session.mjs";
import { runExtendedProRelay, pollRelaySession, listRelaySessions } from "./chatgpt_relay.mjs";
import { createPlaywrightBrowser, requireSignedIn } from "./playwright_browser.mjs";

const HELP = `GPT Relay: experimental text-only CLI

  npm run relay -- login
  npm run relay -- ask "Reply with exactly RELAY_OK"
  npm run relay -- ask --prompt-file /absolute/path/question.txt
  npm run relay -- poll
  npm run relay -- close

Options:
  --profile PATH     Dedicated Chrome profile (default: ~/.codex/gpt-relay/cli/chrome)
  --timeout SECONDS  Answer deadline (default: 600)
  --chrome PATH      Chrome executable (normally detected automatically)
  --json             Print the result as JSON instead of Markdown
  --help             Show this help

Login opens a dedicated Chrome window. Sign in manually and leave it open.
Ask reconnects to Chrome and starts a new conversation in one reusable relay tab.
Close quits the dedicated browser normally. Its profile stays on disk for the next launch.
This prototype supports text only, without attachments, model switching or Deep Research.
Chrome must be installed. Use one relay process per profile at a time.
`;

let session;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await session?.close();
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await close();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      profile: { type: "string" },
      chrome: { type: "string" },
      timeout: { type: "string", default: "600" },
      "prompt-file": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
  } else {
    const [command, ...words] = positionals;
    if (!["login", "ask", "poll", "close"].includes(command)) throw new Error(`Unknown command: ${command}`);
    const timeoutMs = Number(values.timeout) * 1000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 86400000) {
      throw new Error("--timeout must be between 0 and 86400 seconds (exclusive of 0).");
    }
    if (values["prompt-file"] && words.length) throw new Error("Use either a prompt argument or --prompt-file.");
    if (command !== "ask" && (words.length || values["prompt-file"])) throw new Error(`${command} does not take a prompt.`);
    const prompt = values["prompt-file"]
      ? await readFile(path.resolve(values["prompt-file"]), "utf8")
      : words.join(" ");
    if (command === "ask" && !prompt.trim()) throw new Error("Provide a non-empty prompt or --prompt-file.");
    const dataDir = path.join(homedir(), ".codex", "gpt-relay", "cli");
    const profile = path.resolve(values.profile ?? path.join(dataDir, "chrome"));
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    process.stderr.write(`Chrome profile: ${profile}\n`);
    session = await launchChrome(profile, { executable: values.chrome, start: command !== "close" });
    if (command === "login") {
      const page = session.context.pages().find(p => p.url().startsWith("https://chatgpt.com/")) ?? await session.context.newPage();
      if (!page.url().startsWith("https://chatgpt.com/")) await page.goto("https://chatgpt.com/");
      await page.bringToFront();
      process.stdout.write("Sign in manually in this Chrome window and leave it open. Then run ask; no automatic login is attempted.\n");
    } else if (command === "close") {
      await session.shutdown();
      process.stdout.write("Relay Chrome closed. The dedicated profile remains on disk.\n");
    } else {
      process.stderr.write(command === "poll" ? "Reading the most recent saved conversation without resending…\n" : "Sending one text prompt to ChatGPT; waiting for the complete response…\n");
      const statePath = path.join(dataDir, "sessions.json");
      const previous = (await listRelaySessions({ statePath, limit: 1 }))[0];
      const options = {
        browser: createPlaywrightBrowser(session.context, {
          afterNavigate: requireSignedIn,
          reuseTab: true,
          previousConversationUrl: previous?.conversationUrl,
        }),
        prompt,
        inferIntelligenceFromPrompt: false,
        keepTab: true,
        timeoutMs,
        statePath,
      };
      const result = command === "poll" ? await pollRelaySession(options) : await runExtendedProRelay(options);
      if (result.status !== "complete") throw new Error(`Conversation is still pending: ${result.conversationUrl}. Run poll again; do not resend.`);
      process.stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.finalDeliveryText}\n`);
    }
  }
} catch (error) {
  process.stderr.write(`${error.code ?? "RELAY_ERROR"}: ${error.message}\n`);
  if (error.lastState?.url) process.stderr.write(`Conversation: ${error.lastState.url}\nDo not resend automatically; the answer may still be running.\n`);
  process.exitCode = 1;
} finally {
  await close();
}
