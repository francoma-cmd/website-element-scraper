const path = require("path");
const fs = require("fs/promises");
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { chromium } = require("playwright");

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/122.0 Safari/537.36";

const MAX_REDIRECTS = 10;
const DEFAULT_CHALLENGE_STATUS_CODES = [403, 429, 503];
const DEFAULT_CHALLENGE_SIGNALS = [
  "cf-chl",
  "cloudflare",
  "captcha",
  "verify you are human",
  "access denied",
  "attention required",
  "bot challenge",
  "__cf_bm",
  "perimeterx",
  "incapsula",
  "ddos-guard"
];

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    title: "Website Element Scraper",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(() => {
  app.setName("Website Element Scraper");
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function truncate(text, max = 300) {
  const value = (text || "").toString();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function listFromUnknown(input) {
  if (Array.isArray(input)) {
    return input
      .map((value) => (value ?? "").toString().trim())
      .filter(Boolean);
  }
  if (typeof input === "string") {
    return input
      .split(/[\r\n,]+/)
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return [];
}

function parseStatusCodeList(input, fallback) {
  const source = listFromUnknown(input);
  const values = source
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value) && value >= 100 && value <= 599);
  if (values.length) {
    return Array.from(new Set(values));
  }
  return Array.isArray(fallback) ? fallback.slice() : [];
}

function parseKeywordList(input, fallback) {
  const source = listFromUnknown(input);
  const values = source
    .map((value) => value.toLowerCase())
    .filter(Boolean);
  if (values.length) {
    return Array.from(new Set(values));
  }
  return Array.isArray(fallback) ? fallback.slice() : [];
}

function parseProxyEntry(raw) {
  const text = (raw ?? "").toString().trim();
  if (!text || text.startsWith("#")) return null;

  if (typeof raw === "object" && raw?.server) {
    const server = String(raw.server || "").trim();
    if (!server) return null;
    return {
      server,
      username: String(raw.username || "").trim(),
      password: String(raw.password || "").trim(),
      label: server
    };
  }

  let value = text;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `http://${value}`;
  }

  try {
    const parsed = new URL(value);
    if (!parsed.hostname) return null;

    const server = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
    const username = parsed.username ? decodeURIComponent(parsed.username) : "";
    const password = parsed.password ? decodeURIComponent(parsed.password) : "";
    const label = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    return { server, username, password, label };
  } catch {
    return null;
  }
}

function normalizeProxyList(input) {
  const list = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(/\r?\n/)
      : [];
  const proxies = [];
  list.forEach((entry) => {
    const parsed = parseProxyEntry(entry);
    if (parsed) proxies.push(parsed);
  });
  return proxies;
}

function getDomainKey(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "__invalid__";
  }
}

function ensureDomainState(domainStateMap, url) {
  const domain = getDomainKey(url);
  if (!domainStateMap.has(domain)) {
    domainStateMap.set(domain, {
      domain,
      challengeHits: 0,
      proxyEngaged: false,
      nextProxyIndex: 0,
      activeProxyIndex: -1
    });
  }
  return domainStateMap.get(domain);
}

function pickProxyForDomain(domainState, proxyOptions) {
  const list = Array.isArray(proxyOptions?.proxies) ? proxyOptions.proxies : [];
  if (!list.length) return null;

  if (
    proxyOptions?.stickyPerDomain
    && Number.isInteger(domainState.activeProxyIndex)
    && domainState.activeProxyIndex >= 0
    && domainState.activeProxyIndex < list.length
  ) {
    return list[domainState.activeProxyIndex];
  }

  const index = domainState.nextProxyIndex % list.length;
  domainState.nextProxyIndex = (index + 1) % list.length;
  if (proxyOptions?.stickyPerDomain) {
    domainState.activeProxyIndex = index;
  }
  return list[index];
}

function rotateProxyForDomain(domainState, proxyOptions) {
  if (!proxyOptions?.stickyPerDomain) return;
  domainState.activeProxyIndex = -1;
}

function sanitizeFileSegment(value) {
  return (value || "")
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

function estimateRemainingMs(startedAt, completed, total) {
  if (!completed) return 0;
  const elapsed = Date.now() - startedAt;
  const avg = elapsed / completed;
  return Math.max(0, Math.round(avg * (total - completed)));
}

function buildRedirectChain(response) {
  if (!response) return [];
  const chain = [];
  let req = response.request();
  const seen = new Set();
  while (req) {
    const key = `${req.method()}::${req.url()}`;
    if (seen.has(key)) break;
    seen.add(key);
    const redirectedFrom = req.redirectedFrom();
    if (!redirectedFrom) break;
    chain.unshift(redirectedFrom.url());
    req = redirectedFrom;
  }
  return chain;
}

function parseCookieHeaderFromText(headerValue) {
  if (!headerValue || typeof headerValue !== "string") return [];
  return headerValue
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf("=");
      if (idx <= 0) return null;
      return {
        name: entry.slice(0, idx).trim(),
        value: entry.slice(idx + 1).trim()
      };
    })
    .filter(Boolean);
}

function normalizeHeaders(input) {
  if (!input || typeof input !== "object") return {};
  const normalized = {};
  Object.entries(input).forEach(([key, value]) => {
    if (!key) return;
    const k = key.toString().trim();
    if (!k) return;
    normalized[k.toLowerCase()] = String(value ?? "").trim();
  });
  if (!normalized["user-agent"]) {
    normalized["user-agent"] = DEFAULT_USER_AGENT;
  }
  return normalized;
}

function normalizeCookies(inputCookies, fallbackOrigins = []) {
  const cookies = [];
  const list = Array.isArray(inputCookies) ? inputCookies : [];
  list.forEach((cookie) => {
    if (!cookie || typeof cookie !== "object") return;
    const name = (cookie.name || "").toString().trim();
    if (!name) return;
    const value = (cookie.value || "").toString();
    const normalized = {
      name,
      value,
      path: cookie.path || "/"
    };
    if (cookie.url) {
      normalized.url = cookie.url;
    } else if (cookie.domain) {
      normalized.domain = cookie.domain;
    }
    if (cookie.secure) normalized.secure = true;
    if (cookie.httpOnly) normalized.httpOnly = true;
    if (cookie.sameSite) normalized.sameSite = cookie.sameSite;
    if (cookie.expires && Number.isFinite(Number(cookie.expires))) {
      normalized.expires = Number(cookie.expires);
    }
    cookies.push(normalized);
  });

  if (!cookies.length && fallbackOrigins.length) {
    return [];
  }

  const withoutScope = cookies.filter((cookie) => !cookie.url && !cookie.domain);
  const withScope = cookies.filter((cookie) => cookie.url || cookie.domain);

  if (!withoutScope.length || !fallbackOrigins.length) {
    return cookies;
  }

  const expanded = [];
  withScope.forEach((cookie) => expanded.push(cookie));
  withoutScope.forEach((cookie) => {
    fallbackOrigins.forEach((origin) => {
      expanded.push({ ...cookie, url: origin });
    });
  });
  return expanded;
}

function cookiesForUrl(cookies, urlString) {
  const result = [];
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return result;
  }
  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname || "/";
  const secure = parsed.protocol === "https:";

  (Array.isArray(cookies) ? cookies : []).forEach((cookie) => {
    if (!cookie?.name) return;
    if (cookie.url) {
      try {
        const target = new URL(cookie.url);
        if (target.origin !== parsed.origin) return;
      } catch {
        return;
      }
    }
    if (cookie.domain) {
      const domain = cookie.domain.replace(/^\./, "").toLowerCase();
      if (!(host === domain || host.endsWith(`.${domain}`))) return;
    }
    if (cookie.path && !pathname.startsWith(cookie.path)) return;
    if (cookie.secure && !secure) return;
    result.push(`${cookie.name}=${cookie.value || ""}`);
  });

  return result;
}

async function fetchWithMeta(
  url,
  { headers = {}, timeoutMs = 30000, signal, maxRedirects = MAX_REDIRECTS } = {}
) {
  let currentUrl = url;
  const redirectChain = [];
  for (let attempt = 0; attempt <= maxRedirects; attempt += 1) {
    if (signal?.aborted) {
      const err = new Error("Aborted");
      err.reasonCode = "ABORTED";
      throw err;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error("Request timed out"));
    }, timeoutMs);

    const mergedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;

    let res;
    try {
      res = await fetch(currentUrl, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: mergedSignal
      });
    } catch (err) {
      clearTimeout(timeout);
      if (signal?.aborted || err?.name === "AbortError") {
        const abortedError = new Error("Aborted");
        abortedError.reasonCode = signal?.aborted ? "ABORTED" : "TIMEOUT";
        throw abortedError;
      }
      throw err;
    }

    clearTimeout(timeout);

    const status = res.status;
    const location = res.headers.get("location");
    if (status >= 300 && status < 400 && location) {
      const nextUrl = new URL(location, currentUrl).toString();
      redirectChain.push(nextUrl);
      currentUrl = nextUrl;
      continue;
    }

    const html = await res.text();
    return {
      ok: res.ok,
      status,
      html,
      finalUrl: currentUrl,
      redirectChain
    };
  }

  const err = new Error("Too many redirects");
  err.reasonCode = "REDIRECT_LIMIT";
  throw err;
}

function reasonFromError(error) {
  if (!error) return "UNKNOWN";
  if (error.reasonCode) return error.reasonCode;
  const message = (error.message || "").toLowerCase();
  if (message.includes("aborted")) return "ABORTED";
  if (message.includes("timed out") || message.includes("timeout")) return "TIMEOUT";
  if (message.includes("http")) return "HTTP_ERROR";
  if (message.includes("net::") || message.includes("econn") || message.includes("enotfound")) {
    return "NETWORK_ERROR";
  }
  if (message.includes("selector")) return "SELECTOR_TIMEOUT";
  return "SCRAPE_ERROR";
}

function detectBotChallenge(result, options = {}) {
  const botGuard = options.botGuard || {};
  if (!botGuard.enabled) return null;

  const status = Number(result?.status);
  if (Number.isFinite(status) && botGuard.challengeStatusCodes.includes(status)) {
    return `status:${status}`;
  }

  const finalUrl = (result?.finalUrl || "").toLowerCase();
  if (
    finalUrl.includes("/cdn-cgi/challenge")
    || finalUrl.includes("cf_chl")
    || finalUrl.includes("captcha")
    || finalUrl.includes("/challenge")
  ) {
    return "url-challenge-pattern";
  }

  const html = (result?.html || "").toLowerCase();
  if (!html) return null;
  const scanned = html.slice(0, botGuard.maxBodyScanChars || 50000);
  const hit = botGuard.challengeSignals.find((signal) => signal && scanned.includes(signal));
  return hit || null;
}

function shouldRetry(reasonCode, statusCode) {
  if (["ABORTED"].includes(reasonCode)) return false;
  if (reasonCode === "BOT_CHALLENGE") return true;
  if (["TIMEOUT", "NETWORK_ERROR", "REDIRECT_LIMIT"].includes(reasonCode)) return true;
  if (reasonCode === "HTTP_ERROR") {
    if (!statusCode) return true;
    if (statusCode >= 500 || statusCode === 429 || statusCode === 408) return true;
    return false;
  }
  return true;
}

function buildBackoffMs(attemptIndex, baseMs) {
  const factor = 2 ** Math.max(0, attemptIndex - 1);
  const jitter = Math.round(Math.random() * Math.max(80, baseMs * 0.15));
  return Math.round(baseMs * factor + jitter);
}

async function ensureRunArtifactDir(artifactOptions = {}) {
  if (!artifactOptions.enabled) return null;
  const root = artifactOptions.outputDir && artifactOptions.outputDir.trim()
    ? artifactOptions.outputDir.trim()
    : path.join(app.getPath("documents"), "Website Element Scraper", "failure-artifacts");

  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  const runDir = path.join(root, `run-${stamp}`);
  await fs.mkdir(runDir, { recursive: true });
  return runDir;
}

async function persistFailureArtifacts({
  runDir,
  index,
  url,
  result,
  page,
  saveHtml,
  saveScreenshot
}) {
  if (!runDir) return null;

  const parsed = (() => {
    try {
      return new URL(result.finalUrl || url);
    } catch {
      return null;
    }
  })();

  const slug = parsed
    ? sanitizeFileSegment(`${parsed.hostname}-${parsed.pathname.split("/").filter(Boolean).slice(-2).join("-")}`)
    : sanitizeFileSegment(url);
  const baseName = `${String(index + 1).padStart(4, "0")}-${slug || "page"}`;

  const artifacts = {
    dir: runDir,
    metadataPath: path.join(runDir, `${baseName}.json`)
  };

  let htmlContent = result.html || "";
  if (!htmlContent && page) {
    try {
      htmlContent = await page.content();
    } catch {
      htmlContent = "";
    }
  }

  if (saveHtml && htmlContent) {
    artifacts.htmlPath = path.join(runDir, `${baseName}.html`);
    await fs.writeFile(artifacts.htmlPath, htmlContent, "utf8");
  }

  if (saveScreenshot && page) {
    artifacts.screenshotPath = path.join(runDir, `${baseName}.png`);
    try {
      await page.screenshot({ path: artifacts.screenshotPath, fullPage: true });
    } catch {
      delete artifacts.screenshotPath;
    }
  }

  const metadata = {
    createdAt: new Date().toISOString(),
    inputUrl: url,
    finalUrl: result.finalUrl || "",
    status: result.status || null,
    reasonCode: result.reasonCode || "SCRAPE_ERROR",
    error: result.error || "",
    attempts: result.attempts || 1,
    redirectChain: result.redirectChain || [],
    artifacts: {
      htmlPath: artifacts.htmlPath || "",
      screenshotPath: artifacts.screenshotPath || ""
    }
  };
  await fs.writeFile(artifacts.metadataPath, JSON.stringify(metadata, null, 2), "utf8");

  return artifacts;
}

async function applyContextAuth(context, authOptions = {}, fallbackOrigins = []) {
  const headers = normalizeHeaders(authOptions.headers);
  await context.setExtraHTTPHeaders(headers);

  const cookies = normalizeCookies(authOptions.cookies, fallbackOrigins);
  if (cookies.length) {
    await context.addCookies(cookies);
  }
}

async function configureContextResourceBlocking(context) {
  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (["image", "media", "font", "stylesheet"].includes(type)) {
      route.abort();
      return;
    }
    route.continue();
  });
}

async function runLoginPreStep({
  context,
  login,
  timeoutMs,
  sender,
  stopCheck
}) {
  if (!login?.enabled) return;
  if (!login.url || !login.usernameSelector || !login.passwordSelector) {
    throw new Error("Login pre-step missing required fields.");
  }

  stopCheck();
  sender.send("scrape-status", {
    type: "status",
    message: `Running login pre-step at ${login.url}`
  });

  const page = await context.newPage();
  try {
    await page.goto(login.url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    stopCheck();

    if (typeof login.username === "string") {
      await page.fill(login.usernameSelector, login.username);
    }
    if (typeof login.password === "string") {
      await page.fill(login.passwordSelector, login.password);
    }

    if (login.submitSelector) {
      await Promise.all([
        page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {}),
        page.click(login.submitSelector)
      ]);
    } else {
      await page.keyboard.press("Enter");
    }

    const waitSelector = (login.successSelector || "").trim();
    if (waitSelector) {
      await page.waitForSelector(waitSelector, { timeout: timeoutMs });
    } else {
      const waitSeconds = clampNumber(login.waitSeconds, 2, 0, 30);
      if (waitSeconds > 0) {
        await page.waitForTimeout(waitSeconds * 1000);
      }
    }

    sender.send("scrape-status", {
      type: "status",
      message: "Login pre-step completed."
    });
  } finally {
    await page.close().catch(() => {});
  }
}

function createStopError() {
  const err = new Error("Aborted");
  err.reasonCode = "ABORTED";
  return err;
}

function getOriginList(urls) {
  const origins = new Set();
  urls.forEach((url) => {
    try {
      origins.add(new URL(url).origin);
    } catch {
      // ignore invalid url
    }
  });
  return Array.from(origins);
}

function parseRuntimeConfig(payload = {}) {
  const urls = Array.isArray(payload.urls) ? payload.urls.filter(Boolean) : [];
  const headless = payload.headless !== false;
  const rawHtmlOnly = payload.rawHtmlOnly === true;
  const blockResources = payload.blockResources !== false;
  const waitForSelector = (payload.waitForSelector || "").trim();
  const botGuardInput = payload.botGuard || {};
  const proxyInput = payload.proxyFallback || {};

  const challengeStatusCodes = parseStatusCodeList(
    botGuardInput.challengeStatusCodes ?? payload.challengeStatusCodes,
    DEFAULT_CHALLENGE_STATUS_CODES
  );
  const challengeSignals = parseKeywordList(
    botGuardInput.challengeSignals ?? payload.challengeSignals,
    DEFAULT_CHALLENGE_SIGNALS
  );

  const proxyList = normalizeProxyList(
    proxyInput.proxies
      ?? proxyInput.proxyList
      ?? proxyInput.list
      ?? payload.proxyList
      ?? payload.proxies
      ?? payload.proxyText
      ?? ""
  );
  const proxyEnabled = proxyList.length > 0 && proxyInput.enabled !== false;

  const config = {
    urls,
    options: {
      headless,
      rawHtmlOnly,
      blockResources,
      waitForSelector,
      waitTimeoutMs: Math.round(clampNumber(payload.waitTimeoutSeconds, rawHtmlOnly ? 0 : 15, 0, 120) * 1000),
      delayMs: Math.round(clampNumber(payload.delaySeconds, 0, 0, 60) * 1000),
      perDomainDelayMs: Math.round(clampNumber(payload.perDomainDelaySeconds, 0, 0, 120) * 1000),
      concurrency: Math.round(clampNumber(payload.concurrency, 1, 1, 12)),
      maxRequests: Math.round(clampNumber(payload.maxRequests, 0, 0, 50000)),
      requestTimeoutMs: Math.round(clampNumber(payload.requestTimeoutSeconds, 30, 2, 240) * 1000),
      retryCount: Math.round(clampNumber(payload.retryCount, 2, 0, 8)),
      retryBackoffMs: Math.round(clampNumber(payload.retryBackoffMs, 700, 100, 20000)),
      botGuard: {
        enabled: botGuardInput.enabled !== false,
        challengeStatusCodes,
        challengeSignals,
        maxBodyScanChars: Math.round(clampNumber(botGuardInput.maxBodyScanChars, 50000, 1000, 300000)),
        directHardenRetries: Math.round(clampNumber(botGuardInput.directHardenRetries, 1, 0, 3)),
        directHardeningWaitMs: Math.round(clampNumber(botGuardInput.directHardeningWaitSeconds, 2, 0, 30) * 1000)
      },
      proxyFallback: {
        enabled: proxyEnabled,
        proxies: proxyList,
        domainChallengeThreshold: Math.round(clampNumber(proxyInput.domainChallengeThreshold, 2, 1, 8)),
        maxAttemptsPerUrl: Math.round(clampNumber(proxyInput.maxAttemptsPerUrl, 2, 1, 8)),
        stickyPerDomain: proxyInput.stickyPerDomain !== false,
        rotateOnFailure: proxyInput.rotateOnFailure !== false
      },
      auth: {
        headers: payload.auth?.headers || {},
        cookies: payload.auth?.cookies || [],
        login: payload.auth?.login || { enabled: false }
      },
      artifacts: {
        enabled: payload.artifacts?.enabled === true,
        outputDir: payload.artifacts?.outputDir || "",
        saveHtml: payload.artifacts?.saveHtml !== false,
        saveScreenshot: payload.artifacts?.saveScreenshot !== false
      }
    }
  };

  if (config.options.maxRequests > 0 && config.options.maxRequests < config.urls.length) {
    config.urls = config.urls.slice(0, config.options.maxRequests);
  }

  return config;
}

let currentScrape = null;

async function scrapeWithPlaywright({
  sender,
  index,
  url,
  context,
  options,
  stopCheck
}) {
  const page = await context.newPage();
  try {
    stopCheck();
    if (options.challengeHardening) {
      await page.route("**/*", (route) => route.continue()).catch(() => {});
    }

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: options.requestTimeoutMs
    });

    const status = response ? response.status() : null;
    const redirectChain = buildRedirectChain(response);

    if (status && status >= 400) {
      const error = new Error(`HTTP ${status}`);
      error.reasonCode = "HTTP_ERROR";
      error.status = status;
      throw error;
    }

    if (options.waitForSelector) {
      try {
        await page.waitForSelector(options.waitForSelector, { timeout: options.waitTimeoutMs || 15000 });
      } catch {
        const selectorErr = new Error(`Selector timed out: ${options.waitForSelector}`);
        selectorErr.reasonCode = "SELECTOR_TIMEOUT";
        throw selectorErr;
      }
    } else if (options.waitTimeoutMs > 0) {
      try {
        await page.waitForLoadState("load", { timeout: options.requestTimeoutMs });
      } catch {
        // ignore
      }
      await page.waitForTimeout(options.waitTimeoutMs);
    }

    if (options.challengeHardening && options.botGuard?.directHardeningWaitMs > 0) {
      const extraWait = options.botGuard.directHardeningWaitMs;
      await page.waitForTimeout(extraWait);
      try {
        const viewport = page.viewportSize() || { width: 1280, height: 720 };
        await page.mouse.move(
          Math.round(viewport.width * 0.35),
          Math.round(viewport.height * 0.3),
          { steps: 8 }
        );
        await page.mouse.wheel(0, Math.round(viewport.height * 0.45));
      } catch {
        // ignore cursor simulation failures
      }
      await page.waitForTimeout(Math.min(1200, Math.round(extraWait * 0.4)));
    }

    const html = await page.content();
    return {
      ok: true,
      index,
      url,
      html,
      finalUrl: page.url(),
      status,
      redirectChain,
      page
    };
  } catch (error) {
    return {
      ok: false,
      index,
      url,
      html: "",
      finalUrl: page.url() || url,
      status: error?.status || null,
      redirectChain: [],
      reasonCode: reasonFromError(error),
      error: error?.message || "Navigation failed",
      page
    };
  }
}

async function scrapeWithRawFetch({
  index,
  url,
  options,
  stopCheck,
  abortSignal,
  cookieJar
}) {
  stopCheck();

  const headers = normalizeHeaders(options.auth.headers);
  const scopedCookies = cookiesForUrl(cookieJar, url);
  const headerCookie = scopedCookies.length ? scopedCookies.join("; ") : "";
  if (headerCookie) {
    headers.cookie = headers.cookie
      ? `${headers.cookie}; ${headerCookie}`
      : headerCookie;
  }

  try {
    const response = await fetchWithMeta(url, {
      headers,
      timeoutMs: options.requestTimeoutMs,
      signal: abortSignal
    });

    if (!response.ok) {
      return {
        ok: false,
        index,
        url,
        html: response.html || "",
        status: response.status,
        finalUrl: response.finalUrl,
        redirectChain: response.redirectChain,
        reasonCode: "HTTP_ERROR",
        error: `HTTP ${response.status}`
      };
    }

    return {
      ok: true,
      index,
      url,
      html: response.html,
      status: response.status,
      finalUrl: response.finalUrl,
      redirectChain: response.redirectChain
    };
  } catch (error) {
    return {
      ok: false,
      index,
      url,
      html: "",
      status: null,
      finalUrl: url,
      redirectChain: [],
      reasonCode: reasonFromError(error),
      error: error?.message || "Request failed"
    };
  }
}

async function scrapeOneUrl({
  sender,
  index,
  url,
  options,
  context,
  artifactDir,
  stopCheck,
  registerAbort,
  unregisterAbort,
  cookieJar,
  originList,
  domainStateMap,
  registerRuntimeBrowser,
  unregisterRuntimeBrowser
}) {
  const maxDirectAttempts = options.retryCount + 1;
  const maxProxyAttempts = (
    !options.rawHtmlOnly
    && options.proxyFallback.enabled
    && Array.isArray(options.proxyFallback.proxies)
    && options.proxyFallback.proxies.length
  )
    ? options.proxyFallback.maxAttemptsPerUrl
    : 0;
  const totalBudget = maxDirectAttempts + maxProxyAttempts;
  const domainState = ensureDomainState(domainStateMap, url);

  let directAttempts = 0;
  let proxyAttempts = 0;
  let directHardenRetriesUsed = 0;
  let nextAttemptHardened = false;
  let usingProxy = maxProxyAttempts > 0 && domainState.proxyEngaged;
  let latestResult = null;
  let latestAttemptNo = 0;

  const finalizeLatest = () => ({
    url,
    html: latestResult?.html || "",
    error: latestResult?.error || "Navigation failed",
    errorCode: latestResult?.reasonCode || "SCRAPE_ERROR",
    status: latestResult?.status || "",
    finalUrl: latestResult?.finalUrl || url,
    redirectChain: latestResult?.redirectChain || [],
    attempts: latestAttemptNo || 1,
    artifactPath: ""
  });

  while (true) {
    stopCheck();

    const canTryProxy = maxProxyAttempts > 0 && domainState.proxyEngaged && proxyAttempts < maxProxyAttempts;
    const canTryDirect = directAttempts < maxDirectAttempts;

    if (!canTryDirect && !canTryProxy) {
      return finalizeLatest();
    }

    const isProxyAttempt = usingProxy && canTryProxy;
    if (isProxyAttempt) {
      proxyAttempts += 1;
    } else {
      usingProxy = false;
      if (!canTryDirect) {
        usingProxy = true;
        continue;
      }
      directAttempts += 1;
    }

    const attemptNo = directAttempts + proxyAttempts;
    latestAttemptNo = attemptNo;
    const attemptLabel = isProxyAttempt
      ? `proxy ${proxyAttempts}/${maxProxyAttempts}`
      : `${nextAttemptHardened ? "direct-hardened" : "direct"} ${directAttempts}/${maxDirectAttempts}`;

    sender.send("scrape-status", {
      type: "status",
      message: `[#${index + 1}] ${url} (attempt ${attemptNo}/${Math.max(1, totalBudget)} - ${attemptLabel})`
    });

    let result;
    let pageRef = null;
    let transientContext = null;
    let transientBrowser = null;
    let controller = null;
    let proxyEntry = null;

    const cleanupAttemptResources = async () => {
      if (pageRef) {
        await pageRef.close().catch(() => {});
        pageRef = null;
      }
      if (transientContext) {
        await transientContext.close().catch(() => {});
        transientContext = null;
      }
      if (transientBrowser) {
        unregisterRuntimeBrowser(transientBrowser);
        await transientBrowser.close().catch(() => {});
        transientBrowser = null;
      }
    };

    try {
      if (options.rawHtmlOnly) {
        controller = new AbortController();
        registerAbort(controller);
        result = await scrapeWithRawFetch({
          index,
          url,
          options,
          stopCheck,
          abortSignal: controller.signal,
          cookieJar
        });
        unregisterAbort(controller);
        controller = null;
      } else if (isProxyAttempt) {
        proxyEntry = pickProxyForDomain(domainState, options.proxyFallback);
        if (!proxyEntry) {
          result = {
            ok: false,
            index,
            url,
            html: "",
            status: null,
            finalUrl: url,
            redirectChain: [],
            reasonCode: "PROXY_UNAVAILABLE",
            error: "Proxy fallback enabled but no valid proxy endpoints are configured."
          };
        } else {
          sender.send("scrape-status", {
            type: "status",
            message: `[#${index + 1}] proxy fallback via ${proxyEntry.label || proxyEntry.server}`
          });

          transientBrowser = await chromium.launch({
            headless: options.headless,
            proxy: {
              server: proxyEntry.server,
              ...(proxyEntry.username ? { username: proxyEntry.username } : {}),
              ...(proxyEntry.password ? { password: proxyEntry.password } : {})
            }
          });
          registerRuntimeBrowser(transientBrowser);

          transientContext = await transientBrowser.newContext({
            userAgent: normalizeHeaders(options.auth.headers)["user-agent"] || DEFAULT_USER_AGENT,
            extraHTTPHeaders: normalizeHeaders(options.auth.headers)
          });
          await applyContextAuth(transientContext, options.auth, originList);
          if (options.blockResources) {
            await configureContextResourceBlocking(transientContext);
          }
          await runLoginPreStep({
            context: transientContext,
            login: options.auth.login,
            timeoutMs: options.requestTimeoutMs,
            sender,
            stopCheck
          });

          result = await scrapeWithPlaywright({
            sender,
            index,
            url,
            context: transientContext,
            options: {
              ...options,
              challengeHardening: false
            },
            stopCheck
          });
          pageRef = result.page;
          delete result.page;
        }
      } else {
        result = await scrapeWithPlaywright({
          sender,
          index,
          url,
          context,
          options: {
            ...options,
            challengeHardening: nextAttemptHardened
          },
          stopCheck
        });
        pageRef = result.page;
        delete result.page;
      }
    } catch (error) {
      result = {
        ok: false,
        index,
        url,
        html: "",
        status: null,
        finalUrl: url,
        redirectChain: [],
        reasonCode: reasonFromError(error),
        error: error?.message || "Navigation failed"
      };
    } finally {
      if (controller) {
        unregisterAbort(controller);
      }
    }

    const challengeSignal = detectBotChallenge(result, options);
    if (challengeSignal) {
      result.ok = false;
      result.reasonCode = "BOT_CHALLENGE";
      result.error = `Bot challenge detected (${challengeSignal}).`;
    }

    result.attempt = attemptNo;
    latestResult = result;

    if (result.ok) {
      domainState.challengeHits = Math.max(0, domainState.challengeHits - 1);
      if (!isProxyAttempt && domainState.challengeHits === 0) {
        domainState.proxyEngaged = false;
      }
      if (isProxyAttempt) {
        domainState.proxyEngaged = true;
      }
      nextAttemptHardened = false;
      await cleanupAttemptResources();
      return {
        url,
        html: result.html,
        error: "",
        errorCode: "",
        status: result.status || "",
        finalUrl: result.finalUrl || url,
        redirectChain: result.redirectChain || [],
        attempts: attemptNo,
        artifactPath: ""
      };
    }

    if (result.reasonCode === "BOT_CHALLENGE") {
      domainState.challengeHits += 1;
      sender.send("scrape-status", {
        type: "status",
        message: `[#${index + 1}] challenge signal on ${domainState.domain} (hit ${domainState.challengeHits})`
      });
      if (
        maxProxyAttempts > 0
        && domainState.challengeHits >= options.proxyFallback.domainChallengeThreshold
      ) {
        domainState.proxyEngaged = true;
      }
    }

    if (
      !isProxyAttempt
      && result.reasonCode === "BOT_CHALLENGE"
      && options.botGuard.enabled
      && directHardenRetriesUsed < options.botGuard.directHardenRetries
      && directAttempts < maxDirectAttempts
    ) {
      directHardenRetriesUsed += 1;
      nextAttemptHardened = true;
      const waitMs = buildBackoffMs(directAttempts, options.retryBackoffMs);
      sender.send("scrape-status", {
        type: "status",
        message: `[#${index + 1}] challenge hardening retry in ${(waitMs / 1000).toFixed(1)}s`
      });
      await cleanupAttemptResources();
      if (waitMs > 0) await delay(waitMs);
      continue;
    }

    if (
      !isProxyAttempt
      && maxProxyAttempts > 0
      && domainState.proxyEngaged
      && proxyAttempts < maxProxyAttempts
    ) {
      usingProxy = true;
      nextAttemptHardened = false;
      const waitMs = buildBackoffMs(directAttempts, options.retryBackoffMs);
      sender.send("scrape-status", {
        type: "status",
        message: `[#${index + 1}] switching ${domainState.domain} to proxy fallback`
      });
      await cleanupAttemptResources();
      if (waitMs > 0) await delay(waitMs);
      continue;
    }

    if (isProxyAttempt && options.proxyFallback.rotateOnFailure) {
      rotateProxyForDomain(domainState, options.proxyFallback);
    }

    nextAttemptHardened = false;

    const retryable = shouldRetry(result.reasonCode, result.status);
    const hasMoreAttempts = isProxyAttempt
      ? proxyAttempts < maxProxyAttempts
      : directAttempts < maxDirectAttempts;
    if (retryable && hasMoreAttempts) {
      const retrySlot = isProxyAttempt ? proxyAttempts : directAttempts;
      const waitMs = buildBackoffMs(retrySlot, options.retryBackoffMs);
      sender.send("scrape-status", {
        type: "status",
        message: `[#${index + 1}] retrying in ${(waitMs / 1000).toFixed(1)}s (${result.reasonCode})`
      });
      await cleanupAttemptResources();
      if (waitMs > 0) await delay(waitMs);
      continue;
    }

    const enriched = {
      url,
      html: result.html || "",
      error: result.error || "Navigation failed",
      reasonCode: result.reasonCode || "SCRAPE_ERROR",
      status: result.status || "",
      finalUrl: result.finalUrl || url,
      redirectChain: result.redirectChain || [],
      attempts: attemptNo
    };

    if (artifactDir && options.artifacts.enabled) {
      const artifact = await persistFailureArtifacts({
        runDir: artifactDir,
        index,
        url,
        result: {
          ...enriched,
          reasonCode: enriched.reasonCode
        },
        page: pageRef,
        saveHtml: options.artifacts.saveHtml,
        saveScreenshot: options.artifacts.saveScreenshot
      });
      if (artifact?.dir) {
        enriched.artifactPath = artifact.dir;
      }
    }

    await cleanupAttemptResources();

    return {
      url,
      html: enriched.html,
      error: enriched.error,
      errorCode: enriched.reasonCode,
      status: enriched.status,
      finalUrl: enriched.finalUrl,
      redirectChain: enriched.redirectChain,
      attempts: enriched.attempts,
      artifactPath: enriched.artifactPath || ""
    };
  }
}

function selectorPickerBootstrap() {
  if (window.__wesPickerActive) return;
  window.__wesPickerActive = true;

  const style = document.createElement("style");
  style.id = "wes-picker-style";
  style.textContent = [
    "#wes-picker-box {",
    "  position: fixed;",
    "  border: 2px solid #00b6ff;",
    "  background: rgba(0, 182, 255, 0.12);",
    "  pointer-events: none;",
    "  z-index: 2147483644;",
    "  box-shadow: 0 0 0 99999px rgba(2, 7, 17, 0.15);",
    "  transition: all 40ms linear;",
    "}",
    "#wes-picker-label {",
    "  position: fixed;",
    "  z-index: 2147483645;",
    "  pointer-events: none;",
    "  background: #031830;",
    "  color: #d8f5ff;",
    "  border: 1px solid rgba(0, 182, 255, 0.45);",
    "  border-radius: 8px;",
    "  padding: 6px 8px;",
    "  font: 12px/1.25 Menlo, Monaco, monospace;",
    "  max-width: min(70vw, 600px);",
    "  white-space: nowrap;",
    "  text-overflow: ellipsis;",
    "  overflow: hidden;",
    "}"
  ].join("\n");
  document.documentElement.appendChild(style);

  const box = document.createElement("div");
  box.id = "wes-picker-box";
  const label = document.createElement("div");
  label.id = "wes-picker-label";
  label.textContent = "Selector picker active";
  document.documentElement.appendChild(box);
  document.documentElement.appendChild(label);

  const cssEscape = (value) => {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return String(value).replace(/([^a-zA-Z0-9_-])/g, "\\$1");
  };

  const candidateSelector = (el) => {
    if (!(el instanceof Element)) return "";
    const tag = el.tagName.toLowerCase();

    if (el.id) {
      const candidate = "#" + cssEscape(el.id);
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    }

    const priorityAttrs = ["data-testid", "data-test", "data-qa", "name", "itemprop", "aria-label"];
    for (const attr of priorityAttrs) {
      const val = el.getAttribute(attr);
      if (!val) continue;
      const candidate = `${tag}[${attr}="${cssEscape(val)}"]`;
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    }

    const classes = Array.from(el.classList || []).filter((name) => name && name.length < 40);
    if (classes.length) {
      const candidate = `${tag}.${classes.slice(0, 3).map(cssEscape).join(".")}`;
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    }

    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 7) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += "#" + cssEscape(node.id);
        parts.unshift(part);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((s) => s.tagName === node.tagName);
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };

  let hovered = null;
  const selectorCache = new WeakMap();
  const minMoveIntervalMs = 42;
  let queuedEl = null;
  let moveTimer = null;
  let lastMovePaintAt = 0;

  const selectorFor = (el) => {
    if (!(el instanceof Element)) return "";
    if (selectorCache.has(el)) {
      return selectorCache.get(el);
    }
    const selector = candidateSelector(el);
    selectorCache.set(el, selector);
    return selector;
  };

  const updateOverlay = (el) => {
    if (!(el instanceof Element)) return;
    const rect = el.getBoundingClientRect();
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${Math.max(0, rect.width)}px`;
    box.style.height = `${Math.max(0, rect.height)}px`;

    const selector = selectorFor(el);
    label.textContent = selector || el.tagName.toLowerCase();
    const y = rect.top > 36 ? rect.top - 34 : rect.bottom + 8;
    label.style.left = `${Math.max(6, rect.left)}px`;
    label.style.top = `${Math.max(6, y)}px`;
  };

  const flushMove = () => {
    moveTimer = null;
    if (!(queuedEl instanceof Element)) return;
    const el = queuedEl;
    queuedEl = null;
    updateOverlay(el);
    lastMovePaintAt = Date.now();
  };

  const onMove = (event) => {
    const el = event.target instanceof Element ? event.target : null;
    hovered = el;
    if (!el) return;
    queuedEl = el;

    if (moveTimer) return;
    const elapsed = Date.now() - lastMovePaintAt;
    const waitMs = Math.max(0, minMoveIntervalMs - elapsed);
    moveTimer = setTimeout(flushMove, waitMs);
  };

  const onClick = (event) => {
    if (!(hovered instanceof Element)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const payload = {
      type: "selected",
      selector: selectorFor(hovered),
      tag: hovered.tagName.toLowerCase(),
      text: (hovered.textContent || "").replace(/\s+/g, " ").trim().slice(0, 180),
      attrs: {}
    };

    ["href", "src", "content", "name", "id", "class", "value", "alt", "title"].forEach((key) => {
      const v = hovered.getAttribute && hovered.getAttribute(key);
      if (v) payload.attrs[key] = v;
    });

    if (typeof window.electronSelectorPicked === "function") {
      window.electronSelectorPicked(payload);
    }
  };

  const cleanup = () => {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    window.removeEventListener("keydown", onKey, true);
    if (moveTimer) {
      clearTimeout(moveTimer);
      moveTimer = null;
    }
    queuedEl = null;
    style.remove();
    box.remove();
    label.remove();
    window.__wesPickerActive = false;
    delete window.__wesPickerCleanup;
  };

  const onKey = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    cleanup();
    if (typeof window.electronSelectorPicked === "function") {
      window.electronSelectorPicked({ type: "closed" });
    }
  };

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKey, true);
  window.__wesPickerCleanup = cleanup;
}

let currentPicker = null;

async function stopPicker() {
  if (!currentPicker) return false;
  const picker = currentPicker;
  currentPicker = null;
  try {
    if (picker.page) {
      await picker.page
        .evaluate(() => {
          if (window.__wesPickerCleanup) {
            window.__wesPickerCleanup();
          }
        })
        .catch(() => {});
    }
  } catch {
    // ignore
  }

  try {
    await picker.browser?.close();
  } catch {
    // ignore
  }

  return true;
}

ipcMain.handle("scrape-urls", async (event, payload) => {
  const runtime = parseRuntimeConfig(payload);
  const urls = runtime.urls;
  const options = runtime.options;

  if (!urls.length) return [];
  if (currentScrape) {
    event.sender.send("scrape-status", { type: "status", message: "Scrape already running." });
    return [];
  }

  const results = new Array(urls.length);
  const startedAt = Date.now();

  let browser = null;
  let context = null;
  const abortControllers = new Set();
  const runtimeBrowsers = new Set();
  const stopState = {
    cancel: false,
    browser: null,
    browsers: runtimeBrowsers,
    abortControllers
  };
  currentScrape = stopState;

  const stopCheck = () => {
    if (stopState.cancel) {
      throw createStopError();
    }
  };

  const registerAbort = (controller) => {
    abortControllers.add(controller);
  };

  const unregisterAbort = (controller) => {
    abortControllers.delete(controller);
  };

  const registerRuntimeBrowser = (browserRef) => {
    if (!browserRef) return;
    runtimeBrowsers.add(browserRef);
    if (!stopState.browser) {
      stopState.browser = browserRef;
    }
  };

  const unregisterRuntimeBrowser = (browserRef) => {
    runtimeBrowsers.delete(browserRef);
    if (stopState.browser === browserRef) {
      stopState.browser = null;
    }
  };

  const originList = getOriginList(urls);
  const cookieJar = normalizeCookies(
    [
      ...normalizeCookies(parseCookieHeaderFromText(options.auth.headers?.cookie), originList),
      ...(Array.isArray(options.auth.cookies) ? options.auth.cookies : [])
    ],
    originList
  );
  const domainStateMap = new Map();

  let artifactDir = null;

  let completed = 0;
  const updateProgress = () => {
    event.sender.send("scrape-status", {
      type: "progress",
      completed,
      total: urls.length,
      remainingMs: estimateRemainingMs(startedAt, completed, urls.length)
    });
  };

  try {
    artifactDir = await ensureRunArtifactDir(options.artifacts);
    if (artifactDir) {
      event.sender.send("scrape-status", {
        type: "status",
        message: `Failure artifacts enabled: ${artifactDir}`
      });
    }

    if (options.proxyFallback.enabled) {
      if (options.rawHtmlOnly) {
        event.sender.send("scrape-status", {
          type: "status",
          message: "Proxy fallback disabled in raw fetch mode (enable Render JavaScript to use proxies)."
        });
      } else {
        event.sender.send("scrape-status", {
          type: "status",
          message: `Proxy fallback armed (${options.proxyFallback.proxies.length} endpoint${options.proxyFallback.proxies.length === 1 ? "" : "s"}), threshold ${options.proxyFallback.domainChallengeThreshold} challenge hit(s)/domain.`
        });
      }
    }

    if (!options.rawHtmlOnly) {
      event.sender.send("scrape-status", {
        type: "status",
        message: `Launching browser (${options.headless ? "headless" : "headed"})...`
      });
      browser = await chromium.launch({ headless: options.headless });
      registerRuntimeBrowser(browser);
      context = await browser.newContext({
        userAgent: normalizeHeaders(options.auth.headers)["user-agent"] || DEFAULT_USER_AGENT,
        extraHTTPHeaders: normalizeHeaders(options.auth.headers)
      });

      await applyContextAuth(context, options.auth, originList);

      if (options.blockResources) {
        await configureContextResourceBlocking(context);
      }

      await runLoginPreStep({
        context,
        login: options.auth.login,
        timeoutMs: options.requestTimeoutMs,
        sender: event.sender,
        stopCheck
      });

      event.sender.send("scrape-status", { type: "status", message: "Browser ready." });
    } else {
      event.sender.send("scrape-status", {
        type: "status",
        message: "Using raw HTTP fetch mode (no JavaScript rendering)."
      });
    }

    const domainLastStartAt = new Map();
    const domainLocks = new Map();
    let globalStartAt = 0;
    let globalThrottleLock = Promise.resolve();

    const throttleGlobalStart = async () => {
      if (!options.delayMs) return;
      const run = globalThrottleLock.then(async () => {
        const waitMs = Math.max(0, options.delayMs - (Date.now() - globalStartAt));
        if (waitMs > 0) {
          await delay(waitMs);
        }
        globalStartAt = Date.now();
      });
      globalThrottleLock = run.catch(() => {});
      await run;
    };

    const throttleByDomain = async (url) => {
      if (!options.perDomainDelayMs) return;
      let host;
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        return;
      }

      const previous = domainLocks.get(host) || Promise.resolve();
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      domainLocks.set(host, gate);

      await previous;

      const last = domainLastStartAt.get(host) || 0;
      const waitMs = Math.max(0, options.perDomainDelayMs - (Date.now() - last));
      if (waitMs > 0) {
        await delay(waitMs);
      }
      domainLastStartAt.set(host, Date.now());

      release();
      if (domainLocks.get(host) === gate) {
        domainLocks.delete(host);
      }
    };

    updateProgress();

    let pointer = 0;
    const workerCount = Math.min(options.concurrency, urls.length);

    const worker = async () => {
      while (pointer < urls.length) {
        stopCheck();

        const myIndex = pointer;
        pointer += 1;
        const url = urls[myIndex];

        try {
          await throttleGlobalStart();
          await throttleByDomain(url);
          stopCheck();

          const result = await scrapeOneUrl({
            sender: event.sender,
            index: myIndex,
            url,
            options,
            context,
            artifactDir,
            stopCheck,
            registerAbort,
            unregisterAbort,
            cookieJar,
            originList,
            domainStateMap,
            registerRuntimeBrowser,
            unregisterRuntimeBrowser
          });

          results[myIndex] = result;
          if (result.error) {
            event.sender.send("scrape-status", {
              type: "status",
              message: `Failed ${url} (${result.errorCode || "SCRAPE_ERROR"})`
            });
          } else {
            event.sender.send("scrape-status", {
              type: "status",
              message: `Done ${url}`
            });
          }
          event.sender.send("scrape-result", {
            index: myIndex,
            total: urls.length,
            result
          });
        } catch (error) {
          const reasonCode = reasonFromError(error);
          const result = {
            url,
            html: "",
            error: error?.message || "Navigation failed",
            errorCode: reasonCode,
            status: "",
            finalUrl: url,
            redirectChain: [],
            attempts: 1,
            artifactPath: artifactDir || ""
          };
          results[myIndex] = result;
          event.sender.send("scrape-result", {
            index: myIndex,
            total: urls.length,
            result
          });

          if (reasonCode === "ABORTED") {
            event.sender.send("scrape-status", {
              type: "status",
              message: "Scrape stopped."
            });
            throw error;
          }

          event.sender.send("scrape-status", {
            type: "status",
            message: `Failed ${url} (${truncate(result.error, 120)})`
          });
        } finally {
          completed += 1;
          updateProgress();
        }
      }
    };

    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.allSettled(workers);

    event.sender.send("scrape-status", {
      type: "status",
      message: stopState.cancel ? "Scrape stopped." : "Scrape completed."
    });
  } finally {
    abortControllers.forEach((controller) => {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    });

    if (context) {
      await context.close().catch(() => {});
    }
    const browsersToClose = Array.from(runtimeBrowsers);
    await Promise.all(
      browsersToClose.map(async (browserRef) => {
        try {
          await browserRef.close();
        } catch {
          // ignore
        }
      })
    );
    runtimeBrowsers.clear();
    currentScrape = null;
  }

  return results.filter(Boolean);
});

ipcMain.handle("scrape-stop", async (event) => {
  if (!currentScrape) {
    event.sender.send("scrape-status", { type: "status", message: "No active scrape." });
    return false;
  }

  currentScrape.cancel = true;

  currentScrape.abortControllers.forEach((controller) => {
    try {
      controller.abort();
    } catch {
      // ignore
    }
  });

  const browsers = currentScrape.browsers
    ? Array.from(currentScrape.browsers)
    : (currentScrape.browser ? [currentScrape.browser] : []);
  await Promise.all(
    browsers.map(async (browserRef) => {
      try {
        await browserRef.close();
      } catch {
        // ignore
      }
    })
  );

  return true;
});

ipcMain.handle("picker-start", async (event, payload = {}) => {
  const url = (payload.url || "").trim();
  if (!url) {
    event.sender.send("picker-status", { type: "status", message: "Picker URL is required." });
    return { ok: false };
  }

  if (currentPicker) {
    await stopPicker();
  }

  const options = {
    headless: false,
    requestTimeoutMs: Math.round(clampNumber(payload.requestTimeoutSeconds, 30, 2, 240) * 1000),
    auth: {
      headers: payload.auth?.headers || {},
      cookies: payload.auth?.cookies || [],
      login: payload.auth?.login || { enabled: false }
    }
  };

  const origins = getOriginList([url]);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent: normalizeHeaders(options.auth.headers)["user-agent"] || DEFAULT_USER_AGENT,
    extraHTTPHeaders: normalizeHeaders(options.auth.headers)
  });

  await applyContextAuth(context, options.auth, origins);

  await runLoginPreStep({
    context,
    login: options.auth.login,
    timeoutMs: options.requestTimeoutMs,
    sender: event.sender,
    stopCheck: () => {}
  });

  const page = await context.newPage();

  await page.exposeBinding("electronSelectorPicked", (_source, data) => {
    event.sender.send("picker-selection", data || {});
  });

  const injectPicker = async () => {
    await page.evaluate(selectorPickerBootstrap).catch(() => {});
  };

  page.on("domcontentloaded", () => {
    injectPicker().catch(() => {});
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.requestTimeoutMs });
  await injectPicker();

  currentPicker = { browser, context, page, sender: event.sender };

  event.sender.send("picker-status", {
    type: "status",
    message: "Selector picker started. Click an element in the browser."
  });

  return { ok: true };
});

ipcMain.handle("picker-stop", async (event) => {
  const stopped = await stopPicker();
  event.sender.send("picker-status", {
    type: "status",
    message: stopped ? "Selector picker stopped." : "Selector picker not running."
  });
  return stopped;
});

ipcMain.handle("open-external", async (_event, url) => {
  if (!url) return;
  await shell.openExternal(url);
});

ipcMain.handle("open-path", async (_event, targetPath) => {
  if (!targetPath) return false;
  const result = await shell.openPath(targetPath);
  return result === "";
});
