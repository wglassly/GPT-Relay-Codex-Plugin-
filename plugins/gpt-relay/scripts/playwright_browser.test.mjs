import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { runExtendedProRelay, pollRelaySession } from "./chatgpt_relay.mjs";
import { createPlaywrightBrowser, requireSignedIn } from "./playwright_browser.mjs";

const fixture = `<!doctype html><html><head><meta charset="utf-8"><title>Relay test</title></head><body>
<button data-testid="accounts-profile-button">Account</button>
<main><div id="messages"></div></main>
<div style="display:flex; align-items:center; margin-left:280px">
  <div id="prompt-textarea" role="textbox" contenteditable="true"
    aria-label="Chat with ChatGPT" style="width:300px; height:60px"></div>
  <button>Instant</button>
  <button data-testid="send-button" aria-label="发送消息">发送</button>
</div>
<script>
window.submissions = 0;
document.querySelector('[data-testid="send-button"]').onclick = () => {
  window.submissions++;
  const prompt = document.querySelector('#prompt-textarea').innerText;
  const user = document.createElement('div');
  user.setAttribute('data-message-author-role', 'user');
  user.textContent = prompt;
  document.querySelector('#messages').append(user);
  history.pushState({}, '', '/c/relay-fixture');
  const reply = document.createElement('div');
  reply.setAttribute('data-message-author-role', 'assistant');
  reply.setAttribute('aria-busy', 'true');
  reply.innerHTML = '<p>Partial</p>';
  document.querySelector('#messages').append(reply);
  setTimeout(() => {
    reply.innerHTML = '<h2>RELAY_OK</h2><p>Preserve <strong>bold</strong> and <a href="https://example.com/">links</a>.</p><pre><code class="language-js">const answer = 42;</code></pre>';
    reply.removeAttribute('aria-busy');
    const copy = document.createElement('button');
    copy.setAttribute('aria-label', 'Copy response');
    copy.textContent = 'Copy';
    document.body.append(copy);
  }, 1000);
};
</script></body></html>`;

test("Playwright adapter sends once and returns the finished Markdown through the upstream helper", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "relay-adapter-"));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const context = await browser.newContext();
    await context.route("**/*", route => route.fulfill({ contentType: "text/html", body: fixture }));
    const statePath = path.join(dir, "sessions.json");
    const result = await runExtendedProRelay({
      browser: createPlaywrightBrowser(context, { afterNavigate: requireSignedIn }),
      // Mentioning a model in a question must not trigger CLI model switching.
      prompt: "What does GPT 5.5 Pro Extended mean?",
      inferIntelligenceFromPrompt: false,
      statePath,
      timeoutMs: 15000,
      keepTab: false,
    });
    assert.equal(result.status, "complete");
    assert.match(result.finalDeliveryText, /## RELAY_OK/);
    assert.match(result.finalDeliveryText, /\*\*bold\*\*/);
    assert.match(result.finalDeliveryText, /\[links\]\(https:\/\/example\.com\/\)/);
    assert.match(result.finalDeliveryText, /```js\nconst answer = 42;/);
    assert.match(result.finalDeliveryText, /https:\/\/chatgpt\.com\/c\/relay-fixture/);
    assert.doesNotMatch(result.finalDeliveryText, /Partial/);
    assert.equal(await context.pages()[0].evaluate(() => window.submissions), 1);
    const stored = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(stored.sessions[0].status, "complete");
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an anonymous composer is rejected before a prompt can be sent", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const context = await browser.newContext();
    await context.route("**/*", route => route.fulfill({
      contentType: "text/html",
      body: fixture.replace('<button data-testid="accounts-profile-button">Account</button>', '<button>Log in</button>'),
    }));
    const adapter = createPlaywrightBrowser(context, {
      afterNavigate: page => requireSignedIn(page, { timeoutMs: 100 }),
    });
    const tab = await adapter.tabs.new();
    await assert.rejects(tab.goto("https://chatgpt.com/"), { code: "CHATGPT_LOGIN_REQUIRED" });
    assert.equal(await context.pages()[0].evaluate(() => window.submissions), 0);
  } finally {
    await browser.close();
  }
});

test("separate CLI adapters reuse the relay tab while starting fresh conversations", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "relay-reuse-"));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const context = await browser.newContext();
    await context.route("**/*", route => route.fulfill({ contentType: "text/html", body: fixture }));
    for (const prompt of ["First question", "Second question"]) {
      const result = await runExtendedProRelay({
        browser: createPlaywrightBrowser(context, { afterNavigate: requireSignedIn, reuseTab: true }),
        prompt,
        inferIntelligenceFromPrompt: false,
        statePath: path.join(dir, "sessions.json"),
        timeoutMs: 15000,
      });
      assert.equal(result.status, "complete");
      assert.equal(context.pages().length, 1);
      // Each navigation resets the fixture: only this call's question is in the new chat.
      assert.equal(await context.pages()[0].locator('[data-message-author-role="user"]').innerText(), prompt);
      assert.equal(await context.pages()[0].evaluate(() => window.submissions), 1);
    }
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("modern Chinese controls preserve streaming and poll the existing conversation without resending", { timeout: 45000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "relay-modern-"));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const context = await browser.newContext();
    const modern = fixture
      .replace('data-testid="accounts-profile-button"', 'aria-label="打开个人资料菜单"')
      .replace('id="prompt-textarea"', 'id="modern-composer"')
      .replaceAll('#prompt-textarea', '#modern-composer')
      .replace('aria-label="Chat with ChatGPT"', 'aria-label="询问 ChatGPT"')
      .replace('data-testid="send-button" aria-label="发送消息"', 'aria-label="发送"')
      .replaceAll('[data-testid="send-button"]', '[aria-label="发送"]')
      .replace("'data-message-author-role', 'user'", "'data-markdown-text-style', 'user-message'")
      .replace("'data-message-author-role', 'assistant'", "'data-markdown-text-style', 'assistant-message'")
      .replace("reply.setAttribute('aria-busy', 'true');", "")
      .replace("setTimeout(() => {", `
        const stop = document.createElement('button');
        stop.setAttribute('aria-label', '停止生成');
        stop.textContent = '停止';
        document.body.append(stop);
        const earlyCopy = document.createElement('button');
        earlyCopy.setAttribute('aria-label', '复制');
        earlyCopy.textContent = '复制';
        document.body.append(earlyCopy);
        setTimeout(() => {
          stop.remove();`)
      .replace('}, 1000);', '}, 9000);')
      .replace("'Copy response'", "'复制'");
    await context.route("**/*", route => route.fulfill({ contentType: "text/html", body: modern }));
    const adapter = createPlaywrightBrowser(context, { afterNavigate: requireSignedIn });
    const options = { browser: adapter, statePath: path.join(dir, "sessions.json"), timeoutMs: 22000 };
    const result = await runExtendedProRelay({ ...options, prompt: "Test the modern UI", inferIntelligenceFromPrompt: false });
    assert.equal(result.status, "complete");
    assert.match(result.finalDeliveryText, /## RELAY_OK/);
    assert.doesNotMatch(result.finalDeliveryText, /Partial/);
    const polled = await pollRelaySession(options);
    assert.equal(polled.finalDeliveryText, result.finalDeliveryText);
    assert.equal(context.pages().length, 1);
    assert.equal(await context.pages()[0].evaluate(() => window.submissions), 1);
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});
