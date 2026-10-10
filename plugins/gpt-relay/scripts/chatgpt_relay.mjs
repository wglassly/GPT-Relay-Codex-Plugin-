import { access, copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const CHATGPT_URL = "https://chatgpt.com/";
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const DEFAULT_POLL_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;
const RESPONSE_STABLE_MS = 6000;
const RESPONSE_ACTION_FALLBACK_MS = 30000;
const MAX_TEXT_ATTACHMENT_CHARS = 120000;
const DEFAULT_MAX_IMAGE_CLIPBOARD_BYTES = Number.POSITIVE_INFINITY;
const BROWSER_CLIPBOARD_IMAGE_SOFT_LIMIT_BYTES = 512 * 1024;
const DEFAULT_WAIT_CHUNK_MS = 90000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 30000;
const IMAGE_ATTACHMENT_SETTLE_MS = 5000;
const DOM_DATA_TRANSFER_UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;
const GENERATED_IMAGE_MIN_EDGE = 128;
const GENERATED_IMAGE_MIN_AREA = 30000;
const DEEP_RESEARCH_REPORT_MIN_BYTES = 5000;
const DEEP_RESEARCH_DOWNLOAD_WINDOW_MS = 60000;
const CODEX_UPLOAD_PERMISSION_FIX =
  "Codex Settings > Computer Use > Chrome > Permissions > Uploads: set to Always allow, or add chatgpt.com to the allowed upload domains.";
const CHROME_FILE_URL_PERMISSION_FIX =
  "Chrome chrome://extensions > Codex extension > Details: enable Allow access to file URLs.";
const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");
const MACOS_IMAGE_CLIPBOARD_HELPER_SOURCE = path.join(
  PLUGIN_ROOT,
  "native",
  "macos-copy-image-to-clipboard.m"
);

const IMAGE_MIME_BY_EXT = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".csv",
  ".tsv",
  ".html",
  ".css",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".swift",
  ".kt",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".log",
]);

const FILE_MIME_BY_EXT = new Map([
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".json", "application/json"],
  [".jsonl", "application/json"],
  [".csv", "text/csv"],
  [".tsv", "text/tab-separated-values"],
  [".html", "text/html"],
  [".css", "text/css"],
  [".js", "text/javascript"],
  [".ts", "text/plain"],
  [".pdf", "application/pdf"],
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
]);

const FEATURE_LABELS = {
  "create-image": "Create image",
  createImage: "Create image",
  "deep-research": "Deep research",
  deepResearch: "Deep research",
  "web-search": "Web search",
  webSearch: "Web search",
};
const LATEST_INTELLIGENCE_MODEL = "5.5";
const DEFAULT_INTELLIGENCE_REQUEST = Object.freeze({
  model: null,
  mode: null,
  effort: null,
  explicit: false,
  source: "current",
});
const SUPPORTED_INTELLIGENCE_MODELS = new Set(["5.5", "5.4", "5.3", "5.2", "4.5", "o3"]);
const SUPPORTED_INTELLIGENCE_MODES = new Set(["instant", "thinking", "pro"]);
const SUPPORTED_REASONING_EFFORTS = new Set(["light", "standard", "extended", "heavy"]);
const THINKING_REASONING_EFFORTS = new Set(["light", "standard", "extended", "heavy"]);
const PRO_REASONING_EFFORTS = new Set(["standard", "extended"]);
const INTELLIGENCE_MODE_LABELS = {
  instant: "Instant",
  thinking: "Thinking",
  pro: "Pro",
};
const REASONING_EFFORT_LABELS = {
  light: "Light",
  standard: "Standard",
  extended: "Extended",
  heavy: "Heavy",
};
const INTELLIGENCE_ENTRY_BUTTON_RE =
  /^(?:Extended Pro|Pro|Thinking|Instant|Light|Standard|Extended|Heavy|(?:Light|Standard|Extended|Heavy)\s+(?:Pro|Thinking)|(?:Instant|Thinking|Pro)\s*[•·]\s*(?:Light|Standard|Extended|Heavy)|(?:5\.5|5\.4|5\.3|5\.2|4\.5|o3)\s+(?:Instant|Thinking|Pro)(?:\s+(?:Light|Standard|Extended|Heavy))?)$/i;
const INTELLIGENCE_MODEL_VALUE_RE = /^(5\.5|5\.4|5\.3|5\.2|4\.5|o3)$/i;
const INTELLIGENCE_EFFORT_VALUE_RE = /^(Light|Standard|Extended|Heavy)$/i;

export async function runExtendedProRelay(options = {}) {
  return relayPrompt(options);
}

export async function startExtendedProRelay(options = {}) {
  return relayPrompt({
    ...options,
    returnPending: true,
    timeoutMs: options.timeoutMs ?? DEFAULT_WAIT_CHUNK_MS,
  });
}

export async function continueExtendedProRelay(options = {}) {
  const { sessionId, query, statePath } = options;
  const session = await findStoredSession({ sessionId, query, statePath });

  if (!session) {
    throw codedError(
      "SESSION_NOT_FOUND",
      "No stored GPT Relay session matched the request."
    );
  }

  return relayPrompt({
    ...options,
    conversationUrl: session.conversationUrl,
    sessionId: session.relaySessionId,
  });
}

export async function pollRelaySession(options = {}) {
  const {
    browser: requestedBrowser,
    sessionId,
    query,
    statePath,
    keepTab = true,
    timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  } = options;

  const session = await findStoredSession({ sessionId, query, statePath });

  if (!session) {
    throw codedError(
      "SESSION_NOT_FOUND",
      "No stored GPT Relay session matched the request."
    );
  }

  const browser = await resolveBrowser(requestedBrowser);
  let tab;

  try {
    ({ tab } = await openOrClaimStoredSessionTab(browser, session));

    const result = await waitForAssistantResponse(tab, timeoutMs, {
      allowPending: true,
      allowArtifactOnly: isImageGenerationFeature(session.feature),
      allowDeepResearchReport: isDeepResearchFeature(session.feature),
    });
    let state = result.state ?? (await readChatStateForFeature(tab, session.feature));
    let assistantText = result.assistantText;
    let reportMarkdown = "";
    let deepResearch = state.deepResearch;
    let reportArtifact = null;

    if (
      result.status === "complete" &&
      isDeepResearchFeature(session.feature) &&
      state.deepResearch?.completed
    ) {
      const extraction = await extractDeepResearchReport(tab, state, {
        statePath,
        relaySessionId: session.relaySessionId,
        conversationUrl: await tab.url(),
      });
      state = extraction.state;
      assistantText = extraction.text;
      reportMarkdown = extraction.text;
      deepResearch = extraction.deepResearch;
      reportArtifact = extraction.artifact;
    }

    const artifacts = await persistArtifacts(tab, state.artifacts, {
      statePath,
      relaySessionId: session.relaySessionId,
      conversationUrl: await tab.url(),
    });
    const allArtifacts = reportArtifact ? [...artifacts, reportArtifact] : artifacts;
    const imageMarkdown = markdownForArtifacts(allArtifacts);
    const record = await upsertSessionRecord({
      statePath,
      relaySessionId: session.relaySessionId,
      conversationUrl: await tab.url(),
      title: await tab.title(),
      mode: session.mode ?? "Extended Pro",
      intelligence: session.intelligence,
      messages: state.messages,
      status: result.status,
      feature: session.feature,
      appName: session.appName,
      projectName: session.projectName,
      attachmentSummary: session.attachmentSummary ?? [],
      artifacts: allArtifacts,
      deepResearch,
    });

    return {
      ok: true,
      status: result.status,
      mode: record.mode,
      intelligence: record.intelligence,
      assistantText,
      reportMarkdown,
      ...verbatimFinalResponse({
        status: result.status,
        assistantText,
        reportMarkdown,
        conversationUrl: record.conversationUrl,
        artifacts: allArtifacts,
        imageMarkdown,
      }),
      conversationUrl: record.conversationUrl,
      session: publicSession(record),
      deepResearch,
      artifacts: allArtifacts,
      imageMarkdown,
      messages: state.messages,
    };
  } finally {
    await finalizeRelayTab(browser, tab, keepTab);
  }
}

export async function listRelaySessions(options = {}) {
  const { query = "", limit = 20, statePath } = options;
  const store = await loadSessionStore(statePath);
  return filterSessions(store.sessions, query)
    .slice(0, limit)
    .map((session) => publicSession(session));
}

export async function getRelaySession(options = {}) {
  const session = await findStoredSession(options);
  return session ? publicSession(session) : null;
}

async function relayPrompt(options = {}) {
  const {
    browser: requestedBrowser,
    prompt,
    conversationUrl,
    sessionId,
    filePaths = [],
    attachments = [],
    keepTab = true,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    waitChunkMs = DEFAULT_WAIT_CHUNK_MS,
    returnPending = false,
    statePath,
    model: requestedModel,
    mode: requestedMode,
    intelligenceMode,
    reasoningMode,
    thinkingMode,
    reasoningEffort,
    thinkingEffort,
    proEffort,
    effort,
    inferIntelligenceFromPrompt = true,
    appName,
    feature,
    projectName,
    tags = [],
    maxImageClipboardBytes = DEFAULT_MAX_IMAGE_CLIPBOARD_BYTES,
    uploadTimeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS,
  } = options;

  if (typeof prompt !== "string" || !prompt.trim()) {
    throw codedError("PROMPT_MISSING", "A non-empty prompt is required.");
  }

  const browser = await resolveBrowser(requestedBrowser);
  const intelligenceRequest = resolveIntelligenceRequest({
    prompt: inferIntelligenceFromPrompt ? prompt : "",
    model: requestedModel,
    mode: intelligenceMode ?? reasoningMode ?? thinkingMode ?? requestedMode,
    effort: reasoningEffort ?? thinkingEffort ?? proEffort ?? effort,
  });
  let tab;
  let mode = formatIntelligenceLabel(intelligenceRequest);
  let effectiveIntelligence = intelligenceRequest;
  let attachmentSummary = [];

  try {
    tab = await browser.tabs.new();
    await tab.goto(conversationUrl || CHATGPT_URL);
    await waitForLoad(tab);

    await ensureComposer(tab);
    const intelligenceSelection = await selectChatGPTIntelligence(tab, intelligenceRequest);
    mode = intelligenceSelection.label;
    effectiveIntelligence = intelligenceSelection.intelligence;
    await applyComposerFeatures(tab, { feature, projectName });

    const normalizedAttachments = normalizeAttachments({ attachments, filePaths });
    const composition = await composePrompt(tab, {
      prompt,
      appName,
      attachments: normalizedAttachments,
      maxImageClipboardBytes,
      uploadTimeoutMs,
    });
    attachmentSummary = composition.attachmentSummary;

    await clickSend(tab);
    const pendingUrl = await waitForConversationUrl(tab);
    const pendingState = await readChatStateWithFallback(tab, prompt);
    const pendingRecord = await upsertSessionRecord({
      statePath,
      relaySessionId: sessionId,
      conversationUrl: pendingUrl,
      title: await safeTabTitle(tab),
      mode,
      intelligence: effectiveIntelligence,
      messages: pendingState.messages,
      status: "pending",
      feature,
      appName,
      projectName,
      attachmentSummary,
      deepResearch: pendingState.deepResearch,
      tags,
    });

    const result = await waitForAssistantResponseInChunks(tab, {
      timeoutMs,
      waitChunkMs,
      allowPending: returnPending,
      allowArtifactOnly: isImageGenerationFeature(feature),
      allowDeepResearchReport: isDeepResearchFeature(feature),
      onPending: async (pendingResult) => {
        const pendingState = pendingResult.state ?? (await readChatStateForFeature(tab, feature));
        const pendingArtifacts = await persistArtifacts(tab, pendingState.artifacts, {
          statePath,
          relaySessionId: pendingRecord.relaySessionId,
          conversationUrl: await tab.url(),
        });
        await upsertSessionRecord({
          statePath,
          relaySessionId: pendingRecord.relaySessionId,
          conversationUrl: await tab.url(),
          title: await safeTabTitle(tab),
          mode,
          intelligence: effectiveIntelligence,
          messages: pendingState.messages,
          status: pendingResult.status,
          feature,
          appName,
          projectName,
          attachmentSummary,
          artifacts: pendingArtifacts,
          deepResearch: pendingState.deepResearch,
          tags,
        });
      },
    });
    let state = result.state ?? (await readChatStateForFeature(tab, feature));
    const currentUrl = await tab.url();
    const title = await tab.title();
    let assistantText = result.assistantText;
    let reportMarkdown = "";
    let deepResearch = state.deepResearch;
    let reportArtifact = null;

    if (
      result.status === "complete" &&
      isDeepResearchFeature(feature) &&
      state.deepResearch?.completed
    ) {
      const extraction = await extractDeepResearchReport(tab, state, {
        statePath,
        relaySessionId: pendingRecord.relaySessionId,
        conversationUrl: currentUrl,
      });
      state = extraction.state;
      assistantText = extraction.text;
      reportMarkdown = extraction.text;
      deepResearch = extraction.deepResearch;
      reportArtifact = extraction.artifact;
    }

    const artifacts = await persistArtifacts(tab, state.artifacts, {
      statePath,
      relaySessionId: pendingRecord.relaySessionId,
      conversationUrl: currentUrl,
    });
    const allArtifacts = reportArtifact ? [...artifacts, reportArtifact] : artifacts;
    const imageMarkdown = markdownForArtifacts(allArtifacts);
    const record = await upsertSessionRecord({
      statePath,
      relaySessionId: pendingRecord.relaySessionId,
      conversationUrl: currentUrl,
      title,
      mode,
      intelligence: effectiveIntelligence,
      messages: state.messages,
      status: result.status,
      feature,
      appName,
      projectName,
      attachmentSummary,
      artifacts: allArtifacts,
      deepResearch,
      tags,
    });

    return {
      ok: true,
      status: result.status,
      mode,
      intelligence: effectiveIntelligence,
      assistantText,
      reportMarkdown,
      ...verbatimFinalResponse({
        status: result.status,
        assistantText,
        reportMarkdown,
        conversationUrl: currentUrl,
        artifacts: allArtifacts,
        imageMarkdown,
      }),
      conversationUrl: currentUrl,
      title,
      session: publicSession(record),
      deepResearch,
      artifacts: allArtifacts,
      imageMarkdown,
      messages: state.messages,
    };
  } finally {
    await finalizeRelayTab(browser, tab, keepTab);
  }
}

async function resolveBrowser(requestedBrowser) {
  if (requestedBrowser) {
    return requestedBrowser;
  }

  if (globalThis.browser) {
    try {
      await globalThis.browser.documentation();
      return globalThis.browser;
    } catch (error) {
      if (!isNativePipeClosedError(error)) {
        throw error;
      }
      delete globalThis.browser;
    }
  }

  const browserClientPath = await findBrowserClientModule();
  const browserClient = await import(pathToFileURL(browserClientPath).href);
  await browserClient.setupBrowserRuntime({ globals: globalThis });

  if (!globalThis.agent?.browsers?.get) {
    throw codedError(
      "CHROME_BROWSER_MISSING",
      "Chrome browser runtime did not expose a browser connector."
    );
  }

  const connectedBrowser = await globalThis.agent.browsers.get("extension");
  globalThis.browser = connectedBrowser;

  // Warm the runtime and fail early if the extension connection is not ready.
  await connectedBrowser.documentation();

  return connectedBrowser;
}

async function findBrowserClientModule() {
  const homeDir = globalThis.nodeRepl?.homeDir;

  if (!homeDir) {
    throw codedError(
      "CHROME_BROWSER_CLIENT_MISSING",
      "The Node runtime did not expose a home directory for locating the Chrome plugin."
    );
  }

  const chromeRoot = path.join(
    homeDir,
    ".codex",
    "plugins",
    "cache",
    "openai-bundled",
    "chrome"
  );

  let versionDirs;
  try {
    versionDirs = await readdir(chromeRoot);
  } catch (error) {
    throw codedError(
      "CHROME_BROWSER_CLIENT_MISSING",
      "Could not find the bundled Chrome plugin cache.",
      { cause: error }
    );
  }

  for (const versionDir of versionDirs.sort().reverse()) {
    const candidate = path.join(
      chromeRoot,
      versionDir,
      "scripts",
      "browser-client.mjs"
    );

    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next installed Chrome plugin version.
    }
  }

  throw codedError(
    "CHROME_BROWSER_CLIENT_MISSING",
    "Could not find Chrome plugin scripts/browser-client.mjs."
  );
}

async function openOrClaimStoredSessionTab(browser, session) {
  const conversationId = getConversationId(session.conversationUrl);
  const openTabs = await browser.user?.openTabs?.().catch(() => []);
  const candidate = openTabs.find((openTab) => {
    const url = String(openTab.url ?? "");
    const title = String(openTab.title ?? "");
    return (
      (conversationId && url.includes(`/c/${conversationId}`)) ||
      (session.conversationUrl && url === session.conversationUrl) ||
      (session.title && title.includes(session.title))
    );
  });

  if (candidate && typeof browser.user?.claimTab === "function") {
    const tab = await browser.user.claimTab(candidate);
    await waitForLoad(tab).catch(() => undefined);
    return { tab, source: "claimed-user-tab" };
  }

  const tab = await browser.tabs.new();
  await tab.goto(session.conversationUrl);
  await waitForLoad(tab);
  return { tab, source: "new-url-tab" };
}

async function waitForLoad(tab) {
  await tab.playwright.waitForLoadState({
    state: "domcontentloaded",
    timeoutMs: 30000,
  });
}

async function ensureComposer(tab) {
  const deadline = Date.now() + 30000;
  let lastError = null;

  while (Date.now() < deadline) {
    const composer = tab.playwright.getByRole("textbox", {
      name: "Chat with ChatGPT",
    });

    try {
      const count = await composer.count();
      if (count === 1) {
        return composer;
      }
    } catch (error) {
      lastError = error;
    }

    await tab.playwright.waitForTimeout(500);
  }

  const pageState = await readCompactPageState(tab);
  if (/captcha|verify|verification/i.test(pageState.text)) {
    throw codedError(
      "CHATGPT_VERIFICATION_REQUIRED",
      "ChatGPT is showing a verification or CAPTCHA step."
    );
  }

  if (/log in|sign up|login|sign in/i.test(pageState.text)) {
    throw codedError(
      "CHATGPT_LOGIN_REQUIRED",
      "ChatGPT is not logged in or the session is not ready."
    );
  }

  throw codedError(
    "CHATGPT_COMPOSER_MISSING",
    "Could not find the ChatGPT composer textbox.",
    { cause: lastError }
  );
}

async function selectChatGPTIntelligence(tab, request = DEFAULT_INTELLIGENCE_REQUEST) {
  if (!request.explicit) {
    const current = await readCurrentIntelligenceSelection(tab);
    return {
      label: current.label,
      intelligence: current,
    };
  }

  const configured = await configureChatGPTIntelligence(tab, request);
  return {
    label: configured.label ?? formatIntelligenceLabel(request),
    intelligence: configured,
  };
}

async function configureChatGPTIntelligence(tab, request) {
  validateIntelligenceRequest(request);
  await openIntelligenceConfigure(tab);
  let available = await readConfigureOptions(tab);

  if (request.model) {
    try {
      await selectConfigureModel(tab, request.model);
    } catch (error) {
      if (
        error?.code === "INTELLIGENCE_MODEL_UNAVAILABLE" ||
        error?.code === "INTELLIGENCE_MODEL_NOT_SELECTED"
      ) {
        available = await readConfigureOptions(tab);
        throw intelligenceUnavailableError(
          `ChatGPT does not expose model ${request.model}.`,
          request,
          available,
          error
        );
      }
      throw error;
    }
    available = await readConfigureOptions(tab);
  }

  if (request.mode) {
    try {
      await selectConfigureMode(tab, request.mode);
    } catch (error) {
      if (error?.code === "INTELLIGENCE_MODE_UNAVAILABLE") {
        available = await readConfigureOptions(tab);
        throw intelligenceUnavailableError(
          `ChatGPT does not expose ${INTELLIGENCE_MODE_LABELS[request.mode] ?? request.mode} mode for model ${request.model ?? "the current model"}.`,
          request,
          available,
          error
        );
      }
      throw error;
    }
    available = await readConfigureOptions(tab);
  }

  if (request.effort) {
    try {
      await selectConfigureEffort(tab, request.effort, request.mode);
    } catch (error) {
      if (
        error?.code === "REASONING_EFFORT_CONTROL_MISSING" ||
        error?.code === "REASONING_EFFORT_UNAVAILABLE"
      ) {
        available = await readConfigureOptions(tab);
        throw intelligenceUnavailableError(
          `ChatGPT does not expose ${REASONING_EFFORT_LABELS[request.effort] ?? request.effort} effort for ${formatIntelligenceLabel(request)}.`,
          request,
          available,
          error
        );
      }
      throw error;
    }
  }

  const selection = await readConfigureSelection(tab, request);
  await closeIntelligenceConfigure(tab);
  return selection;
}

async function readCurrentIntelligenceSelection(tab) {
  const modeControl = await waitForModeControl(tab);
  if (!modeControl) {
    return {
      ...DEFAULT_INTELLIGENCE_REQUEST,
      label: "Current ChatGPT selection",
    };
  }

  const text = modeControl.text ?? await locatorText(modeControl.locator);
  const parsed = parseVisibleIntelligenceLabel(text);
  return {
    ...DEFAULT_INTELLIGENCE_REQUEST,
    ...parsed,
    label: parsed.label || text || "Current ChatGPT selection",
  };
}

async function readConfigureSelection(tab, request = DEFAULT_INTELLIGENCE_REQUEST) {
  const options = await readConfigureOptions(tab);
  const selection = {
    ...request,
    availableOptions: options,
  };

  if (!selection.model && options.selectedModel) {
    selection.model = options.selectedModel;
  }
  if (!selection.mode && options.selectedMode) {
    selection.mode = options.selectedMode;
  }
  if (!selection.effort && options.selectedEffort) {
    selection.effort = options.selectedEffort;
  }

  selection.label = formatIntelligenceLabel(selection);
  return selection;
}

async function readConfigureOptions(tab) {
  return await tab.playwright.evaluate(() => {
    const normalize = (value) => String(value ?? "").trim().replace(/\s+/g, " ");
    const unique = (values) => [...new Set(values.filter(Boolean))];
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const blank = {
      models: [],
      modes: [],
      efforts: [],
      thinkingEfforts: [],
      proEfforts: [],
      selectedModel: null,
      selectedMode: null,
      selectedEffort: null,
      textSnippet: "",
    };
    const allVisible = (selector) =>
      [...document.querySelectorAll(selector)].filter(isVisible);
    const scopes = allVisible("[role='dialog']").filter((element) => {
      const text = normalize(element.innerText || element.textContent);
      return /\bIntelligence\b/.test(text) && /\bModel\b/.test(text);
    });
    const scope = scopes[0];
    if (!scope) {
      return blank;
    }

    const text = normalize(scope.innerText || scope.textContent);
    const scopeElements = [...scope.querySelectorAll("*")].filter(isVisible);
    const modelRe = /^(5\.5|5\.4|5\.3|5\.2|4\.5|o3)$/i;
    const effortRe = /^(Light|Standard|Extended|Heavy)$/i;
    const elementText = (element) => normalize(element.innerText || element.textContent);
    const toMode = (value) => {
      const entryText = normalize(value);
      if (/^Instant\b/i.test(entryText)) return "instant";
      if (/^Thinking\b/i.test(entryText)) return "thinking";
      if (/^Pro\b/i.test(entryText)) return "pro";
      return null;
    };

    const selectedModelControl = scopeElements.find((element) =>
      element.matches("[role='combobox']") && modelRe.test(elementText(element))
    );
    const selectedModel = selectedModelControl ? elementText(selectedModelControl) : null;
    const modelOptions = allVisible("[role='option']")
      .map(elementText)
      .filter((value) => modelRe.test(value));
    const models = unique([selectedModel, ...modelOptions]);

    const modeRows = scopeElements.filter((element) => element.matches("[role='radio']"));
    const modes = unique(modeRows.map((element) => toMode(elementText(element))));
    const checkedMode = modeRows.find((element) => element.getAttribute("aria-checked") === "true");
    const selectedMode = checkedMode ? toMode(elementText(checkedMode)) : null;

    const selectedEffortControl = scopeElements.find((element) =>
      element.matches("[role='combobox']") && effortRe.test(elementText(element))
    );
    const selectedEffort = selectedEffortControl ? elementText(selectedEffortControl) : null;
    const effortOptions = allVisible("[role='option']")
      .map(elementText)
      .filter((value) => effortRe.test(value));
    const efforts = unique([selectedEffort, ...effortOptions]);

    return {
      models,
      modes,
      efforts,
      thinkingEfforts: efforts.filter((effort) => ["Light", "Standard", "Extended", "Heavy"].includes(effort)),
      proEfforts: efforts.filter((effort) => ["Standard", "Extended"].includes(effort)),
      selectedModel,
      selectedMode,
      selectedEffort: selectedEffort?.toLowerCase() ?? null,
      textSnippet: text.slice(0, 1200),
    };
  }, undefined, { timeoutMs: 5000 }).catch(() => ({
    models: [],
    modes: [],
    efforts: [],
    thinkingEfforts: [],
    proEfforts: [],
    selectedModel: null,
    selectedMode: null,
    selectedEffort: null,
    textSnippet: "",
  }));
}

function intelligenceUnavailableError(message, request, availableOptions, cause) {
  return codedError(
    "INTELLIGENCE_COMBINATION_UNAVAILABLE",
    `${message} ${formatAvailableIntelligenceOptions(availableOptions)}`,
    { request, availableOptions, cause }
  );
}

function formatAvailableIntelligenceOptions(options = {}) {
  const models = normalizeAvailableModels(options.models);
  const modes = normalizeAvailableModes(options.modes);
  const efforts = normalizeAvailableEfforts(options.efforts);
  const parts = [];

  if (models.length > 0) {
    parts.push(`models: ${models.join(", ")}`);
  }
  if (modes.length > 0) {
    parts.push(`modes: ${modes.join(", ")}`);
  }
  if (efforts.length > 0) {
    parts.push(`efforts: ${efforts.join(", ")}`);
  }

  return parts.length > 0
    ? `Available ChatGPT options are ${parts.join("; ")}.`
    : "No available ChatGPT Intelligence options could be read from the current UI.";
}

function normalizeAvailableModels(models = []) {
  return [...new Set(models.map((model) => String(model).toLowerCase()).filter(Boolean))];
}

function normalizeAvailableModes(modes = []) {
  return [...new Set(modes)]
    .map((mode) => INTELLIGENCE_MODE_LABELS[mode] ?? mode)
    .filter(Boolean);
}

function normalizeAvailableEfforts(efforts = []) {
  return [...new Set(efforts)]
    .map((effort) => {
      const value = String(effort).toLowerCase();
      return REASONING_EFFORT_LABELS[value] ?? effort;
    })
    .filter(Boolean);
}

async function locatorText(locator) {
  if (!locator) {
    return "";
  }

  const text = await locator.innerText?.().catch(() => null);
  if (text !== null && text !== undefined) {
    return normalizeWhitespace(text);
  }

  const content = await locator.textContent?.().catch(() => null);
  return normalizeWhitespace(content ?? "");
}

function parseVisibleIntelligenceLabel(label = "") {
  const text = normalizeWhitespace(label);
  const parsed = {};
  const modelMatch = text.match(/\b(5\.5|5\.4|5\.3|5\.2|4\.5|o3)\b/i);
  if (modelMatch) {
    parsed.model = normalizeIntelligenceModel(modelMatch[1]);
  }

  if (/\bExtended Pro\b/i.test(text)) {
    parsed.mode = "pro";
    parsed.effort = "extended";
  } else if (/\bPro\b/i.test(text)) {
    parsed.mode = "pro";
  } else if (/\bThinking\b/i.test(text)) {
    parsed.mode = "thinking";
  } else if (/\bInstant\b/i.test(text)) {
    parsed.mode = "instant";
  }

  const effort = extractReasoningEffort(text);
  if (effort && parsed.mode !== "instant") {
    parsed.effort = effort;
  }

  parsed.label = formatIntelligenceLabel({
    ...DEFAULT_INTELLIGENCE_REQUEST,
    ...parsed,
  });
  return parsed;
}

async function openIntelligenceConfigure(tab) {
  const deadline = Date.now() + 30000;
  let lastControlError = null;

  while (Date.now() < deadline) {
    if (await isConfigureDialogOpen(tab)) {
      return;
    }

    try {
      await clickModeControl(tab);
    } catch (error) {
      lastControlError = error;
    }

    if (await clickIntelligenceConfigureMenuItem(tab)) {
      await tab.playwright.waitForTimeout(500);
      if (await isConfigureDialogOpen(tab)) {
        return;
      }
    }

    await tab.playwright.waitForTimeout(500);
  }

  throw codedError(
    "INTELLIGENCE_CONFIGURE_UNAVAILABLE",
    "Could not find ChatGPT menu item 'Configure...'.",
    { cause: lastControlError }
  );
}

async function clickIntelligenceConfigureMenuItem(tab) {
  const targetRect = await tab.playwright.evaluate(() => {
    const normalize = (value) => String(value ?? "").trim().replace(/\s+/g, " ");
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const candidates = [
      ...document.querySelectorAll(
        "[data-testid='model-configure-modal'],button,[role='button'],[role='menuitem'],[role='menuitemradio']"
      ),
    ].filter(isVisible);
    const target = candidates.find((element) => {
      if (element.getAttribute("data-testid") === "model-configure-modal") {
        return true;
      }

      return /^Configure(?:\.{3}|…)$/i.test(normalize(element.innerText || element.textContent));
    });

    if (!target) {
      return null;
    }

    const rect = target.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      text: normalize(target.innerText || target.textContent),
    };
  }, undefined, { timeoutMs: 5000 }).catch(() => null);

  if (!targetRect || !tab.cua?.click) {
    return false;
  }

  await tab.cua.click({
    x: Math.round(targetRect.x),
    y: Math.round(targetRect.y),
  });
  await tab.playwright.waitForTimeout(300);
  return true;
}

async function clickModeControl(tab) {
  const modeControl = await waitForModeControl(tab);
  if (!modeControl) {
    const pageState = await readCompactPageState(tab);
    throw codedError(
      "INTELLIGENCE_CONTROL_MISSING",
      "Could not find the ChatGPT intelligence mode control.",
      { pageState }
    );
  }

  if (modeControl.rect && tab.cua?.click) {
    await tab.cua.click({
      x: Math.round(modeControl.rect.x),
      y: Math.round(modeControl.rect.y),
    });
  } else {
    await modeControl.locator.click({});
  }
  await tab.playwright.waitForTimeout(500);
}

async function selectConfigureModel(tab, model) {
  if (!(await clickConfigureSectionValueControl(tab, /^Model$/i, INTELLIGENCE_MODEL_VALUE_RE))) {
    throw codedError(
      "INTELLIGENCE_MODEL_CONTROL_MISSING",
      "Could not find the ChatGPT model selector in Configure."
    );
  }

  await tab.playwright.waitForTimeout(300);
  await clickDropdownOption(tab, model, "INTELLIGENCE_MODEL_UNAVAILABLE");
  await tab.playwright.waitForTimeout(300);
  await assertConfigureValueVisible(
    tab,
    new RegExp(`^${escapeRegExp(model)}$`, "i"),
    "INTELLIGENCE_MODEL_NOT_SELECTED",
    `ChatGPT model selector did not update to '${model}'.`
  );
}

async function selectConfigureMode(tab, mode) {
  const label = INTELLIGENCE_MODE_LABELS[mode];
  if (!label) {
    throw codedError("INTELLIGENCE_MODE_UNSUPPORTED", `Unsupported intelligence mode: ${mode}`);
  }

  await clickDropdownOption(tab, label, "INTELLIGENCE_MODE_UNAVAILABLE");
  await tab.playwright.waitForTimeout(300);
}

async function selectConfigureEffort(tab, effort, mode) {
  const targetLabel = REASONING_EFFORT_LABELS[effort];
  if (!targetLabel) {
    throw codedError("REASONING_EFFORT_UNSUPPORTED", `Unsupported reasoning effort: ${effort}`);
  }

  const targetAlreadyVisible = await findConfigureValueControl(
    tab,
    new RegExp(`^${escapeRegExp(targetLabel)}$`, "i")
  );
  if (targetAlreadyVisible) {
    return;
  }

  const effortSectionPattern = mode === "pro"
    ? /^Pro thinking effort$/i
    : /^(?:Thinking effort|Pro thinking effort)$/i;
  if (!(await clickConfigureSectionValueControl(tab, effortSectionPattern, INTELLIGENCE_EFFORT_VALUE_RE))) {
    throw codedError(
      "REASONING_EFFORT_CONTROL_MISSING",
      "Could not find the ChatGPT reasoning effort selector in Configure."
    );
  }

  await tab.playwright.waitForTimeout(300);
  await clickDropdownOption(tab, targetLabel, "REASONING_EFFORT_UNAVAILABLE");
  await tab.playwright.waitForTimeout(300);
  await assertConfigureValueVisible(
    tab,
    new RegExp(`^${escapeRegExp(targetLabel)}$`, "i"),
    "REASONING_EFFORT_NOT_SELECTED",
    `ChatGPT reasoning effort selector did not update to '${targetLabel}'.`
  );
}

async function clickConfigureSectionValueControl(tab, sectionPattern, valuePattern) {
  const section = {
    source: sectionPattern.source,
    flags: sectionPattern.flags,
  };
  const value = {
    source: valuePattern.source,
    flags: valuePattern.flags,
  };
  const targetRect = await tab.playwright.evaluate(({ section, value }) => {
    const sectionRe = new RegExp(section.source, section.flags);
    const valueRe = new RegExp(value.source, value.flags);
    const normalize = (raw) => String(raw ?? "").trim().replace(/\s+/g, " ");
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const scopes = [...document.querySelectorAll("[role='dialog']")].filter((element) => {
      const text = normalize(element.innerText || element.textContent);
      return isVisible(element) && /\bIntelligence\b/.test(text) && /\bModel\b/.test(text);
    });
    const scope = scopes[0] || document.body;
    const elements = [...scope.querySelectorAll("*")].filter(isVisible);
    const labels = elements
      .map((element) => ({
        element,
        text: normalize(element.innerText || element.textContent),
        rect: element.getBoundingClientRect(),
      }))
      .filter((entry) => sectionRe.test(entry.text));
    const controls = elements
      .filter((element) =>
        element.matches("button,[role='button'],[role='combobox'],[aria-haspopup='listbox'],[aria-haspopup='menu']")
      )
      .map((element) => ({
        element,
        text: normalize(element.innerText || element.textContent),
        rect: element.getBoundingClientRect(),
      }))
      .filter((entry) => valueRe.test(entry.text));

    for (const label of labels) {
      const labelCenterY = label.rect.top + label.rect.height / 2;
      const sameRow = controls
        .filter((control) => {
          const controlCenterY = control.rect.top + control.rect.height / 2;
          return (
            Math.abs(controlCenterY - labelCenterY) < 80 &&
            control.rect.left > label.rect.left
          );
        })
        .sort((a, b) => a.rect.left - b.rect.left);
      const target = sameRow[0];
      if (target) {
        return {
          x: target.rect.left + target.rect.width / 2,
          y: target.rect.top + target.rect.height / 2,
          text: target.text,
        };
      }
    }

    return null;
  }, { section, value }, { timeoutMs: 5000 }).catch(() => null);

  if (!targetRect || !tab.cua?.click) {
    return false;
  }

  await tab.cua.click({
    x: Math.round(targetRect.x),
    y: Math.round(targetRect.y),
  });
  await tab.playwright.waitForTimeout(100);
  return true;
}

async function findConfigureValueControl(tab, valuePattern) {
  const scope = await getIntelligenceConfigureScope(tab);
  const candidates = [
    scope.locator("[role='combobox']").filter({ hasText: valuePattern }),
    scope.getByRole("combobox", { name: valuePattern }),
    scope.getByRole("button", { name: valuePattern }),
    scope.locator("button").filter({ hasText: valuePattern }),
  ];

  for (const locator of candidates) {
    const visible = await firstVisibleLocator(locator);
    if (visible) {
      return visible;
    }
  }

  return null;
}

async function assertConfigureValueVisible(tab, valuePattern, errorCode, message) {
  const selected = await findConfigureValueControl(tab, valuePattern);
  if (selected) {
    return;
  }

  throw codedError(errorCode, message);
}

async function getIntelligenceConfigureScope(tab) {
  const dialog = tab.playwright.getByRole("dialog").filter({
    hasText: /Intelligence/i,
  });

  if ((await safeLocatorCount(dialog)) > 0) {
    return dialog.first();
  }

  return tab.playwright;
}

async function clickDropdownOption(tab, label, errorCode) {
  const exactLabel = new RegExp(`^${escapeRegExp(label)}\\b`, "i");
  const scope = await getIntelligenceConfigureScope(tab);
  const candidates = [
    scope.getByRole("radio", { name: exactLabel }),
    scope.locator("[role='radio']").filter({ hasText: exactLabel }),
    tab.playwright.getByRole("option", { name: label }),
    tab.playwright.getByRole("option", { name: exactLabel }),
    tab.playwright.locator("[role='option']").filter({ hasText: exactLabel }),
    tab.playwright.getByRole("menuitemradio", { name: exactLabel }),
    tab.playwright.getByRole("menuitem", { name: exactLabel }),
    scope.getByRole("button", { name: exactLabel }),
    scope.locator("button").filter({ hasText: exactLabel }),
  ];

  for (const locator of candidates) {
    const visible = await firstVisibleLocator(locator);
    if (visible) {
      await visible.click({});
      return;
    }
  }

  if (await clickVisibleConfigureElementByText(tab, [label])) {
    return;
  }

  throw codedError(errorCode, `Could not find ChatGPT option '${label}'.`);
}

async function clickVisibleConfigureElementByText(tab, labels) {
  const normalizedLabels = labels.map((label) => normalizeWhitespace(label));
  const targetRect = await tab.playwright.evaluate((targetLabels) => {
    const normalize = (value) => String(value ?? "").trim().replace(/\s+/g, " ");
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const dialogs = [...document.querySelectorAll("[role='dialog']")].filter((element) => {
      const text = normalize(element.innerText || element.textContent);
      return isVisible(element) && /\bIntelligence\b/.test(text) && /\bModel\b/.test(text);
    });
    const dialog = dialogs[0];
    if (!dialog) {
      return null;
    }

    const rect = dialog.getBoundingClientRect();
    const withinDialogOrPopover = (element) => {
      const elementRect = element.getBoundingClientRect();
      const inDialog =
        elementRect.left >= rect.left - 8 &&
        elementRect.top >= rect.top - 8 &&
        elementRect.right <= rect.right + 8 &&
        elementRect.bottom <= rect.bottom + 8;
      const nearDialogPopover =
        elementRect.left >= rect.left - 8 &&
        elementRect.left <= rect.right + 560 &&
        elementRect.top >= rect.top - 8 &&
        elementRect.top <= rect.bottom + 280;
      return inDialog || nearDialogPopover;
    };
    const candidates = [
      ...document.querySelectorAll(
        "button,[role='button'],[role='radio'],[role='option'],[role='menuitem'],[role='menuitemradio']"
      ),
    ].filter((element) => isVisible(element) && withinDialogOrPopover(element));
    const target = candidates.find((element) => {
      const text = normalize(element.innerText || element.textContent);
      return targetLabels.includes(text) || targetLabels.some((label) => text.startsWith(label));
    });

    if (!target) {
      return null;
    }

    const targetBounds = target.getBoundingClientRect();
    return {
      x: targetBounds.left + targetBounds.width / 2,
      y: targetBounds.top + targetBounds.height / 2,
      text: normalize(target.innerText || target.textContent),
    };
  }, normalizedLabels, { timeoutMs: 5000 }).catch(() => null);

  if (!targetRect || !tab.cua?.click) {
    return false;
  }

  await tab.cua.click({
    x: Math.round(targetRect.x),
    y: Math.round(targetRect.y),
  });
  await tab.playwright.waitForTimeout(100);
  return true;
}

async function closeIntelligenceConfigure(tab) {
  const closeButton = tab.playwright.getByRole("button", {
    name: /close/i,
  });
  if ((await safeLocatorCount(closeButton)) > 0) {
    await closeButton.first().click({});
    await tab.playwright.waitForTimeout(300);
    return;
  }

  if (typeof tab.playwright.keyboard?.press === "function") {
    await tab.playwright.keyboard.press("Escape");
  } else if (tab.cua?.keypress) {
    await tab.cua.keypress({ keys: ["Escape"] });
  }
  await tab.playwright.waitForTimeout(300);
}

async function waitForModeControl(tab) {
  const deadline = Date.now() + 15000;

  while (Date.now() < deadline) {
    try {
      const control = await findComposerModeControl(tab);
      if (control) {
        return control;
      }
    } catch {
      // ChatGPT sometimes stalls CDP role queries while the composer hydrates.
    }

    await tab.playwright.waitForTimeout(500);
  }

  return null;
}

async function findComposerModeControl(tab) {
  const pattern = {
    source: INTELLIGENCE_ENTRY_BUTTON_RE.source,
    flags: INTELLIGENCE_ENTRY_BUTTON_RE.flags,
  };
  const target = await tab.playwright.evaluate(({ pattern: entryPattern }) => {
    const entryRe = new RegExp(entryPattern.source, entryPattern.flags);
    const normalize = (value) => String(value ?? "").trim().replace(/\s+/g, " ");
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const rectOf = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        centerX: rect.left + rect.width / 2,
        centerY: rect.top + rect.height / 2,
      };
    };
    const buttons = [...document.querySelectorAll("button")].filter(isVisible);
    const composerTextbox = [...document.querySelectorAll("[role='textbox']")]
      .filter(isVisible)
      .find((element) => element.getAttribute("aria-label") === "Chat with ChatGPT");
    const textboxRect = composerTextbox ? rectOf(composerTextbox) : null;
    const candidates = buttons
      .map((element) => ({
        text: normalize(element.innerText || element.textContent),
        aria: normalize(element.getAttribute("aria-label")),
        testid: element.getAttribute("data-testid") || "",
        rect: rectOf(element),
      }))
      .filter((entry) => {
        if (!entryRe.test(entry.text)) {
          return false;
        }
        if (entry.testid === "accounts-profile-button" || /profile menu/i.test(entry.aria)) {
          return false;
        }
        if (!textboxRect) {
          return entry.rect.left > 250;
        }

        const verticallyAligned =
          entry.rect.centerY >= textboxRect.top - 40 &&
          entry.rect.centerY <= textboxRect.bottom + 40;
        const rightOfComposerText =
          entry.rect.left >= textboxRect.right - 48 &&
          entry.rect.right <= window.innerWidth - 24;
        return verticallyAligned && rightOfComposerText;
      })
      .sort((a, b) => {
        if (!textboxRect) {
          return b.rect.left - a.rect.left;
        }

        return Math.abs(a.rect.centerY - textboxRect.centerY) -
          Math.abs(b.rect.centerY - textboxRect.centerY);
      });

    const target = candidates[0];
    if (!target) {
      return null;
    }

    return {
      text: target.text,
      x: target.rect.centerX,
      y: target.rect.centerY,
    };
  }, { pattern }, { timeoutMs: 5000 }).catch(() => null);

  if (!target) {
    return null;
  }

  const parsed = parseVisibleIntelligenceLabel(target.text);
  return {
    mode: parsed.mode ?? "configured",
    text: target.text,
    rect: {
      x: target.x,
      y: target.y,
    },
  };
}

async function firstVisibleLocator(locator) {
  const count = Math.min(await safeLocatorCount(locator), 10);

  for (let index = 0; index < count; index += 1) {
    const candidate = typeof locator.nth === "function" ? locator.nth(index) : locator.first();
    if (typeof candidate.isVisible !== "function") {
      return candidate;
    }

    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }

  return null;
}

async function applyComposerFeatures(tab, { feature, projectName }) {
  if (feature) {
    const label = FEATURE_LABELS[feature];
    if (!label) {
      throw codedError(
        "FEATURE_UNSUPPORTED",
        `Unsupported GPT feature '${feature}'.`
      );
    }
    await selectComposerMenuItem(tab, label, "FEATURE_CONTROL_UNAVAILABLE");
  }

  if (projectName) {
    await openComposerMenu(tab);
    await clickMenuLabel(tab, "Projects", "PROJECTS_MENU_UNAVAILABLE");
    await tab.playwright.waitForTimeout(300);
    await clickMenuLabel(tab, projectName, "PROJECT_UNAVAILABLE");
  }
}

async function openComposerMenu(tab) {
  const menuButton = tab.playwright.getByRole("button", {
    name: "Add files and more",
  });

  if ((await menuButton.count()) !== 1) {
    throw codedError(
      "COMPOSER_MENU_UNAVAILABLE",
      "Could not find the ChatGPT composer menu button."
    );
  }

  await menuButton.click({});
  await tab.playwright.waitForTimeout(300);
}

async function selectComposerMenuItem(tab, label, errorCode) {
  await openComposerMenu(tab);
  await clickMenuLabel(tab, label, errorCode);
}

async function clickMenuLabel(tab, label, errorCode) {
  if (await tryClickMenuLabel(tab, label, { timeoutMs: 15000 })) {
    return;
  }

  throw codedError(errorCode, `Could not find ChatGPT menu item '${label}'.`);
}

async function tryClickMenuLabel(tab, label, { timeoutMs = 15000 } = {}) {
  const labelPattern =
    label === "Configure..." ? /^Configure(?:\.{3}|…)$/i : new RegExp(`^${escapeRegExp(label)}$`, "i");
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (
      await clickVisibleElementByText(
        tab,
        label === "Configure..." ? ["Configure...", "Configure…"] : [label]
      )
    ) {
      return true;
    }

    const candidates = [
      tab.playwright.getByRole("menuitem", { name: label }),
      tab.playwright.getByRole("menuitem", { name: labelPattern }),
      tab.playwright.locator("[role='menuitem']").filter({ hasText: labelPattern }),
      tab.playwright.getByRole("button", { name: label }),
      tab.playwright.getByRole("button", { name: labelPattern }),
      tab.playwright.locator("button").filter({ hasText: labelPattern }),
      tab.playwright.getByText(label, { exact: true }),
      tab.playwright.getByText(labelPattern),
    ];

    for (const locator of candidates) {
      const visible = await firstVisibleLocator(locator);
      if (visible) {
        await visible.click({});
        return;
      }
    }

    await tab.playwright.waitForTimeout(100);
  }

  return false;
}

async function isConfigureDialogOpen(tab) {
  return await tab.playwright.evaluate(() => {
    const normalize = (value) => String(value ?? "").trim().replace(/\s+/g, " ");
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    return [...document.querySelectorAll("[role='dialog']")].some((element) => {
      const text = normalize(element.innerText || element.textContent);
      return isVisible(element) && /\bIntelligence\b/.test(text) && /\bModel\b/.test(text);
    });
  }, undefined, { timeoutMs: 5000 }).catch(() => false);
}

async function clickVisibleElementByText(tab, labels) {
  const normalizedLabels = labels.map((label) => normalizeWhitespace(label));
  const targetRect = await tab.playwright.evaluate((targetLabels) => {
    const normalize = (value) => String(value ?? "").trim().replace(/\s+/g, " ");
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const candidates = [
      ...document.querySelectorAll(
        "button,[role='menuitem'],[role='menuitemradio'],[role='option']"
      ),
    ];
    const target = candidates.find((element) => {
      if (!isVisible(element)) {
        return false;
      }
      const text = normalize(element.innerText || element.textContent);
      return targetLabels.includes(text) || targetLabels.some((label) => text.startsWith(label));
    });

    if (!target) {
      return null;
    }

    const rect = target.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      text: normalize(target.innerText || target.textContent),
    };
  }, normalizedLabels, { timeoutMs: 5000 }).catch(() => false);

  if (!targetRect) {
    return false;
  }

  if (!tab.cua?.click) {
    return false;
  }

  await tab.cua.click({
    x: Math.round(targetRect.x),
    y: Math.round(targetRect.y),
  });
  await tab.playwright.waitForTimeout(100);
  return true;
}

async function isVisibleElementTextPresent(tab, labels) {
  const normalizedLabels = labels.map((label) => normalizeWhitespace(label));
  return await tab.playwright.evaluate((targetLabels) => {
    const normalize = (value) => String(value ?? "").trim().replace(/\s+/g, " ");
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    return [
      ...document.querySelectorAll(
        "button,[role='menuitem'],[role='menuitemradio'],[role='option'],[role='combobox']"
      ),
    ].some((element) => {
      if (!isVisible(element)) {
        return false;
      }

      const text = normalize(element.innerText || element.textContent);
      return targetLabels.includes(text) || targetLabels.some((label) => text.startsWith(label));
    });
  }, normalizedLabels, { timeoutMs: 5000 }).catch(() => false);
}

function normalizeWhitespace(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

async function composePrompt(tab, {
  prompt,
  appName,
  attachments,
  maxImageClipboardBytes,
  uploadTimeoutMs,
}) {
  const composer = await ensureComposer(tab);
  await composer.fill("", {});

  if (appName) {
    await composer.type(`@${appName}`, {});
    await tab.playwright.waitForTimeout(700);
    await trySelectAppSuggestion(tab, appName);
    await composer.type(" ", {});
  }

  const textBlocks = [];
  const attachmentSummary = [];

  for (const attachment of attachments) {
    const prepared = await prepareAttachment(attachment, {
      maxImageClipboardBytes,
    });

    if (prepared.kind === "text") {
      attachmentSummary.push(prepared.summary);
      textBlocks.push(formatTextAttachment(prepared));
      continue;
    }

    try {
      const uploadResult = await uploadAttachment(tab, prepared, {
        timeoutMs: uploadTimeoutMs,
      });
      attachmentSummary.push({
        ...prepared.summary,
        strategy: uploadResult.strategy,
      });
      continue;
    } catch (uploadError) {
      if (
        prepared.kind === "image" &&
        prepared.allowClipboardFallback &&
        prepared.summary.bytes <= BROWSER_CLIPBOARD_IMAGE_SOFT_LIMIT_BYTES
      ) {
        const pasteResult = await pasteImageAttachment(tab, composer, prepared);
        attachmentSummary.push({
          ...prepared.summary,
          strategy: `${pasteResult.strategy}-after-upload-fallback`,
          uploadError: String(uploadError?.message ?? uploadError ?? ""),
        });
        continue;
      }
      throw uploadError;
    }
  }

  const finalPrompt = [prompt.trim(), ...textBlocks].join("\n\n");
  const hasImageAttachment = attachmentSummary.some((item) => item.kind === "image");

  if (appName || hasImageAttachment) {
    await pasteTextToComposer(tab, composer, finalPrompt);
  } else {
    await composer.fill(finalPrompt, {});
  }

  if (hasImageAttachment) {
    await waitForImageAttachmentsToSettle(tab, {
      stableMs: IMAGE_ATTACHMENT_SETTLE_MS,
      timeoutMs: uploadTimeoutMs,
    });
  }

  return {
    prompt: finalPrompt,
    attachmentSummary,
  };
}

async function trySelectAppSuggestion(tab, appName) {
  const candidates = [
    tab.playwright.getByRole("option", { name: appName }),
    tab.playwright.getByRole("menuitem", { name: appName }),
    tab.playwright.getByText(appName, { exact: true }),
  ];

  for (const locator of candidates) {
    const count = await locator.count();
    if (count === 1) {
      await locator.click({});
      return true;
    }
  }

  return false;
}

function normalizeAttachments({ attachments, filePaths }) {
  const combined = [];

  for (const filePath of filePaths) {
    combined.push({ path: filePath });
  }

  for (const attachment of attachments) {
    if (typeof attachment === "string") {
      combined.push({ path: attachment });
    } else {
      combined.push(attachment);
    }
  }

  return combined;
}

async function prepareAttachment(attachment, { maxImageClipboardBytes }) {
  if (!attachment || typeof attachment.path !== "string") {
    throw codedError(
      "ATTACHMENT_INVALID",
      "Each attachment must include an absolute local path."
    );
  }

  if (!attachment.path.startsWith("/")) {
    throw codedError(
      "ATTACHMENT_PATH_INVALID",
      "Each attachment path must be absolute."
    );
  }

  await access(attachment.path);
  const fileStat = await stat(attachment.path);
  if (!fileStat.isFile()) {
    throw codedError(
      "ATTACHMENT_PATH_INVALID",
      `Attachment path is not a file: ${attachment.path}.`
    );
  }

  const ext = path.extname(attachment.path).toLowerCase();
  const name = path.basename(attachment.path);

  if (attachment.inline === true && (TEXT_EXTENSIONS.has(ext) || attachment.kind === "text")) {
    const rawText = await readFile(attachment.path, "utf8");
    const truncated = rawText.length > MAX_TEXT_ATTACHMENT_CHARS;
    const text = truncated
      ? rawText.slice(0, MAX_TEXT_ATTACHMENT_CHARS)
      : rawText;
    return {
      kind: "text",
      path: attachment.path,
      name,
      text,
      truncated,
      summary: {
        kind: "text",
        name,
        path: attachment.path,
        chars: rawText.length,
        truncated,
        strategy: "prompt-inline",
      },
    };
  }

  if (IMAGE_MIME_BY_EXT.has(ext)) {
    const bytes = await readFile(attachment.path);
    if (
      Number.isFinite(maxImageClipboardBytes) &&
      bytes.length > maxImageClipboardBytes
    ) {
      throw codedError(
        "IMAGE_CLIPBOARD_TOO_LARGE",
        `Image '${name}' is larger than the configured clipboard paste limit.`,
        {
          path: attachment.path,
          bytes: bytes.length,
          maxImageClipboardBytes,
        }
      );
    }

    return {
      kind: "image",
      path: attachment.path,
      name,
      mimeType: IMAGE_MIME_BY_EXT.get(ext),
      base64: bytes.toString("base64"),
      preloadedClipboard: attachment.preloadedClipboard === true,
      allowClipboardFallback: attachment.allowClipboardFallback !== false,
      summary: {
        kind: "image",
        name,
        path: attachment.path,
        mimeType: IMAGE_MIME_BY_EXT.get(ext),
        bytes: bytes.length,
        strategy: "upload",
      },
    };
  }

  return {
    kind: "file",
    path: attachment.path,
    name,
    bytes: fileStat.size,
    mimeType: FILE_MIME_BY_EXT.get(ext) ?? "application/octet-stream",
    summary: {
      kind: TEXT_EXTENSIONS.has(ext) || attachment.kind === "text" ? "text-file" : "file",
      name,
      path: attachment.path,
      bytes: fileStat.size,
      mimeType: FILE_MIME_BY_EXT.get(ext) ?? "application/octet-stream",
      strategy: "upload",
    },
  };
}

async function uploadAttachment(tab, attachment, { timeoutMs }) {
  const beforeSignal = await readAttachmentSignal(tab);
  const paths = [attachment.path];
  const errors = [];
  const attempts = [
    {
      name: "visible-chatgpt-file-input",
      run: async () => {
        await clickFileChooserTarget(tab, "#upload-files", paths, timeoutMs, {
          requireVisible: true,
        });
      },
    },
    {
      name: "add-photos-files-menu-item",
      run: async () => {
        await clickChatGPTAddPhotosMenuItem(tab, paths, timeoutMs);
      },
    },
    {
      name: "generic-add-files-button",
      run: async () => {
        const locator = tab.playwright.getByRole("button", {
          name: "Add files and more",
        });
        await clickFileChooserLocator(tab, locator, paths, timeoutMs);
      },
    },
    {
      name: "direct-file-input-set",
      run: async () => {
        await setHiddenFileInput(tab, paths);
      },
    },
    {
      name: "dom-data-transfer-file-input",
      run: async () => {
        await setFilesViaDomDataTransfer(tab, [attachment]);
      },
    },
  ];

  for (const attempt of attempts) {
    try {
      await attempt.run();
      await waitForUploadedAttachment(tab, beforeSignal, attachment, timeoutMs);
      return { strategy: attempt.name };
    } catch (error) {
      errors.push(`${attempt.name}: ${errorMessage(error)}`);
    }
  }

  throw uploadFailedError(attachment, errors);
}

async function clickChatGPTAddPhotosMenuItem(tab, paths, timeoutMs) {
  let menuItem = tab.playwright.locator("div[role='menuitem']").filter({
    hasText: "Add photos & files",
  });

  if ((await safeLocatorCount(menuItem)) !== 1) {
    await openComposerMenu(tab);
    menuItem = tab.playwright.locator("div[role='menuitem']").filter({
      hasText: "Add photos & files",
    });
  }

  await clickFileChooserLocator(tab, menuItem, paths, timeoutMs);
}

async function clickFileChooserTarget(tab, selector, paths, timeoutMs, options = {}) {
  const locator = tab.playwright.locator(selector);
  if ((await safeLocatorCount(locator)) !== 1) {
    throw new Error(`Upload target was not uniquely available: ${selector}`);
  }
  if (
    options.requireVisible === true &&
    typeof locator.isVisible === "function" &&
    !(await locator.isVisible({ timeoutMs: 1000 }).catch(() => false))
  ) {
    throw new Error(`Upload target is hidden: ${selector}`);
  }

  await clickFileChooserLocator(tab, locator, paths, timeoutMs);
}

async function clickFileChooserLocator(tab, locator, paths, timeoutMs) {
  if (!locator || typeof locator.click !== "function") {
    throw new Error("Upload locator was not available.");
  }
  if (typeof tab.playwright.waitForEvent !== "function") {
    throw new Error("The active browser page does not expose file chooser events.");
  }

  const chooserPromise = tab.playwright.waitForEvent("filechooser", {
    timeout: timeoutMs,
    timeoutMs,
  });

  try {
    await locator.click({ timeoutMs: Math.min(timeoutMs, 10000) });
  } catch (error) {
    await chooserPromise.catch(() => undefined);
    throw error;
  }

  const chooser = await chooserPromise;
  if (!chooser || typeof chooser.setFiles !== "function") {
    throw new Error("File chooser event did not return a setFiles-capable chooser.");
  }

  if (
    paths.length > 1 &&
    typeof chooser.isMultiple === "function" &&
    !(await chooser.isMultiple())
  ) {
    throw new Error("The active ChatGPT file chooser only accepts one file.");
  }

  try {
    await chooser.setFiles(paths);
  } catch (error) {
    throw new Error(`fileChooser.setFiles failed. ${errorMessage(error)}`);
  }
}

async function setHiddenFileInput(tab, paths) {
  const inputs = tab.playwright.locator("input[type='file']");
  const count = await safeLocatorCount(inputs);
  if (count < 1) {
    throw new Error("No hidden file input was available.");
  }

  const target = typeof inputs.last === "function" ? inputs.last() : inputs;
  if (typeof target.setInputFiles !== "function") {
    throw new Error("Hidden file input does not expose setInputFiles().");
  }

  try {
    await target.setInputFiles(paths);
  } catch (error) {
    throw new Error(`input[type=file].setInputFiles failed. ${errorMessage(error)}`);
  }
}

async function setFilesViaDomDataTransfer(tab, attachments) {
  const totalBytes = attachments.reduce((sum, attachment) => sum + (attachment.summary.bytes ?? 0), 0);
  if (totalBytes > DOM_DATA_TRANSFER_UPLOAD_LIMIT_BYTES) {
    throw new Error(
      `DOM DataTransfer upload fallback is limited to ${DOM_DATA_TRANSFER_UPLOAD_LIMIT_BYTES} bytes.`
    );
  }

  const files = [];
  for (const attachment of attachments) {
    const bytes = await readFile(attachment.path);
    files.push({
      name: attachment.name,
      mimeType: attachment.mimeType ?? attachment.summary.mimeType ?? "application/octet-stream",
      base64: bytes.toString("base64"),
    });
  }

  await tab.playwright.evaluate(({ files: pageFiles }) => {
    const inputs = Array.from(document.querySelectorAll("input[type='file']"));
    const input = inputs.at(-1);
    if (!input || input.tagName?.toLowerCase() !== "input") {
      throw new Error("No file input exists in the ChatGPT page.");
    }

    const transfer = typeof DataTransfer === "function"
      ? new DataTransfer()
      : new ClipboardEvent("copy").clipboardData;
    if (!transfer?.items?.add) {
      throw new Error("The page does not expose a DataTransfer-capable file container.");
    }
    for (const file of pageFiles) {
      const binary = atob(file.base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      transfer.items.add(new File([bytes], file.name, { type: file.mimeType }));
    }

    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { files }, { timeoutMs: 10000 });
}

async function waitForUploadedAttachment(tab, beforeSignal, attachment, timeoutMs) {
  const deadline = Date.now() + (timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS);

  while (Date.now() < deadline) {
    const signal = await readAttachmentSignal(tab);
    if (
      signal.fileNames.includes(attachment.name) ||
      signal.composerText.includes(attachment.name) ||
      signal.removeButtonCount > beforeSignal.removeButtonCount ||
      signal.attachmentButtonCount > beforeSignal.attachmentButtonCount ||
      signal.imageCount > beforeSignal.imageCount
    ) {
      return;
    }
    await tab.playwright.waitForTimeout(500);
  }

  throw codedError(
    "ATTACHMENT_UPLOAD_NOT_CONFIRMED",
    `File '${attachment.name}' was selected but ChatGPT did not show a confirmed attachment before send.`,
    {
      path: attachment.path,
      bytes: attachment.summary.bytes,
    }
  );
}

async function waitForImageAttachmentsToSettle(tab, {
  stableMs = IMAGE_ATTACHMENT_SETTLE_MS,
  timeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS,
} = {}) {
  const deadline = Date.now() + Math.max(timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS, stableMs);
  let lastSignature = "";
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    const signal = await readAttachmentSignal(tab);
    const signature = attachmentSignalSignature(signal);
    const hasImage = signal.imageCount > 0 || signal.attachmentButtonCount > 0;
    const isBusy = isAttachmentUploadBusySignal(signal);

    if (signature !== lastSignature) {
      lastSignature = signature;
      stableSince = Date.now();
    }

    if (hasImage && !isBusy && Date.now() - stableSince >= stableMs) {
      return;
    }

    await tab.playwright.waitForTimeout(500);
  }

  throw codedError(
    "IMAGE_ATTACHMENT_UPLOAD_NOT_SETTLED",
    `Image attachment did not appear fully settled for ${stableMs}ms before send.`
  );
}

function attachmentSignalSignature(signal = {}) {
  return JSON.stringify({
    fileNames: signal.fileNames ?? [],
    imageCount: signal.imageCount ?? 0,
    removeButtonCount: signal.removeButtonCount ?? 0,
    attachmentButtonCount: signal.attachmentButtonCount ?? 0,
    uploadBusy: isAttachmentUploadBusySignal(signal),
  });
}

function isAttachmentUploadBusySignal(signal = {}) {
  const lines = String(signal.composerText ?? "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && line.length <= 120);

  return lines.some((line) =>
    /^(uploading|processing|attaching|reading)\b/i.test(line) ||
    /^(analyzing|processing|reading) images?$/i.test(line) ||
    /\b(uploading|processing|attaching|reading)\b.*\.(png|jpe?g|webp|gif)\b/i.test(line) ||
    /(正在)?(上載|上傳)|處理中|讀取中|圖片(上載|上傳)中/.test(line)
  );
}

async function readAttachmentSignal(tab) {
  return await tab.playwright.evaluate(() => {
    const forms = Array.from(document.querySelectorAll("form"));
    const composerRoot = forms.at(-1) || document.body;
    const labels = Array.from(composerRoot.querySelectorAll("button, [aria-label]"))
      .map((element) =>
        (
          element.getAttribute("aria-label") ||
          element.innerText ||
          element.textContent ||
          ""
        ).trim()
      )
      .filter(Boolean);
    const text = (composerRoot.innerText || composerRoot.textContent || "")
      .trim()
      .slice(0, 4000);
    const fileNames = Array.from(text.matchAll(/[\w .()[\]-]+\.[A-Za-z0-9]{2,8}/g))
      .map((match) => match[0].trim());

    return {
      fileNames,
      imageCount: composerRoot.querySelectorAll("img, canvas").length,
      removeButtonCount: labels.filter((label) =>
        /remove|delete|attachment|file|image/i.test(label)
      ).length,
      attachmentButtonCount: labels.filter((label) =>
        /attachment|file|image/i.test(label)
      ).length,
      composerText: text,
    };
  }, undefined, { timeoutMs: 5000 });
}

async function safeLocatorCount(locator) {
  if (!locator || typeof locator.count !== "function") {
    return 0;
  }
  return locator.count().catch(() => 0);
}

function uploadFailedError(attachment, errors) {
  const detail = errors.join("\n");
  const permissionLike = /not allowed|permission|file urls|filechooser|file chooser|setFiles|setInputFiles/i.test(detail);
  const error = codedError(
    permissionLike ? "ATTACHMENT_UPLOAD_PERMISSION_REQUIRED" : "ATTACHMENT_UPLOAD_FAILED",
    permissionLike
      ? `Could not upload '${attachment.name}'. ${CODEX_UPLOAD_PERMISSION_FIX} ${CHROME_FILE_URL_PERMISSION_FIX}`
      : `Could not upload '${attachment.name}' through the available ChatGPT upload paths.`,
    {
      path: attachment.path,
      bytes: attachment.summary.bytes,
      attempts: errors,
      remediation: [
        {
          label: "Codex Chrome uploads",
          instruction: CODEX_UPLOAD_PERMISSION_FIX,
        },
        {
          label: "Chrome file URLs",
          instruction: CHROME_FILE_URL_PERMISSION_FIX,
        },
      ],
    }
  );
  return error;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "");
}

function formatTextAttachment(attachment) {
  const truncatedNote = attachment.truncated
    ? "\n[Attachment truncated by GPT Relay.]"
    : "";
  return [
    `Attachment: ${attachment.name}`,
    "```text",
    attachment.text,
    "```",
    truncatedNote,
  ].join("\n");
}

async function pasteImageAttachment(tab, composer, attachment) {
  await composer.click({});
  const beforeSignal = await readImageAttachmentSignal(tab);

  if (attachment.preloadedClipboard) {
    await pressSystemPaste(tab, composer);
    await tab.playwright.waitForTimeout(1200);
    await waitForImageAttachment(tab, beforeSignal, attachment);
    return { strategy: "preloaded-native-clipboard-paste" };
  }

  if (attachment.summary.bytes > BROWSER_CLIPBOARD_IMAGE_SOFT_LIMIT_BYTES) {
    try {
      await pasteImageAttachmentViaNativeClipboard(tab, composer, attachment);
      await tab.playwright.waitForTimeout(1200);
      await waitForImageAttachment(tab, beforeSignal, attachment);
      return { strategy: "native-macos-clipboard-paste" };
    } catch (nativeClipboardError) {
      throw imagePasteFailedError(attachment, nativeClipboardError);
    }
  }

  try {
    await tab.clipboard.write([
      {
        entries: [
          {
            mimeType: attachment.mimeType,
            base64: attachment.base64,
          },
        ],
      },
    ]);
    await pressPaste(tab, composer);
    await tab.playwright.waitForTimeout(1200);
    await waitForImageAttachment(tab, beforeSignal, attachment);
    return { strategy: "browser-clipboard-paste" };
  } catch (clipboardError) {
    try {
      await pasteImageAttachmentViaNativeClipboard(tab, composer, attachment);
      await tab.playwright.waitForTimeout(1200);
      await waitForImageAttachment(tab, beforeSignal, attachment);
      return { strategy: "native-macos-clipboard-paste" };
    } catch (nativeClipboardError) {
      throw imagePasteFailedError(
        attachment,
        nativeClipboardError,
        clipboardError,
        nativeClipboardError
      );
    }
  }
}

async function waitForImageAttachment(tab, beforeSignal, attachment) {
  const deadline = Date.now() + 20000;

  while (Date.now() < deadline) {
    const signal = await readImageAttachmentSignal(tab);
    if (
      signal.imageCount > beforeSignal.imageCount ||
      signal.removeButtonCount > beforeSignal.removeButtonCount ||
      signal.composerText.includes(attachment.name)
    ) {
      return;
    }
    await tab.playwright.waitForTimeout(500);
  }

  throw codedError(
    "IMAGE_ATTACHMENT_NOT_CONFIRMED",
    `Image '${attachment.name}' was pasted but ChatGPT did not show a confirmed attachment before send.`,
    {
      path: attachment.path,
      bytes: attachment.summary.bytes,
      mimeType: attachment.mimeType,
    }
  );
}

async function readImageAttachmentSignal(tab) {
  return await tab.playwright.evaluate(() => {
    const forms = Array.from(document.querySelectorAll("form"));
    const composerRoot = forms.at(-1) || document.body;
    const labels = Array.from(composerRoot.querySelectorAll("button, [aria-label]"))
      .map((element) =>
        (
          element.getAttribute("aria-label") ||
          element.innerText ||
          element.textContent ||
          ""
        ).trim()
      )
      .filter(Boolean);

    return {
      imageCount: composerRoot.querySelectorAll("img, canvas").length,
      removeButtonCount: labels.filter((label) =>
        /remove|delete|attachment|file|image/i.test(label)
      ).length,
      composerText: (composerRoot.innerText || composerRoot.textContent || "")
        .trim()
        .slice(0, 2000),
    };
  }, undefined, { timeoutMs: 5000 });
}

function imagePasteFailedError(
  attachment,
  pasteError,
  clipboardError,
  nativeClipboardError
) {
  return codedError(
    "IMAGE_CLIPBOARD_PASTE_FAILED",
    `Could not paste image '${attachment.name}' through the available clipboard paste strategies.`,
    {
      path: attachment.path,
      bytes: attachment.summary.bytes,
      mimeType: attachment.mimeType,
      cause: pasteError,
      clipboardError: clipboardError
        ? String(clipboardError?.message ?? clipboardError ?? "")
        : undefined,
      nativeClipboardError: nativeClipboardError
        ? String(nativeClipboardError?.message ?? nativeClipboardError ?? "")
        : undefined,
    }
  );
}

function isNativePipeClosedError(error) {
  return /native pipe is closed/i.test(String(error?.message ?? error ?? ""));
}

async function pasteImageAttachmentViaNativeClipboard(tab, composer, attachment) {
  const helperPath = await ensureMacosImageClipboardHelper();
  await execFileAsync(helperPath, [attachment.path, attachment.mimeType], {
    timeout: 30000,
  });
  await composer.click({});
  await pressSystemPaste(tab, composer);
}

async function pressSystemPaste(tab, composer) {
  await composer.click({});
  if (tab.cua?.keypress) {
    await tab.cua.keypress({ keys: ["ControlOrMeta", "V"] });
    return;
  }
  await composer.press("ControlOrMeta+V", {});
}

async function ensureMacosImageClipboardHelper() {
  const tmpDir = globalThis.nodeRepl?.tmpDir || "/tmp";
  const helperDir = path.join(tmpDir, "gpt-relay", "native");
  const helperPath = path.join(helperDir, "macos-copy-image-to-clipboard");
  await mkdir(helperDir, { recursive: true });

  await execFileAsync(
    "/usr/bin/clang",
    [
      "-framework",
      "AppKit",
      MACOS_IMAGE_CLIPBOARD_HELPER_SOURCE,
      "-o",
      helperPath,
    ],
    { timeout: 30000 }
  );

  return helperPath;
}

async function pasteTextToComposer(tab, composer, text) {
  await tab.clipboard.writeText(text);
  await composer.click({});
  try {
    await pressPaste(tab, composer);
  } catch {
    await composer.type(text, {});
  }
}

async function pressPaste(tab, composer) {
  try {
    await composer.press("ControlOrMeta+V", {});
  } catch (error) {
    if (tab.cua?.keypress) {
      await tab.cua.keypress({ keys: ["ControlOrMeta", "V"] });
      return;
    }
    throw error;
  }
}

async function clickSend(tab) {
  const sendButton = tab.playwright.getByRole("button", {
    name: "Send prompt",
  });

  if ((await sendButton.count()) !== 1) {
    throw codedError(
      "SEND_BUTTON_MISSING",
      "Could not find the ChatGPT send button after filling the prompt."
    );
  }

  await sendButton.click({});
}

async function waitForConversationUrl(tab, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const currentUrl = await tab.url();
    if (getConversationId(currentUrl)) {
      return currentUrl;
    }
    await tab.playwright.waitForTimeout(500);
  }

  return await tab.url();
}

async function readChatStateWithFallback(tab, prompt) {
  try {
    const state = await readChatState(tab);
    if (state.messages?.length) {
      return state;
    }
  } catch {
    // Fall through to a synthetic minimal state so the session remains searchable.
  }

  return {
    url: await tab.url(),
    title: await safeTabTitle(tab),
    messages: [
      {
        index: 0,
        role: "user",
        text: prompt.trim(),
      },
    ],
    artifacts: [],
    isAnswering: true,
  };
}

async function safeTabTitle(tab) {
  try {
    return await tab.title();
  } catch {
    return "ChatGPT";
  }
}

async function waitForAssistantResponse(tab, timeoutMs, {
  allowPending,
  allowArtifactOnly = false,
  allowDeepResearchReport = false,
}) {
  const start = Date.now();
  let lastState = null;
  let lastAssistantText = "";
  let lastAssistantChangedAt = Date.now();
  let lastArtifactSignature = "";
  let lastArtifactChangedAt = Date.now();
  let lastDeepResearchSignature = "";
  let lastDeepResearchChangedAt = Date.now();

  while (Date.now() - start < timeoutMs) {
    await tab.playwright.waitForTimeout(POLL_INTERVAL_MS);
    const state = allowDeepResearchReport
      ? await readChatStateForFeature(tab, "deep-research")
      : await readChatState(tab);
    lastState = state;

    const assistantMessages = getContentAssistantMessages(state.messages);

    if (assistantMessages.length > 0) {
      const latestText = assistantMessages.at(-1).text;
      if (latestText !== lastAssistantText) {
        lastAssistantText = latestText;
        lastAssistantChangedAt = Date.now();
      }
    }

    const artifactSignature = imageArtifactSignature(state.artifacts);
    if (artifactSignature !== lastArtifactSignature) {
      lastArtifactSignature = artifactSignature;
      lastArtifactChangedAt = Date.now();
    }

    const deepResearchSignatureValue = deepResearchSignature(state.deepResearch);
    if (deepResearchSignatureValue !== lastDeepResearchSignature) {
      lastDeepResearchSignature = deepResearchSignatureValue;
      lastDeepResearchChangedAt = Date.now();
    }

    if (isResponseCompleteSnapshot({
      latestText: lastAssistantText,
      textStableForMs: Date.now() - lastAssistantChangedAt,
      artifactCount: generatedImageArtifacts(state.artifacts).length,
      artifactStableForMs: Date.now() - lastArtifactChangedAt,
      allowArtifactOnly,
      allowDeepResearchReport,
      deepResearch: state.deepResearch,
      deepResearchStableForMs: Date.now() - lastDeepResearchChangedAt,
      isAnswering: state.isAnswering,
      responseActionsAvailable: state.responseActionsAvailable,
    })) {
      return {
        status: "complete",
        assistantText: lastAssistantText,
        state,
      };
    }
  }

  if (allowPending) {
    const assistantMessages = getContentAssistantMessages(lastState?.messages ?? []);
    return {
      status: "pending",
      assistantText: assistantMessages.at(-1)?.text ?? "",
      state: lastState,
    };
  }

  throw codedError(
    "CHATGPT_RESPONSE_TIMEOUT",
    "ChatGPT did not finish answering before the timeout.",
    { lastState }
  );
}

function isResponseCompleteSnapshot(snapshot) {
  const textComplete = Boolean(
    snapshot.latestText?.trim() &&
    !isAssistantStatusText(snapshot.latestText) &&
    snapshot.textStableForMs >= RESPONSE_STABLE_MS &&
    !snapshot.isAnswering &&
    (
      snapshot.responseActionsAvailable ||
      snapshot.textStableForMs >= RESPONSE_ACTION_FALLBACK_MS
    )
  );
  const artifactComplete = Boolean(
    snapshot.allowArtifactOnly &&
    snapshot.artifactCount > 0 &&
    snapshot.artifactStableForMs >= RESPONSE_STABLE_MS &&
    !snapshot.isAnswering
  );
  const deepResearchComplete = Boolean(
    snapshot.allowDeepResearchReport &&
    snapshot.deepResearch?.completed &&
    snapshot.deepResearch?.reportTitle &&
    !snapshot.deepResearch?.running &&
    snapshot.deepResearchStableForMs >= RESPONSE_STABLE_MS &&
    !snapshot.isAnswering
  );

  return textComplete || artifactComplete || deepResearchComplete;
}

async function waitForAssistantResponseInChunks(tab, {
  timeoutMs,
  waitChunkMs,
  allowPending,
  allowArtifactOnly,
  allowDeepResearchReport,
  onPending,
}) {
  const started = Date.now();
  let lastPending = null;

  while (Date.now() - started < timeoutMs) {
    const remainingMs = timeoutMs - (Date.now() - started);
    const chunkMs = Math.max(1, Math.min(waitChunkMs ?? DEFAULT_WAIT_CHUNK_MS, remainingMs));
    const result = await waitForAssistantResponse(tab, chunkMs, {
      allowPending: true,
      allowArtifactOnly,
      allowDeepResearchReport,
    });

    if (result.status === "complete") {
      return result;
    }

    lastPending = result;
    await onPending?.(result);

    if (allowPending) {
      return result;
    }
  }

  if (allowPending && lastPending) {
    return lastPending;
  }

  throw codedError(
    "CHATGPT_RESPONSE_TIMEOUT",
    "ChatGPT did not finish answering before the timeout.",
    { lastState: lastPending?.state ?? null }
  );
}

async function readChatState(tab) {
  const state = await tab.playwright.evaluate(({ minImageEdge, minImageArea }) => {
    function isAnsweringButtonLabel(label) {
      const normalized = label.trim().replace(/\s+/g, " ");
      return (
        (/stop/i.test(normalized) && /(answer|generat|respond|stream|thinking)/i.test(normalized)) ||
        /^(停止|停止生成|停止回答|停止响应|停止思考)$/.test(normalized)
      );
    }

    function isVisibleElement(element) {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    function isExcludedMarkdownElement(element) {
      const tag = element.tagName?.toLowerCase();
      return (
        ["script", "style", "svg", "button", "input", "textarea", "select", "noscript"].includes(tag) ||
        element.getAttribute("aria-hidden") === "true" ||
        element.getAttribute("role") === "button" ||
        element.closest("button,[role='button'],form")
      );
    }

    const markdownBlockTags = new Set([
      "address",
      "article",
      "aside",
      "blockquote",
      "dd",
      "div",
      "dl",
      "dt",
      "fieldset",
      "figcaption",
      "figure",
      "footer",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "header",
      "hr",
      "li",
      "main",
      "nav",
      "ol",
      "p",
      "pre",
      "section",
      "table",
      "tbody",
      "td",
      "tfoot",
      "th",
      "thead",
      "tr",
      "ul",
    ]);

    function normalizeInlineMarkdown(value) {
      return String(value ?? "").replace(/\u00a0/g, " ").replace(/[ \t\r\n]+/g, " ");
    }

    function normalizeMarkdownBlocks(value) {
      return String(value ?? "")
        .split("\n")
        .map((line) => line.replace(/[ \t]+$/g, ""))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    function escapeCodeTicks(value) {
      const text = String(value ?? "").trim();
      return text.includes("`") ? `\`\`${text.replace(/`/g, "\\`")}\`\`` : `\`${text}\``;
    }

    function escapeTableCell(value) {
      return String(value ?? "").replace(/\|/g, "\\|").replace(/\n+/g, "<br>").trim();
    }

    function directElementChildren(element, tagName) {
      return Array.from(element.children).filter(
        (child) => child.tagName?.toLowerCase() === tagName
      );
    }

    function hasMarkdownBlockChild(element) {
      return Array.from(element.childNodes).some(
        (child) =>
          child.nodeType === Node.ELEMENT_NODE &&
          markdownBlockTags.has(child.tagName.toLowerCase())
      );
    }

    function serializeInlineMarkdown(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return normalizeInlineMarkdown(node.textContent);
      }
      if (node.nodeType !== Node.ELEMENT_NODE) {
        return "";
      }
      if (isExcludedMarkdownElement(node) || !isVisibleElement(node)) {
        return "";
      }

      const tag = node.tagName.toLowerCase();
      if (tag === "br") {
        return "\n";
      }
      if (tag === "img") {
        return normalizeInlineMarkdown(node.getAttribute("alt") || "");
      }
      if (tag === "code" && node.closest("pre")) {
        return node.textContent || "";
      }

      const childText = () =>
        Array.from(node.childNodes)
          .map((child) => serializeInlineMarkdown(child))
          .join("")
          .replace(/[ \t]+/g, " ")
          .trim();

      if (tag === "code") {
        const code = normalizeInlineMarkdown(node.textContent).trim();
        return code ? escapeCodeTicks(code) : "";
      }
      if (tag === "strong" || tag === "b") {
        const text = childText();
        return text ? `**${text}**` : "";
      }
      if (tag === "em" || tag === "i") {
        const text = childText();
        return text ? `*${text}*` : "";
      }
      if (tag === "a") {
        const text = childText() || normalizeInlineMarkdown(node.href || node.getAttribute("href") || "");
        const href = node.href || node.getAttribute("href") || "";
        return href && text ? `[${text}](${href})` : text;
      }

      return childText();
    }

    function serializeMarkdownChildren(element, depth = 0) {
      const parts = Array.from(element.childNodes)
        .map((child) => serializeMarkdownNode(child, depth))
        .map(normalizeMarkdownBlocks)
        .filter(Boolean);
      return parts.join("\n\n");
    }

    function serializeMarkdownList(list, depth = 0) {
      const ordered = list.tagName.toLowerCase() === "ol";
      return directElementChildren(list, "li")
        .map((li, index) => serializeMarkdownListItem(li, depth, ordered, index))
        .filter(Boolean)
        .join("\n");
    }

    function serializeMarkdownListItem(li, depth, ordered, index) {
      const indent = "  ".repeat(depth);
      const marker = ordered ? `${index + 1}.` : "-";
      const nestedLists = [];
      const directParts = [];

      for (const child of Array.from(li.childNodes)) {
        if (
          child.nodeType === Node.ELEMENT_NODE &&
          ["ul", "ol"].includes(child.tagName.toLowerCase())
        ) {
          nestedLists.push(serializeMarkdownList(child, depth + 1));
          continue;
        }

        const part = serializeMarkdownNode(child, depth).trim();
        if (part) {
          directParts.push(part);
        }
      }

      const content = normalizeMarkdownBlocks(directParts.join("\n\n"));
      const continuationIndent = `${indent}  `;
      const itemBody = content
        ? content.split("\n").map((line, lineIndex) =>
            lineIndex === 0 ? line : `${continuationIndent}${line}`
          ).join("\n")
        : "";
      const firstLine = `${indent}${marker}${itemBody ? ` ${itemBody}` : ""}`;
      const nested = nestedLists.map(normalizeMarkdownBlocks).filter(Boolean).join("\n");
      return nested ? `${firstLine}\n${nested}` : firstLine;
    }

    function serializeMarkdownTable(table) {
      const rows = Array.from(table.querySelectorAll("tr"))
        .map((row) =>
          Array.from(row.children)
            .filter((cell) => ["th", "td"].includes(cell.tagName.toLowerCase()))
            .map((cell) => escapeTableCell(serializeMarkdownChildren(cell)))
        )
        .filter((cells) => cells.length > 0);

      if (rows.length === 0) {
        return "";
      }

      const columnCount = Math.max(...rows.map((row) => row.length));
      const padRow = (row) => Array.from({ length: columnCount }, (_, index) => row[index] || "");
      const header = padRow(rows[0]);
      const separator = header.map(() => "---");
      const body = rows.slice(1).map(padRow);
      const formatRow = (row) => `| ${row.join(" | ")} |`;
      return [formatRow(header), formatRow(separator), ...body.map(formatRow)].join("\n");
    }

    function serializeMarkdownNode(node, depth = 0) {
      if (node.nodeType === Node.TEXT_NODE) {
        return normalizeInlineMarkdown(node.textContent).trim();
      }
      if (node.nodeType !== Node.ELEMENT_NODE) {
        return "";
      }
      if (isExcludedMarkdownElement(node) || !isVisibleElement(node)) {
        return "";
      }

      const tag = node.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        const level = Number(tag.slice(1));
        const text = serializeInlineMarkdown(node);
        return text ? `${"#".repeat(level)} ${text}` : "";
      }
      if (tag === "p") {
        return serializeInlineMarkdown(node).trim();
      }
      if (tag === "br") {
        return "\n";
      }
      if (tag === "hr") {
        return "---";
      }
      if (tag === "pre") {
        const codeElement = node.querySelector("code");
        const languageClass = codeElement?.className || "";
        const language = /language-([A-Za-z0-9_-]+)/.exec(languageClass)?.[1] ?? "";
        const code = (codeElement?.textContent || node.textContent || "").replace(/\n+$/g, "");
        return code ? `\`\`\`${language}\n${code}\n\`\`\`` : "";
      }
      if (tag === "ul" || tag === "ol") {
        return serializeMarkdownList(node, depth);
      }
      if (tag === "blockquote") {
        const quote = serializeMarkdownChildren(node, depth);
        return quote
          .split("\n")
          .map((line) => `> ${line}`.trimEnd())
          .join("\n");
      }
      if (tag === "table") {
        return serializeMarkdownTable(node);
      }
      if (tag === "thead" || tag === "tbody" || tag === "tfoot" || tag === "tr") {
        return "";
      }
      if (tag === "li") {
        return serializeMarkdownListItem(node, depth, false, 0);
      }

      return hasMarkdownBlockChild(node)
        ? serializeMarkdownChildren(node, depth)
        : serializeInlineMarkdown(node).trim();
    }

    function messageRole(el) {
      return el.getAttribute("data-message-author-role") ||
        (el.getAttribute("data-markdown-text-style") === "assistant-message" ? "assistant" : "user");
    }

    function messageTextFromElement(el) {
      const role = messageRole(el);
      if (role !== "assistant") {
        return (el.innerText || el.textContent || "")
          .trim()
          .replace(/\n{3,}/g, "\n\n");
      }

      const markdown = normalizeMarkdownBlocks(serializeMarkdownChildren(el));
      const plain = (el.innerText || el.textContent || "")
        .trim()
        .replace(/\n{3,}/g, "\n\n");
      return markdown || plain;
    }

    const legacyMessages = document.querySelectorAll("[data-message-author-role]");
    const messageElements = legacyMessages.length ? legacyMessages : document.querySelectorAll(
      '[data-markdown-text-style="assistant-message"], [data-markdown-text-style="user-message"]'
    );
    const messages = Array.from(messageElements).filter(isVisibleElement).map((el, index) => ({
      index,
      role: messageRole(el),
      text: messageTextFromElement(el),
    }));

    const buttonLabels = Array.from(document.querySelectorAll("button"))
      .map((button) =>
        (button.getAttribute("aria-label") ||
          button.innerText ||
          button.textContent ||
          "").trim()
      )
      .filter(Boolean);

    const hasStopControl = Array.from(document.querySelectorAll("button")).some(
      (button) => {
        const label = (
          button.getAttribute("aria-label") ||
          button.innerText ||
          button.textContent ||
          ""
        ).trim();
        return isVisibleElement(button) && (isAnsweringButtonLabel(label) || button.getAttribute("data-testid") === "stop-button");
      }
    );

    const hasBusyMessage = Boolean(
      document.querySelector(
        "[data-message-author-role='assistant'][aria-busy='true'], [data-message-author-role='assistant'] [aria-busy='true'], [data-markdown-text-style='assistant-message'][aria-busy='true'], [data-markdown-text-style='assistant-message'] [aria-busy='true']"
      )
    );

    const responseActionsAvailable = buttonLabels.some((label) =>
      /\b(copy response|more actions)\b/i.test(label) || /^(复制|更多操作)$/.test(label)
    );

    function textOf(element) {
      return (element?.innerText || element?.textContent || "").trim();
    }

    function roleOf(element) {
      return element.closest("[data-message-author-role]")?.getAttribute("data-message-author-role") ?? "";
    }

    function looksLikeGeneratedImage({ src, alt, width, height, role, element }) {
      if (!src) return false;
      if (role === "user") return false;
      if (element.closest("form")) return false;
      if (/avatar|profile|logo|icon|sprite|emoji/i.test(`${src} ${alt}`)) return false;
      if (src.startsWith("data:image/svg")) return false;
      return width >= minImageEdge && height >= minImageEdge && width * height >= minImageArea;
    }

    const main = Array.from(document.querySelectorAll("main")).filter(isVisibleElement).at(-1);
    const root = main || document.body;
    const pageText = textOf(root)
      .replace(/\n{3,}/g, "\n\n")
      .slice(0, 80000);
    const imageSelector = main ? "main img" : "img";
    const artifacts = [];

    const imageNodes = Array.from(root.querySelectorAll("img"));
    for (const [imageIndex, img] of imageNodes.entries()) {
      const rect = img.getBoundingClientRect();
      const src = img.currentSrc || img.src || img.getAttribute("src") || "";
      const width = Math.round(img.naturalWidth || rect.width || 0);
      const height = Math.round(img.naturalHeight || rect.height || 0);
      const role = roleOf(img);
      const alt = img.getAttribute("alt") || "";
      if (!looksLikeGeneratedImage({ src, alt, width, height, role, element: img })) {
        continue;
      }
      artifacts.push({
        kind: "image",
        source: "img",
        tag: "img",
        selector: imageSelector,
        imageIndex,
        src,
        alt,
        width,
        height,
        x: Math.round(rect.x || 0),
        y: Math.round(rect.y || 0),
        displayWidth: Math.round(rect.width || width || 0),
        displayHeight: Math.round(rect.height || height || 0),
        role,
        text: textOf(img.closest("[data-message-author-role]") || img.parentElement).slice(0, 1000),
      });
    }

    for (const element of Array.from(root.querySelectorAll("[style*='background-image']"))) {
      const style = getComputedStyle(element);
      const match = /url\((['"]?)(.*?)\1\)/.exec(style.backgroundImage || "");
      const src = match?.[2] ?? "";
      const rect = element.getBoundingClientRect();
      const width = Math.round(rect.width || 0);
      const height = Math.round(rect.height || 0);
      const role = roleOf(element);
      if (!looksLikeGeneratedImage({ src, alt: "", width, height, role, element })) {
        continue;
      }
      artifacts.push({
        kind: "image",
        source: "background-image",
        tag: element.tagName.toLowerCase(),
        src,
        width,
        height,
        role,
        text: textOf(element).slice(0, 1000),
      });
    }

    for (const link of Array.from(root.querySelectorAll("a[href]"))) {
      const href = link.href || link.getAttribute("href") || "";
      const label = `${link.getAttribute("download") || ""} ${textOf(link)} ${link.getAttribute("aria-label") || ""}`;
      if (!/\b(download|image|open)\b/i.test(label) && !/\.(png|jpe?g|webp|gif)(?:[?#]|$)/i.test(href)) {
        continue;
      }
      artifacts.push({
        kind: "link",
        source: "link",
        tag: "a",
        href,
        text: textOf(link).slice(0, 1000),
      });
    }

    const dedupedArtifacts = [];
    const seenArtifacts = new Set();
    for (const artifact of artifacts) {
      const key = artifact.src || artifact.href;
      if (!key || seenArtifacts.has(key)) {
        continue;
      }
      seenArtifacts.add(key);
      dedupedArtifacts.push(artifact);
    }

    return {
      url: location.href,
      title: document.title,
      messages,
      artifacts: dedupedArtifacts,
      isAnswering: hasStopControl || hasBusyMessage,
      responseActionsAvailable,
      buttonLabels,
      pageText,
    };
  }, {
    minImageEdge: GENERATED_IMAGE_MIN_EDGE,
    minImageArea: GENERATED_IMAGE_MIN_AREA,
  }, { timeoutMs: 5000 });

  state.deepResearch = parseDeepResearchState({
    text: state.pageText,
    buttonLabels: state.buttonLabels,
    title: state.title,
  });
  delete state.pageText;
  delete state.buttonLabels;
  return state;
}

async function readChatStateForFeature(tab, feature) {
  const state = await readChatState(tab);
  if (!isDeepResearchFeature(feature)) {
    return state;
  }

  const visibleState = await readDeepResearchVisibleState(tab).catch(() => null);
  if (visibleState) {
    state.deepResearch = mergeDeepResearchStates(state.deepResearch, visibleState);
  }
  return state;
}

async function readDeepResearchVisibleState(tab) {
  if (!tab.dom_cua || typeof tab.dom_cua.get_visible_dom !== "function") {
    return null;
  }

  const visibleDom = await tab.dom_cua.get_visible_dom();
  const text = typeof visibleDom === "string"
    ? visibleDom
    : JSON.stringify(visibleDom ?? "");
  return parseDeepResearchState({ text: text.slice(0, 120000) });
}

function parseDeepResearchState({ text = "", buttonLabels = [], title = "" } = {}) {
  const normalizedText = normalizeVisibleText(text);
  const labels = buttonLabels.map((label) => normalizeVisibleText(label)).filter(Boolean);
  const combined = [normalizedText, ...labels].filter(Boolean).join("\n");
  const completionMatch = /Research completed in\s+([^·\n]+?)\s*·\s*(\d+)\s+citations?\s*·\s*(\d+)\s+searches?/i.exec(combined);
  const reportTitle = extractDeepResearchReportTitle(normalizedText, {
    completionText: completionMatch?.[0] ?? "",
    documentTitle: title,
  });
  const exportAvailable = labels.some((label) => /^Export$/i.test(label)) || /\bExport\b/i.test(combined);
  const markdownExportAvailable = /Export to Markdown/i.test(combined);
  const copyContentsAvailable = /Copy contents/i.test(combined);
  const viewerOpen = Boolean(
    reportTitle &&
    (
      /Sources and activity/i.test(combined) ||
      /Table of contents/i.test(combined) ||
      (exportAvailable && countMarkdownLikeHeadings(normalizedText) >= 2)
    )
  );
  const completedCard = Boolean(
    reportTitle &&
    exportAvailable &&
    /(執行摘要|Executive Summary|發展格局|部署現況)/i.test(combined)
  );
  const completed = Boolean(completionMatch || viewerOpen || completedCard);
  const running = !completed && /\b(Researching|Searching|Reading|Analyzing)\b/i.test(combined);
  const present = Boolean(
    completed ||
    running ||
    /Deep research/i.test(combined) ||
    viewerOpen ||
    markdownExportAvailable
  );

  return {
    present,
    running,
    completed,
    completionText: completionMatch?.[0] ?? "",
    durationText: completionMatch?.[1]?.trim() ?? "",
    citationCount: completionMatch ? Number(completionMatch[2]) : null,
    searchCount: completionMatch ? Number(completionMatch[3]) : null,
    reportTitle,
    viewerOpen,
    exportAvailable,
    copyContentsAvailable,
    markdownExportAvailable,
    previewText: extractDeepResearchPreview(normalizedText, completionMatch?.index ?? -1),
  };
}

function normalizeVisibleText(text) {
  let normalized = String(text ?? "");
  if (/<[a-z][\s\S]*\bnode_id=/i.test(normalized)) {
    normalized = normalized
      .replace(/<[^>]*aria-label=(["'])(.*?)\1[^>]*>/g, "\n$2\n")
      .replace(/<[^>]+>/g, "\n")
      .replace(/&quot;/g, "\"")
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }

  return normalized
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractDeepResearchReportTitle(text, { completionText = "", documentTitle = "" } = {}) {
  const lines = normalizeVisibleText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const completionIndex = completionText
    ? lines.findIndex((line) => line.includes(completionText))
    : -1;
  const isGoodTitle = (line) => {
    if (!line || line.length < 4 || line.length > 160) return false;
    if (/^(Research completed|Deep research|Sources and activity|Table of contents|Copy contents|Export|Export to|Share|Close|Open|Download|Regenerate|Stop|Search|Searching|Reading|Analyzing)\b/i.test(line)) {
      return false;
    }
    if (/^\d+\s*(citations?|searches?)$/i.test(line)) return false;
    return true;
  };

  if (completionIndex >= 0) {
    const nearCompletion = lines.slice(completionIndex + 1, completionIndex + 10)
      .find(isGoodTitle);
    if (nearCompletion) {
      return nearCompletion;
    }
  }

  const firstHeading = lines.find((line) => /^#{1,2}\s+\S+/.test(line));
  if (firstHeading) {
    return firstHeading.replace(/^#{1,2}\s+/, "").trim();
  }

  const reportLikeHeading = lines
    .map((line) => trimDeepResearchTitleLine(line))
    .find((line) =>
      isGoodTitle(line) &&
      /(研究報告|報告|research report|report)$/i.test(line)
  );
  if (reportLikeHeading) {
    return reportLikeHeading;
  }

  const knownSectionIndex = lines.findIndex((line) =>
    /^(執行摘要|發展格局|部署現況|監管與治理|基礎設施與人才|行動建議|Executive Summary|Overview|Recommendations)$/i.test(line)
  );
  if (knownSectionIndex > 0) {
    const beforeSection = lines.slice(0, knownSectionIndex).reverse().find(isGoodTitle);
    if (beforeSection) {
      return beforeSection;
    }
  }

  const documentTitleCandidate = String(documentTitle || "")
    .replace(/\s*[-|]\s*ChatGPT\s*$/i, "")
    .trim();
  if (isGoodTitle(documentTitleCandidate)) {
    return documentTitleCandidate;
  }

  return lines.find(isGoodTitle) ?? "";
}

function trimDeepResearchTitleLine(line) {
  const trimmed = String(line ?? "").trim();
  const sectionMatch = /^(.*?)\s+(執行摘要|發展格局|部署現況|監管與治理|基礎設施與人才|行動建議|結論與資料限制|Executive Summary|Overview|Recommendations)(?:\s|$)/i.exec(trimmed);
  if (sectionMatch?.[1]?.trim()) {
    return sectionMatch[1].trim();
  }
  return trimmed;
}

function extractDeepResearchPreview(text, completionIndex) {
  if (completionIndex < 0) {
    return text.slice(0, 1200);
  }
  return text.slice(completionIndex, completionIndex + 1600);
}

function countMarkdownLikeHeadings(text) {
  const markdownHeadings = text.match(/^#{1,6}\s+\S+/gm)?.length ?? 0;
  const commonReportHeadings = text.match(/(?:^|\n)(執行摘要|發展格局|部署現況|監管與治理|行動建議|結論|Executive Summary|Overview|Recommendations)(?:\n|$)/gi)?.length ?? 0;
  return Math.max(markdownHeadings, commonReportHeadings);
}

function mergeDeepResearchStates(primary = {}, secondary = {}) {
  const reportTitle = chooseDeepResearchReportTitle(
    primary.reportTitle || "",
    secondary.reportTitle || ""
  );

  return {
    ...primary,
    ...secondary,
    present: Boolean(primary.present || secondary.present),
    running: Boolean(primary.running || secondary.running) && !Boolean(primary.completed || secondary.completed),
    completed: Boolean(primary.completed || secondary.completed),
    completionText: primary.completionText || secondary.completionText || "",
    durationText: primary.durationText || secondary.durationText || "",
    citationCount: primary.citationCount ?? secondary.citationCount ?? null,
    searchCount: primary.searchCount ?? secondary.searchCount ?? null,
    reportTitle,
    viewerOpen: Boolean(primary.viewerOpen || secondary.viewerOpen),
    exportAvailable: Boolean(primary.exportAvailable || secondary.exportAvailable),
    copyContentsAvailable: Boolean(primary.copyContentsAvailable || secondary.copyContentsAvailable),
    markdownExportAvailable: Boolean(primary.markdownExportAvailable || secondary.markdownExportAvailable),
    previewText: primary.previewText || secondary.previewText || "",
  };
}

function chooseDeepResearchReportTitle(primaryTitle, secondaryTitle) {
  const primary = trimDeepResearchTitleLine(primaryTitle);
  const secondary = trimDeepResearchTitleLine(secondaryTitle);
  if (isDeepResearchReportTitle(primary)) {
    return primary;
  }
  if (isDeepResearchReportTitle(secondary)) {
    return secondary;
  }
  return primary || secondary || "";
}

function isDeepResearchReportTitle(title) {
  const value = String(title ?? "").trim();
  return value.length >= 4 && value.length <= 160 && /(研究報告|報告|research report|report)$/i.test(value);
}

function deepResearchSignature(deepResearch) {
  if (!deepResearch?.present) {
    return "";
  }

  return [
    deepResearch.running ? "running" : "idle",
    deepResearch.completed ? "completed" : "not-completed",
    deepResearch.completionText,
    deepResearch.reportTitle,
    deepResearch.viewerOpen ? "viewer" : "card",
    deepResearch.markdownExportAvailable ? "markdown-export" : "no-markdown-export",
  ].join("|");
}

function isImageGenerationFeature(feature) {
  return feature === "create-image" || feature === "createImage";
}

function isDeepResearchFeature(feature) {
  return feature === "deep-research" || feature === "deepResearch";
}

function generatedImageArtifacts(artifacts = []) {
  return artifacts.filter((artifact) =>
    artifact?.kind === "image" &&
    typeof artifact.src === "string" &&
    artifact.src.length > 0
  );
}

function imageArtifactSignature(artifacts = []) {
  return generatedImageArtifacts(artifacts)
    .map((artifact) => `${artifact.src}|${artifact.width ?? ""}x${artifact.height ?? ""}`)
    .sort()
    .join("\n");
}

async function persistArtifacts(tab, artifacts = [], { statePath, relaySessionId, conversationUrl }) {
  const imageArtifacts = generatedImageArtifacts(artifacts);
  if (imageArtifacts.length === 0) {
    return artifacts;
  }

  const artifactDir = getArtifactDir({ statePath, relaySessionId, conversationUrl });
  await mkdir(artifactDir, { recursive: true });

  const persisted = [];
  for (let index = 0; index < imageArtifacts.length; index += 1) {
    const artifact = imageArtifacts[index];
    try {
      const saved = await saveImageArtifact(tab, artifact, artifactDir, index + 1);
      persisted.push({ ...artifact, ...saved });
    } catch (error) {
      persisted.push({ ...artifact, saveError: errorMessage(error) });
    }
  }

  const nonImageArtifacts = artifacts.filter((artifact) => !imageArtifacts.includes(artifact));
  return [...persisted, ...nonImageArtifacts];
}

function getArtifactDir({ statePath, relaySessionId, conversationUrl }) {
  const sessionKey = sanitizePathSegment(relaySessionId || getConversationId(conversationUrl) || `relay-${Date.now()}`);
  return path.join(path.dirname(getStatePath(statePath)), "artifacts", sessionKey);
}

async function extractDeepResearchReport(tab, state, context) {
  let currentState = state;
  if (!currentState.deepResearch?.viewerOpen) {
    await ensureDeepResearchViewerOpen(tab, currentState.deepResearch);
    currentState = await readChatStateForFeature(tab, "deep-research");
  }

  const exportResult = await exportDeepResearchMarkdown(tab, currentState.deepResearch, context);
  const validation = await validateDeepResearchMarkdown(exportResult.localPath, currentState.deepResearch);

  if (!validation.ok) {
    throw codedError(
      "DEEP_RESEARCH_REPORT_VALIDATION_FAILED",
      validation.reason,
      { exportResult, validation, deepResearch: currentState.deepResearch }
    );
  }

  const deepResearch = {
    ...currentState.deepResearch,
    reportTitle: validation.reportTitle || currentState.deepResearch.reportTitle,
    exported: true,
    validated: true,
    capture: "chatgpt-export-markdown",
  };

  return {
    text: validation.text,
    state: {
      ...currentState,
      deepResearch,
    },
    deepResearch,
    artifact: {
      kind: "deep-research-report",
      title: deepResearch.reportTitle,
      localPath: exportResult.localPath,
      mimeType: "text/markdown",
      bytes: validation.bytes,
      lineCount: validation.lineCount,
      citationCount: currentState.deepResearch.citationCount,
      searchCount: currentState.deepResearch.searchCount,
      durationText: currentState.deepResearch.durationText,
      capture: "chatgpt-export-markdown",
    },
  };
}

async function ensureDeepResearchViewerOpen(tab, deepResearch = {}) {
  if (deepResearch.viewerOpen) {
    return;
  }

  await clickDeepResearchReportCard(tab, deepResearch);
  await waitForDeepResearchViewer(tab, deepResearch);
}

async function clickDeepResearchReportCard(tab, deepResearch = {}) {
  const title = deepResearch.reportTitle;
  const locators = [];
  if (title) {
    locators.push(tab.playwright.getByText(title, { exact: false }));
  }

  for (const locator of locators) {
    try {
      const count = await safeLocatorCount(locator);
      if (count > 0) {
        const target = typeof locator.last === "function" ? locator.last() : locator;
        await target.click({ timeoutMs: 5000 });
        return;
      }
    } catch {
      // Try the next click strategy.
    }
  }

  if (title) {
    const clickedTitleByDom = await clickVisibleDomNode(tab, new RegExp(escapeRegExp(title), "i"));
    if (clickedTitleByDom) {
      return;
    }
  }

  const clickedCompletionByDom = await clickVisibleDomNode(tab, /Research completed in/i);
  if (clickedCompletionByDom) {
    return;
  }

  const clickedByCoordinates = await clickDeepResearchReportCardByCoordinates(tab, deepResearch);
  if (clickedByCoordinates) {
    return;
  }

  throw codedError(
    "DEEP_RESEARCH_COMPLETED_CARD_NOT_OPENABLE",
    "Deep Research is complete, but the report card could not be opened.",
    { deepResearch }
  );
}

async function clickDeepResearchReportCardByCoordinates(tab, deepResearch = {}) {
  if (!tab.cua || typeof tab.cua.click !== "function") {
    return false;
  }

  const target = await tab.playwright.evaluate(({ reportTitle }) => {
    const main = document.querySelector("main") || document.body;
    const candidates = Array.from(
      main.querySelectorAll("button, a, [role='button'], article, section, div")
    );
    const matches = [];
    for (const element of candidates) {
      const text = (element.innerText || element.textContent || "").trim();
      const matchesText = (
        (reportTitle && text.includes(reportTitle)) ||
        /Research completed in\s+.+?citations\s+.+?searches/i.test(text)
      );
      if (!matchesText) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      if (!rect || rect.width < 8 || rect.height < 8) {
        continue;
      }
      matches.push({
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        area: Math.round(rect.width * rect.height),
        tag: element.tagName.toLowerCase(),
      });
    }
    matches.sort((a, b) => {
      const aInteractive = /^(button|a)$/.test(a.tag) ? 0 : 1;
      const bInteractive = /^(button|a)$/.test(b.tag) ? 0 : 1;
      return aInteractive - bInteractive || a.area - b.area;
    });
    return matches[0] ?? null;
  }, { reportTitle: title }, { timeoutMs: 5000 });

  if (!target) {
    return false;
  }

  await tab.cua.click({ x: target.x, y: target.y });
  return true;
}

async function waitForDeepResearchViewer(tab, deepResearch = {}, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;

  while (Date.now() < deadline) {
    await tab.playwright.waitForTimeout(500);
    lastState = await readChatStateForFeature(tab, "deep-research");
    if (lastState.deepResearch?.viewerOpen) {
      return lastState;
    }
  }

  throw codedError(
    "DEEP_RESEARCH_VIEWER_OPEN_FAILED",
    "Deep Research completed card was found, but the full report viewer did not open.",
    { deepResearch, lastState }
  );
}

async function exportDeepResearchMarkdown(tab, deepResearch = {}, context = {}) {
  const artifactDir = getArtifactDir(context);
  await mkdir(artifactDir, { recursive: true });

  const before = await listRecentDownloads().catch(() => []);
  const clickedAt = Date.now();
  await openDeepResearchExportMenu(tab);
  const downloadPromise = waitForDownload(tab, 15000);
  await clickExportToMarkdown(tab);

  const download = await downloadPromise.catch(() => null);
  const downloadedPath = download
    ? await saveDownloadToArtifact(download, artifactDir, deepResearch).catch(() => null)
    : null;

  if (downloadedPath) {
    return { localPath: downloadedPath, capture: "download-event" };
  }

  const fallbackPath = await findAndCopyMarkdownDownload({
    before,
    clickedAt,
    artifactDir,
    deepResearch,
  });
  if (fallbackPath) {
    return { localPath: fallbackPath, capture: "downloads-folder-fallback" };
  }

  throw codedError(
    "DEEP_RESEARCH_MARKDOWN_DOWNLOAD_TIMEOUT",
    "Export to Markdown was clicked, but no matching Markdown download was observed.",
    { deepResearch }
  );
}

async function openDeepResearchExportMenu(tab) {
  const exportButton = tab.playwright.getByRole("button", { name: "Export" });
  if ((await safeLocatorCount(exportButton)) > 0) {
    const target = typeof exportButton.last === "function" ? exportButton.last() : exportButton;
    await target.click({ timeoutMs: 5000 });
    await tab.playwright.waitForTimeout(400);
    return;
  }

  const clickedByDom = await clickVisibleDomNode(tab, /aria-label=["']Export["']|>\s*Export\s*</i);
  if (clickedByDom) {
    await tab.playwright.waitForTimeout(400);
    return;
  }

  throw codedError(
    "DEEP_RESEARCH_EXPORT_MENU_MISSING",
    "The Deep Research report viewer did not expose an Export button."
  );
}

async function clickExportToMarkdown(tab) {
  const locators = [
    tab.playwright.getByRole("menuitem", { name: "Export to Markdown" }),
    tab.playwright.getByRole("button", { name: "Export to Markdown" }),
    tab.playwright.getByText("Export to Markdown", { exact: true }),
  ];

  for (const locator of locators) {
    const count = await safeLocatorCount(locator);
    if (count > 0) {
      const target = typeof locator.last === "function" ? locator.last() : locator;
      await target.click({ timeoutMs: 5000 });
      return;
    }
  }

  const clickedByDom = await clickVisibleDomNode(tab, /Export to Markdown/i);
  if (clickedByDom) {
    return;
  }

  throw codedError(
    "DEEP_RESEARCH_MARKDOWN_EXPORT_MISSING",
    "The Deep Research export menu did not expose Export to Markdown."
  );
}

async function clickVisibleDomNode(tab, pattern) {
  if (!tab.dom_cua || typeof tab.dom_cua.get_visible_dom !== "function" || typeof tab.dom_cua.click !== "function") {
    return false;
  }

  const visibleDom = await tab.dom_cua.get_visible_dom().catch(() => "");
  const text = typeof visibleDom === "string"
    ? visibleDom
    : JSON.stringify(visibleDom ?? "");
  const nodeId = findVisibleDomNodeId(text, pattern);
  if (!nodeId) {
    return false;
  }

  await tab.dom_cua.click({ node_id: nodeId });
  return true;
}

function findVisibleDomNodeId(visibleDomText, pattern) {
  const lines = String(visibleDomText ?? "").split("\n");
  for (const line of lines) {
    pattern.lastIndex = 0;
    if (!pattern.test(line)) {
      continue;
    }
    const nodeId = /node_id=["']?([^"'\s>]+)/i.exec(line)?.[1];
    if (nodeId) {
      return nodeId;
    }
  }
  return null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitForDownload(tab, timeoutMs) {
  if (typeof tab.playwright.waitForEvent !== "function") {
    return null;
  }
  return await tab.playwright.waitForEvent("download", {
    timeout: timeoutMs,
    timeoutMs,
  });
}

async function saveDownloadToArtifact(download, artifactDir, deepResearch = {}) {
  const suggested = typeof download.suggestedFilename === "function"
    ? await download.suggestedFilename()
    : "";
  const filename = markdownArtifactFilename(deepResearch, suggested);
  const localPath = path.join(artifactDir, filename);

  if (typeof download.saveAs === "function") {
    await download.saveAs(localPath);
    return localPath;
  }

  if (typeof download.path === "function") {
    const sourcePath = await download.path();
    if (sourcePath) {
      await copyFile(sourcePath, localPath);
      return localPath;
    }
  }

  return null;
}

async function listRecentDownloads() {
  const homeDir = globalThis.nodeRepl?.homeDir;
  if (!homeDir) {
    return [];
  }
  const downloadsDir = path.join(homeDir, "Downloads");
  const entries = await readdir(downloadsDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const localPath = path.join(downloadsDir, entry.name);
    const fileStat = await stat(localPath).catch(() => null);
    if (!fileStat) {
      continue;
    }
    files.push({
      name: entry.name,
      path: localPath,
      bytes: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      birthtimeMs: fileStat.birthtimeMs,
      observedAtMs: Math.max(fileStat.mtimeMs, fileStat.birthtimeMs),
    });
  }
  return files;
}

async function findAndCopyMarkdownDownload({ before = [], clickedAt, artifactDir, deepResearch = {} }) {
  const beforePaths = new Set(before.map((file) => file.path));
  const deadline = Date.now() + DEEP_RESEARCH_DOWNLOAD_WINDOW_MS;
  let best = null;

  while (Date.now() < deadline) {
    const after = await listRecentDownloads().catch(() => []);
    const candidates = after
      .filter((file) => isMarkdownFile(file.name))
      .filter((file) =>
        !beforePaths.has(file.path) ||
        file.observedAtMs >= clickedAt - 2000
      )
      .filter((file) => file.observedAtMs >= clickedAt - 2000)
      .sort((a, b) => b.observedAtMs - a.observedAtMs);

    best = candidates.find((file) => markdownDownloadMatches(file.name, deepResearch)) ?? candidates[0] ?? null;
    if (best) {
      const filename = markdownArtifactFilename(deepResearch, best.name);
      const localPath = path.join(artifactDir, filename);
      await copyFile(best.path, localPath);
      return localPath;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return null;
}

function isMarkdownFile(filename) {
  return /\.(md|markdown)$/i.test(filename);
}

function markdownDownloadMatches(filename, deepResearch = {}) {
  const haystack = filename.toLowerCase();
  const titleNeedle = sanitizePathSegment(deepResearch.reportTitle || "")
    .replace(/_/g, "-")
    .toLowerCase();
  return (
    haystack.includes("deep-research") ||
    haystack.includes("report") ||
    (titleNeedle && haystack.includes(titleNeedle.slice(0, 24)))
  );
}

function markdownArtifactFilename(deepResearch = {}, suggestedFilename = "") {
  const ext = path.extname(suggestedFilename);
  const basename = deepResearch.reportTitle
    ? sanitizePathSegment(deepResearch.reportTitle)
    : sanitizePathSegment(path.basename(suggestedFilename, ext) || "deep-research-report");
  return `${basename || "deep-research-report"}.md`;
}

async function validateDeepResearchMarkdown(localPath, deepResearch = {}, options = {}) {
  const text = await readFile(localPath, "utf8");
  const fileStat = await stat(localPath);
  const headingCount = text.match(/^#{1,6}\s+\S+/gm)?.length ?? 0;
  const trimmed = text.trim();
  const minBytes = options.minBytes ?? DEEP_RESEARCH_REPORT_MIN_BYTES;
  const title = deepResearch.reportTitle || "";
  const expectedTitle = isDeepResearchReportTitle(title) ? title : "";
  const markdownTitle = extractMarkdownTitle(text);
  const titleMatches = !expectedTitle || text.includes(expectedTitle);
  const notOnlyUrl = !/^https?:\/\/\S+$/i.test(trimmed);

  if (fileStat.size < minBytes) {
    return {
      ok: false,
      reason: `Deep Research Markdown is too small (${fileStat.size} bytes).`,
      text,
      bytes: fileStat.size,
      lineCount: countLines(text),
      headingCount,
    };
  }

  if (!titleMatches) {
    return {
      ok: false,
      reason: "Deep Research Markdown did not contain the report title.",
      text,
      bytes: fileStat.size,
      lineCount: countLines(text),
      headingCount,
    };
  }

  if (headingCount < 3) {
    return {
      ok: false,
      reason: "Deep Research Markdown did not contain enough section headings.",
      text,
      bytes: fileStat.size,
      lineCount: countLines(text),
      headingCount,
    };
  }

  if (!notOnlyUrl) {
    return {
      ok: false,
      reason: "Deep Research Markdown only contained a URL.",
      text,
      bytes: fileStat.size,
      lineCount: countLines(text),
      headingCount,
    };
  }

  return {
    ok: true,
    text,
    bytes: fileStat.size,
    lineCount: countLines(text),
    headingCount,
    reportTitle: markdownTitle || expectedTitle || title,
  };
}

function countLines(text) {
  return text.length === 0 ? 0 : text.split(/\r?\n/).length;
}

function extractMarkdownTitle(text) {
  const match = /^#\s+(.+?)\s*$/m.exec(String(text ?? ""));
  return match?.[1]?.trim() ?? "";
}

async function saveImageArtifact(tab, artifact, artifactDir, index) {
  try {
    const payload = await readImageArtifactBytes(tab, artifact.src);
    const extension = extensionForMimeType(payload.mimeType);
    const filename = `image-${String(index).padStart(2, "0")}${extension}`;
    const localPath = path.join(artifactDir, filename);
    await writeFile(localPath, Buffer.from(payload.base64, "base64"));
    return {
      localPath,
      mimeType: payload.mimeType,
      bytes: Buffer.byteLength(payload.base64, "base64"),
    };
  } catch (bytesError) {
    try {
      return await bundleImageArtifact(tab, artifact, artifactDir, index, bytesError);
    } catch {
      return screenshotImageArtifact(tab, artifact, artifactDir, index, bytesError);
    }
  }
}

async function bundleImageArtifact(tab, artifact, artifactDir, index, bytesError) {
  if (typeof tab.capabilities?.get !== "function") {
    throw bytesError;
  }
  const pageAssets = await tab.capabilities.get("pageAssets");
  if (!pageAssets || typeof pageAssets.list !== "function" || typeof pageAssets.bundle !== "function") {
    throw bytesError;
  }

  const inventory = await pageAssets.list();
  const asset = inventory.assets?.find((candidate) =>
    candidate.kind === "image" &&
    (
      candidate.url === artifact.src ||
      candidate.url?.includes(artifact.src) ||
      artifact.src?.includes(candidate.url)
    )
  );
  if (!asset) {
    throw new Error(`No pageAssets image matched generated artifact. bytesSave=${errorMessage(bytesError)}`);
  }

  const bundled = await pageAssets.bundle({
    inventoryId: inventory.id,
    assetIds: [asset.id],
  });
  const bundledAsset = bundled.assets?.find((candidate) => candidate.id === asset.id) ?? bundled.assets?.[0];
  if (!bundledAsset?.path) {
    const failureReason = bundled.failures?.map((failure) => failure.reason).join("; ") || "no bundled asset path";
    throw new Error(`pageAssets bundle did not export the image: ${failureReason}`);
  }

  const sourceBytes = await readFile(bundledAsset.path);
  const mimeType = bundledAsset.contentType || "image/png";
  const extension = path.extname(bundledAsset.name || "") || extensionForMimeType(mimeType);
  const filename = `image-${String(index).padStart(2, "0")}${extension}`;
  const localPath = path.join(artifactDir, filename);
  await writeFile(localPath, sourceBytes);
  return {
    localPath,
    mimeType,
    bytes: sourceBytes.length,
    capture: "page-assets",
    originalSaveError: errorMessage(bytesError),
  };
}

async function screenshotImageArtifact(tab, artifact, artifactDir, index, bytesError) {
  if (!Number.isInteger(artifact.imageIndex)) {
    throw new Error(`Image artifact has no stable image index. bytesSave=${errorMessage(bytesError)}`);
  }
  const filename = `image-${String(index).padStart(2, "0")}.png`;
  const localPath = path.join(artifactDir, filename);
  const candidates = tab.playwright.locator(artifact.selector || "main img");
  if (typeof candidates.nth !== "function") {
    throw new Error(`Image locator does not expose nth(). bytesSave=${errorMessage(bytesError)}`);
  }
  const locator = candidates.nth(artifact.imageIndex);
  if (typeof locator.screenshot === "function") {
    await locator.screenshot({ path: localPath });
  } else if (
    typeof tab.playwright.screenshot === "function" &&
    Number.isFinite(artifact.x) &&
    Number.isFinite(artifact.y) &&
    Number.isFinite(artifact.displayWidth) &&
    Number.isFinite(artifact.displayHeight)
  ) {
    await tab.playwright.screenshot({
      path: localPath,
      clip: {
        x: Math.max(0, artifact.x),
        y: Math.max(0, artifact.y),
        width: Math.max(1, artifact.displayWidth),
        height: Math.max(1, artifact.displayHeight),
      },
    });
  } else {
    throw new Error(`Image screenshot APIs are unavailable. bytesSave=${errorMessage(bytesError)}`);
  }
  const fileStat = await stat(localPath);
  return {
    localPath,
    mimeType: "image/png",
    bytes: fileStat.size,
    capture: "element-screenshot",
    originalSaveError: errorMessage(bytesError),
  };
}

async function readImageArtifactBytes(tab, src) {
  const dataUrl = parseDataUrl(src);
  if (dataUrl) {
    return dataUrl;
  }

  try {
    return await tab.playwright.evaluate(async ({ src: imageSrc }) => {
      if (typeof fetch !== "function") {
        throw new Error("Browser context does not expose fetch().");
      }
      const response = await fetch(imageSrc);
      if (!response.ok) {
        throw new Error(`Image fetch failed with HTTP ${response.status}.`);
      }
      const blob = await response.blob();
      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let index = 0; index < bytes.length; index += 1) {
        binary += String.fromCharCode(bytes[index]);
      }
      return {
        mimeType: blob.type || response.headers.get("content-type") || "image/png",
        base64: btoa(binary),
      };
    }, { src }, { timeoutMs: 30000 });
  } catch (browserFetchError) {
    try {
      return await readImageArtifactFromCanvas(tab, src);
    } catch (canvasError) {
      try {
        return await fetchImageArtifactFromNode(src, browserFetchError);
      } catch (nodeFetchError) {
        throw new Error(
          `Could not save image artifact. browserFetch=${errorMessage(browserFetchError)}; canvas=${errorMessage(canvasError)}; nodeFetch=${errorMessage(nodeFetchError)}`
        );
      }
    }
  }
}

async function readImageArtifactFromCanvas(tab, src) {
  return await tab.playwright.evaluate(({ src: imageSrc }) => {
    const images = Array.from(document.querySelectorAll("img"));
    const image = images.find((candidate) =>
      candidate.currentSrc === imageSrc ||
      candidate.src === imageSrc ||
      candidate.getAttribute("src") === imageSrc
    );
    if (!image) {
      throw new Error("Generated image element is no longer visible.");
    }
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) {
      throw new Error("Generated image has no drawable dimensions.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas 2D context is unavailable.");
    }
    context.drawImage(image, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/png");
    const marker = "base64,";
    const markerIndex = dataUrl.indexOf(marker);
    if (markerIndex === -1) {
      throw new Error("Canvas export did not return a base64 data URL.");
    }
    return {
      mimeType: "image/png",
      base64: dataUrl.slice(markerIndex + marker.length),
    };
  }, { src }, { timeoutMs: 30000 });
}

async function fetchImageArtifactFromNode(src, browserFetchError) {
  if (typeof fetch !== "function") {
    throw browserFetchError;
  }
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`Image fetch failed with HTTP ${response.status}.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    mimeType: response.headers.get("content-type") || "image/png",
    base64: bytes.toString("base64"),
  };
}

function parseDataUrl(src) {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src);
  if (!match) {
    return null;
  }
  const mimeType = match[1] || "image/png";
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || "";
  return {
    mimeType,
    base64: isBase64
      ? payload
      : Buffer.from(decodeURIComponent(payload), "utf8").toString("base64"),
  };
}

function extensionForMimeType(mimeType = "") {
  if (/jpe?g/i.test(mimeType)) return ".jpg";
  if (/webp/i.test(mimeType)) return ".webp";
  if (/gif/i.test(mimeType)) return ".gif";
  return ".png";
}

function sanitizePathSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "session";
}

function markdownForArtifacts(artifacts = []) {
  return generatedImageArtifacts(artifacts)
    .filter((artifact) => typeof artifact.localPath === "string" && artifact.localPath.length > 0)
    .map((artifact, index) => `![generated image ${index + 1}](${artifact.localPath})`);
}

function getContentAssistantMessages(messages) {
  return messages.filter(
    (message) =>
      message.role === "assistant" &&
      message.text.trim() &&
      !isAssistantStatusText(message.text)
  );
}

function normalizeMessageText(text) {
  return text.trim().replace(/\n{3,}/g, "\n\n");
}

function resolveIntelligenceRequest({
  prompt = "",
  model,
  mode,
  effort,
} = {}) {
  const parsed = parseIntelligenceRequestFromPrompt(prompt);
  const resolved = {
    ...DEFAULT_INTELLIGENCE_REQUEST,
    ...parsed,
  };

  if (model !== undefined && model !== null && String(model).trim()) {
    resolved.model = normalizeIntelligenceModel(model);
    resolved.explicit = true;
    resolved.source = "options";
  }

  if (mode !== undefined && mode !== null && String(mode).trim()) {
    resolved.mode = normalizeIntelligenceMode(mode);
    resolved.explicit = true;
    resolved.source = "options";
  }

  if (effort !== undefined && effort !== null && String(effort).trim()) {
    resolved.effort = normalizeReasoningEffort(effort);
    resolved.explicit = true;
    resolved.source = "options";
  }

  if (resolved.mode === "instant") {
    resolved.effort = null;
  }

  validateIntelligenceRequest(resolved);
  return resolved;
}

function parseIntelligenceRequestFromPrompt(prompt = "") {
  const text = stripRelayInvocationText(String(prompt ?? ""));
  const lower = text.toLowerCase();
  const parsed = {};

  const modelMatch = lower.match(/\b(?:gpt[\s-]*)?(5\.5|5\.4|5\.3|5\.2|4\.5|o3)\b/);
  if (modelMatch) {
    parsed.model = normalizeIntelligenceModel(modelMatch[1]);
    parsed.explicit = true;
    parsed.source = "prompt";
  } else if (/\blatest\b|最新/i.test(text)) {
    parsed.model = LATEST_INTELLIGENCE_MODEL;
    parsed.explicit = true;
    parsed.source = "prompt";
  }

  if (/\binstant\b|即時|快速/i.test(text)) {
    parsed.mode = "instant";
    parsed.explicit = true;
    parsed.source = "prompt";
  }

  if (/\bthinking\b|\bthink\b|思考|推理/i.test(text)) {
    parsed.mode = "thinking";
    parsed.explicit = true;
    parsed.source = "prompt";
  }

  if (/\bpro\b|專業|研究級/i.test(text)) {
    parsed.mode = "pro";
    parsed.explicit = true;
    parsed.source = "prompt";
  }

  const effort = extractReasoningEffort(text);
  if (effort) {
    parsed.effort = effort;
    parsed.explicit = true;
    parsed.source = "prompt";
  }

  if (/\bextended\s+pro\b|\bpro\s+extended\b|extend(ed)?\s+pro|pro\s+extend(ed)?/i.test(text)) {
    parsed.mode = "pro";
    parsed.effort = "extended";
    parsed.explicit = true;
    parsed.source = "prompt";
  }

  return parsed;
}

function stripRelayInvocationText(text = "") {
  return String(text ?? "")
    .replace(/(?:@?gpt\s+relay|@?gpt[\s-]*5\.5\s+pro\s+relay|GPT 5\.5 Pro Relay)+/gi, " ")
    .replace(/\s+/g, " ");
}

function validateIntelligenceRequest(request = DEFAULT_INTELLIGENCE_REQUEST) {
  if (!request.effort) {
    return;
  }

  if (request.mode === "instant") {
    throw codedError(
      "REASONING_EFFORT_UNSUPPORTED_FOR_MODE",
      "Instant mode does not expose a reasoning effort selector."
    );
  }

  if (request.mode === "pro" && !PRO_REASONING_EFFORTS.has(request.effort)) {
    throw codedError(
      "REASONING_EFFORT_UNSUPPORTED_FOR_MODE",
      `Pro mode only supports Standard and Extended effort. Requested: ${REASONING_EFFORT_LABELS[request.effort] ?? request.effort}.`
    );
  }

  if (request.mode === "thinking" && !THINKING_REASONING_EFFORTS.has(request.effort)) {
    throw codedError(
      "REASONING_EFFORT_UNSUPPORTED_FOR_MODE",
      `Thinking mode supports Light, Standard, Extended, and Heavy effort. Requested: ${REASONING_EFFORT_LABELS[request.effort] ?? request.effort}.`
    );
  }
}

function extractReasoningEffort(text = "") {
  const lower = String(text ?? "").toLowerCase();

  if (/\b(light|lite|low)\b|輕量|輕度|低強度/i.test(lower)) {
    return "light";
  }
  if (/\b(standard|normal|medium)\b|標準|普通|一般|中等/i.test(lower)) {
    return "standard";
  }
  if (/\b(extended|extend|high)\b|延伸|擴展|高強度/i.test(lower)) {
    return "extended";
  }
  if (/\b(heavy|maximum|max)\b|重度|最強|最高/i.test(lower)) {
    return "heavy";
  }

  return null;
}

function normalizeIntelligenceModel(model) {
  const value = String(model ?? "")
    .trim()
    .toLowerCase()
    .replace(/^gpt[\s-]*/, "");
  const normalized = value === "latest" || value === "最新"
    ? LATEST_INTELLIGENCE_MODEL
    : value;

  if (!SUPPORTED_INTELLIGENCE_MODELS.has(normalized)) {
    throw codedError(
      "INTELLIGENCE_MODEL_UNSUPPORTED",
      `Unsupported ChatGPT model '${model}'. Supported models: ${[...SUPPORTED_INTELLIGENCE_MODELS].join(", ")}.`
    );
  }

  return normalized;
}

function normalizeIntelligenceMode(mode) {
  const value = String(mode ?? "").trim().toLowerCase();

  if (/^instant$|即時|快速/.test(value)) {
    return "instant";
  }
  if (/^thinking$|^think$|思考|推理/.test(value)) {
    return "thinking";
  }
  if (/^pro$|extended pro|pro extended|專業|研究級/.test(value)) {
    return "pro";
  }

  if (SUPPORTED_INTELLIGENCE_MODES.has(value)) {
    return value;
  }

  throw codedError(
    "INTELLIGENCE_MODE_UNSUPPORTED",
    `Unsupported ChatGPT reasoning mode '${mode}'. Supported modes: instant, thinking, pro.`
  );
}

function normalizeReasoningEffort(effort) {
  const extracted = extractReasoningEffort(effort);
  if (extracted) {
    return extracted;
  }

  const value = String(effort ?? "").trim().toLowerCase();
  if (SUPPORTED_REASONING_EFFORTS.has(value)) {
    return value;
  }

  throw codedError(
    "REASONING_EFFORT_UNSUPPORTED",
    `Unsupported ChatGPT reasoning effort '${effort}'. Supported efforts: light, standard, extended, heavy.`
  );
}

function formatIntelligenceLabel(request = DEFAULT_INTELLIGENCE_REQUEST) {
  if (request.label && !request.model && !request.mode && !request.effort) {
    return request.label;
  }

  if (!request.model && !request.mode && !request.effort) {
    return "Current ChatGPT selection";
  }

  const modeLabel = INTELLIGENCE_MODE_LABELS[request.mode] ?? request.mode;
  const effortLabel = REASONING_EFFORT_LABELS[request.effort] ?? request.effort;
  const parts = [request.model, modeLabel, request.mode === "instant" ? null : effortLabel]
    .filter(Boolean);

  if (parts.length > 0) {
    return parts.join(" ");
  }

  return "Current ChatGPT selection";
}

function isAssistantStatusText(text) {
  const normalized = text.trim().replace(/\s+/g, " ");
  return (
    normalized === "Pro thinking" ||
    normalized === "Thinking" ||
    normalized === "Extended Pro" ||
    normalized === "Searching" ||
    normalized === "Searching the web" ||
    /^Analyzing images?$/i.test(normalized) ||
    /^Processing images?$/i.test(normalized) ||
    /^Reading images?$/i.test(normalized) ||
    /^Thought for \d+s$/.test(normalized)
  );
}

async function readCompactPageState(tab) {
  return await tab.playwright.evaluate(() => {
    const text = (document.body?.innerText || document.body?.textContent || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 2000);

    return {
      title: document.title,
      url: location.href,
      text,
    };
  }, undefined, { timeoutMs: 5000 });
}

async function finalizeRelayTab(browser, tab, keepTab) {
  if (!browser?.tabs?.finalize) {
    return;
  }

  try {
    if (keepTab && tab) {
      await browser.tabs.finalize({
        keep: [{ tab, status: "handoff" }],
      });
      return;
    }

    await browser.tabs.finalize({});
  } catch (error) {
    if (isNativePipeClosedError(error)) {
      return;
    }
    throw error;
  }
}

async function findStoredSession({ sessionId, query, statePath }) {
  const store = await loadSessionStore(statePath);
  const matches = filterSessions(store.sessions, query);

  if (!sessionId) {
    return matches[0] ?? null;
  }

  const needle = sessionId.toLowerCase();
  return (
    matches.find((session) =>
      [
        session.relaySessionId,
        session.conversationId,
        session.conversationUrl,
        session.title,
      ]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(needle))
    ) ?? null
  );
}

function filterSessions(sessions, query = "") {
  const needle = query.trim().toLowerCase();
  const sorted = [...sessions].sort((a, b) =>
    String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""))
  );

  if (!needle) {
    return sorted;
  }

  return sorted.filter((session) =>
    [
      session.title,
      session.summary,
      session.relaySessionId,
      session.conversationId,
      session.conversationUrl,
      ...(session.keywords ?? []),
      ...(session.tags ?? []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(needle)
  );
}

async function upsertSessionRecord(input) {
  const statePath = getStatePath(input.statePath);
  try {
    return await upsertSessionRecordAtPath(statePath, input);
  } catch (error) {
    if (!isWritePermissionError(error)) {
      throw error;
    }

    const fallbackPath = getFallbackStatePath();
    const fallbackRecord = await upsertSessionRecordAtPath(fallbackPath, input);
    fallbackRecord.stateWarning = `Preferred session store was not writable; using ${fallbackPath}.`;
    fallbackRecord.statePath = fallbackPath;
    globalThis.__gpt55RelayStatePath = fallbackPath;
    return fallbackRecord;
  }
}

async function upsertSessionRecordAtPath(statePath, input) {
  const store = await loadSessionStore(statePath);
  const now = new Date().toISOString();
  const conversationId = getConversationId(input.conversationUrl);
  const relaySessionId =
    input.relaySessionId || conversationId || `relay-${Date.now()}`;

  const existingIndex = store.sessions.findIndex(
    (session) =>
      session.relaySessionId === relaySessionId ||
      (conversationId && session.conversationId === conversationId)
  );
  const existing = existingIndex >= 0 ? store.sessions[existingIndex] : {};
  const mergedMessages = input.messages?.length
    ? input.messages
    : existing.messages ?? [];

  const next = {
    ...existing,
    relaySessionId: existing.relaySessionId ?? relaySessionId,
    conversationId: conversationId ?? existing.conversationId,
    conversationUrl: input.conversationUrl ?? existing.conversationUrl,
    title: input.title ?? existing.title ?? "ChatGPT",
    mode: input.mode ?? existing.mode ?? "Extended Pro",
    intelligence: input.intelligence ?? existing.intelligence,
    status: input.status ?? existing.status ?? "complete",
    feature: input.feature ?? existing.feature,
    appName: input.appName ?? existing.appName,
    projectName: input.projectName ?? existing.projectName,
    attachmentSummary:
      input.attachmentSummary ?? existing.attachmentSummary ?? [],
    artifacts: input.artifacts ?? existing.artifacts ?? [],
    deepResearch: input.deepResearch ?? existing.deepResearch,
    tags: dedupe([...(existing.tags ?? []), ...(input.tags ?? [])]),
    messages: mergedMessages,
    summary: summarizeMessages(mergedMessages),
    keywords: extractKeywords(mergedMessages),
    createdAt: existing.createdAt ?? now,
    updatedAt: now,
    statePath,
  };

  if (existingIndex >= 0) {
    store.sessions[existingIndex] = next;
  } else {
    store.sessions.push(next);
  }

  await saveSessionStore(statePath, store);
  return next;
}

async function loadSessionStore(statePath) {
  const resolvedPath = getStatePath(statePath);
  const primary = await readSessionStoreAtPath(resolvedPath);
  if (primary) {
    return primary;
  }

  if (!statePath) {
    const fallbackPath = getFallbackStatePathIfAvailable();
    if (fallbackPath && fallbackPath !== resolvedPath) {
      const fallback = await readSessionStoreAtPath(fallbackPath);
      if (fallback) {
        globalThis.__gpt55RelayStatePath = fallbackPath;
        return fallback;
      }
    }
  }

  return {
    version: 1,
    sessions: [],
  };
}

async function readSessionStoreAtPath(resolvedPath) {
  try {
    const raw = await readFile(resolvedPath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.sessions)) {
      return parsed;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw codedError("SESSION_STORE_READ_FAILED", "Could not read session store.", {
        cause: error,
      });
    }
  }

  return null;
}

async function saveSessionStore(statePath, store) {
  const resolvedPath = getStatePath(statePath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function getStatePath(statePath) {
  if (statePath) {
    return statePath;
  }

  if (globalThis.__gpt55RelayStatePath) {
    return globalThis.__gpt55RelayStatePath;
  }

  const homeDir = globalThis.nodeRepl?.homeDir;
  if (!homeDir) {
    return getFallbackStatePath();
  }

  return path.join(
    homeDir,
    ".codex",
    "gpt-relay",
    "sessions.json"
  );
}

function getFallbackStatePath() {
  const tmpDir = globalThis.nodeRepl?.tmpDir;
  if (!tmpDir) {
    throw codedError(
      "SESSION_STORE_PATH_MISSING",
      "No session store path was provided and the Node runtime has no writable temp directory."
    );
  }

  return path.join(tmpDir, "gpt-relay", "sessions.json");
}

function getFallbackStatePathIfAvailable() {
  try {
    return getFallbackStatePath();
  } catch {
    return null;
  }
}

function isWritePermissionError(error) {
  const code = error?.cause?.code ?? error?.code;
  return ["EPERM", "EACCES", "EROFS"].includes(code);
}

function getConversationId(conversationUrl) {
  if (!conversationUrl) {
    return null;
  }

  const match = conversationUrl.match(/\/c\/([^/?#]+)/);
  return match?.[1] ?? null;
}

function summarizeMessages(messages) {
  const firstUser = messages.find((message) => message.role === "user")?.text ?? "";
  const lastAssistant =
    [...messages].reverse().find((message) => message.role === "assistant")?.text ??
    "";

  return trimForSummary(
    [firstUser, lastAssistant].filter(Boolean).join(" -> ")
  );
}

function extractKeywords(messages) {
  const text = messages
    .map((message) => message.text)
    .join(" ")
    .replace(/\s+/g, " ");
  const tokens = text.match(/[\p{Script=Han}]{2,}|[A-Za-z0-9][A-Za-z0-9_-]{2,}/gu) ?? [];
  return dedupe(tokens.map((token) => token.toLowerCase())).slice(0, 24);
}

function trimForSummary(text) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 260 ? `${clean.slice(0, 257)}...` : clean;
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

function publicSession(session) {
  return {
    relaySessionId: session.relaySessionId,
    conversationId: session.conversationId,
    conversationUrl: session.conversationUrl,
    title: session.title,
    summary: session.summary,
    keywords: session.keywords,
    status: session.status,
    mode: session.mode,
    intelligence: session.intelligence,
    feature: session.feature,
    appName: session.appName,
    projectName: session.projectName,
    attachmentSummary: session.attachmentSummary,
    artifacts: session.artifacts,
    deepResearch: session.deepResearch,
    statePath: session.statePath,
    stateWarning: session.stateWarning,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function formatFinalResponseText({ assistantText = "", conversationUrl = "" } = {}) {
  const text = String(assistantText ?? "").trimEnd();
  const url = String(conversationUrl ?? "").trim();
  const linkLine = url ? `Conversation URL: ${url}` : "Conversation URL:";

  return text ? `${text}\n\n${linkLine}` : linkLine;
}

function formatFinalDeliveryText({
  assistantText = "",
  reportMarkdown = "",
  conversationUrl = "",
  artifacts = [],
  imageMarkdown,
} = {}) {
  const assistant = String(assistantText ?? "");
  const report = String(reportMarkdown ?? "");
  const text = (assistant.trim() ? assistant : report).trimEnd();
  const imageLines = Array.isArray(imageMarkdown)
    ? imageMarkdown.filter((line) => typeof line === "string" && line.trim())
    : markdownForArtifacts(artifacts);
  const artifactLines = artifactDeliveryLines(artifacts);
  const url = String(conversationUrl ?? "").trim();
  const linkLine = url ? `Conversation URL: ${url}` : "Conversation URL:";
  const parts = [];

  if (text) {
    parts.push(text);
  }
  if (imageLines.length > 0) {
    parts.push(imageLines.join("\n\n"));
  }
  if (artifactLines.length > 0) {
    parts.push(`Artifacts:\n${artifactLines.join("\n")}`);
  }
  parts.push(linkLine);

  return parts.join("\n\n");
}

function artifactDeliveryLines(artifacts = []) {
  const imageArtifacts = new Set(generatedImageArtifacts(artifacts));
  return artifacts
    .filter((artifact) => artifact && !imageArtifacts.has(artifact))
    .map((artifact, index) => artifactDeliveryLine(artifact, index))
    .filter(Boolean);
}

function artifactDeliveryLine(artifact, index) {
  const target = artifact.localPath || artifact.href || artifact.url || artifact.downloadUrl;
  if (typeof target !== "string" || !target.trim() || target.startsWith("data:")) {
    return "";
  }

  const rawLabel = artifact.title || artifact.name || artifact.kind || `artifact ${index + 1}`;
  const label = String(rawLabel).replace(/\s+/g, " ").trim();
  return `- ${label}: ${target.trim()}`;
}

function verbatimFinalResponse({
  status = "",
  assistantText = "",
  reportMarkdown = "",
  conversationUrl = "",
  artifacts = [],
  imageMarkdown,
} = {}) {
  const finalResponseText = formatFinalResponseText({ assistantText, conversationUrl });
  const finalDeliveryText = formatFinalDeliveryText({
    assistantText,
    reportMarkdown,
    conversationUrl,
    artifacts,
    imageMarkdown,
  });
  const mustReturnFinalDelivery =
    status === "complete" && finalDeliveryText.trim().length > 0;

  return {
    finalResponseText,
    finalDeliveryText,
    mustReturnFinalDelivery,
    finalDeliveryField: "finalDeliveryText",
    mustReturnVerbatim: mustReturnFinalDelivery,
    verbatimField: "finalDeliveryText",
    finalOutputContract: {
      kind: "complete-relay-delivery",
      appliesWhen: 'status is "complete" and finalDeliveryText is non-empty',
      instruction:
        "Return finalDeliveryText exactly as the final user-facing answer. It includes the complete assistant text, generated image Markdown, returned artifact paths, and the conversation URL. Do not summarize, rewrite, omit, add a preface, or wrap it in another format.",
    },
  };
}

export const __testing = {
  prepareAttachment,
  uploadFailedError,
  isAssistantStatusText,
  isResponseCompleteSnapshot,
  generatedImageArtifacts,
  imageArtifactSignature,
  parseDataUrl,
  markdownForArtifacts,
  parseDeepResearchState,
  deepResearchSignature,
  mergeDeepResearchStates,
  findVisibleDomNodeId,
  validateDeepResearchMarkdown,
  formatFinalResponseText,
  formatFinalDeliveryText,
  artifactDeliveryLines,
  verbatimFinalResponse,
  attachmentSignalSignature,
  isAttachmentUploadBusySignal,
  resolveIntelligenceRequest,
  parseIntelligenceRequestFromPrompt,
  formatIntelligenceLabel,
};

function codedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}
