// Adapter for the text-only subset of the desktop browser-client interface.
// The desktop helper remains the owner of submission, polling and Markdown extraction.
export function createPlaywrightBrowser(context, { afterNavigate, reuseTab = false, previousConversationUrl } = {}) {
  async function relayPage() {
    if (!reuseTab) return context.newPage();
    const pages = context.pages().filter(page => page.url().startsWith("https://chatgpt.com/"));
    for (const page of pages) {
      if (await page.evaluate(() => window.name === "gpt-relay-cli").catch(() => false)) return page;
    }
    // Adopt a known relay conversation when upgrading from the per-request-tab prototype.
    const previous = pages.find(page => page.url() === previousConversationUrl);
    if (previous) return previous;
    // Reuse the initial login/home tab only when its composer has no draft.
    for (const page of pages.filter(page => new URL(page.url()).pathname === "/")) {
      const empty = await page.evaluate(() => {
        const editor = document.querySelector('#prompt-textarea, #mobile-composer-prompt, [role="textbox"][contenteditable="true"]');
        return Boolean(editor && !(editor.value ?? editor.textContent ?? "").trim());
      }).catch(() => false);
      if (empty) return page;
    }
    return context.newPage();
  }
  function wrapPage(page) {
    page.setDefaultTimeout(15000);
    const playwright = new Proxy(page, {
      get(target, key) {
        if (key === "waitForLoadState") {
          return ({ state, timeoutMs }) => target.waitForLoadState(state, { timeout: timeoutMs });
        }
        if (key === "getByRole") {
          return (role, options) => {
            if (role === "textbox" && options?.name === "Chat with ChatGPT") {
              return target.locator('#prompt-textarea:visible, textarea#mobile-composer-prompt:visible, [role="textbox"][aria-label="询问 ChatGPT"]:visible, [role="textbox"][aria-label="Ask ChatGPT"]:visible');
            }
            if (role === "button" && options?.name === "Send prompt") {
              return target.locator('button[data-testid="send-button"]:visible, button[aria-label="发送消息"]:visible, button[aria-label="Send message"]:visible, button[aria-label="发送"]:visible, button[aria-label="Send"]:visible');
            }
            return target.getByRole(role, options);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return {
      playwright,
      async goto(url) {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        if (reuseTab) await page.evaluate(() => { window.name = "gpt-relay-cli"; });
        await afterNavigate?.(page);
      },
      url: () => page.url(),
      title: () => page.title(),
    };
  }
  return {
    tabs: { new: async () => wrapPage(await relayPage()) },
    user: {
      openTabs: async () => context.pages().map(page => ({ url: page.url(), page })),
      async claimTab({ page }) {
        await afterNavigate?.(page);
        return wrapPage(page);
      },
    },
  };
}

export async function requireSignedIn(page, { timeoutMs = 15000 } = {}) {
  // Read visible UI only; never extract cookies or browser storage.
  try {
    await page.locator('[data-testid="accounts-profile-button"]:visible')
      .or(page.getByRole("button", { name: /^(Open profile menu|Profile|Profile menu|Account menu|打开个人资料菜单|个人资料|账户菜单)$/i }))
      .first().waitFor({ timeout: timeoutMs });
  } catch {
    const error = new Error('No signed-in ChatGPT account menu was found. Run "npm run relay -- login" and complete login in that window. If already signed in, the page selectors may need updating.');
    error.code = "CHATGPT_LOGIN_REQUIRED";
    throw error;
  }
}
