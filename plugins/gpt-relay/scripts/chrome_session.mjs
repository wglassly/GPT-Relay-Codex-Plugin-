import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

export async function chromeExecutable(override) {
  const candidates = override ? [path.resolve(override)] : process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : process.platform === "win32"
      ? [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
        .filter(Boolean).map(root => path.join(root, "Google", "Chrome", "Application", "chrome.exe"))
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"];
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* Try the next installation. */ }
  }
  throw new Error("Google Chrome was not found. Supply --chrome /absolute/path/to/chrome.");
}

// Keep Chrome alive across CLI invocations. Only attach through its loopback CDP endpoint.
export async function launchChrome(profile, { executable, start = true } = {}) {
  const endpointFile = path.join(profile, ".relay-endpoint.json");
  let record;
  try { record = JSON.parse(await readFile(endpointFile, "utf8")); } catch { /* First launch. */ }
  const alive = pid => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const valid = record && Number.isInteger(record.pid) && record.pid > 1 &&
    Number.isInteger(record.port) && record.port > 0 && record.port < 65536;
  let browser;
  if (valid && alive(record.pid)) {
    // A live recorded process must not silently be replaced if its endpoint is unavailable.
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${record.port}`, { noDefaults: true, timeout: 5000 });
  } else {
    if (!start) throw new Error("No running relay Chrome instance was found.");
    const reservation = net.createServer();
    await new Promise((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", resolve);
    });
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const child = spawn(await chromeExecutable(executable), [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run", "--no-default-browser-check", "--restore-last-session",
      "https://chatgpt.com/",
    ], { stdio: "ignore", detached: true });
    await once(child, "spawn");
    record = { pid: child.pid, port };
    try {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error("Chrome exited. Close other Chrome windows using this relay profile and retry.");
        }
        try {
          browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true, timeout: 500 });
          break;
        } catch { await delay(200); }
      }
      if (!browser) throw new Error("Chrome's local debugging endpoint did not start.");
      await writeFile(endpointFile, JSON.stringify(record), { mode: 0o600 });
      child.unref();
    } catch (error) {
      child.kill("SIGTERM");
      await browser?.close().catch(() => {});
      throw error;
    }
  }
  return {
    context: browser.contexts()[0],
    // For CDP connections this disconnects Playwright; Chrome stays open.
    close: () => browser.close(),
    async shutdown() {
      const cdp = await browser.newBrowserCDPSession();
      await cdp.send("Browser.close").catch(() => {});
      await browser.close().catch(() => {});
      const deadline = Date.now() + 5000;
      while (alive(record.pid) && Date.now() < deadline) await delay(100);
      if (alive(record.pid)) throw new Error("Chrome is still shutting down. Wait for it to quit before relaunching.");
      await rm(endpointFile, { force: true });
    },
  };
}
