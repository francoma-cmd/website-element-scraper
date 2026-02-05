const path = require("path");
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const http = require("http");
const https = require("https");
const { chromium } = require("playwright");

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/122.0 Safari/537.36";

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
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

function fetchHtml(url, { userAgent, timeoutMs = 30000, signal } = {}) {
  if (typeof fetch === "function") {
    return fetch(url, {
      headers: { "user-agent": userAgent || DEFAULT_USER_AGENT },
      signal
    }).then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    });
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: { "User-Agent": userAgent || DEFAULT_USER_AGENT }
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = new URL(res.headers.location, url).toString();
          res.resume();
          fetchHtml(nextUrl, { userAgent, timeoutMs, signal }).then(resolve, reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      }
    );

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("Request timed out"));
    });
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error("Aborted"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          req.destroy(new Error("Aborted"));
        },
        { once: true }
      );
    }
    req.end();
  });
}

let currentScrape = null;

ipcMain.handle("scrape-urls", async (event, payload) => {
  const urls = Array.isArray(payload?.urls) ? payload.urls : [];
  const delaySeconds = Math.max(0, Number(payload?.delaySeconds ?? 0));
  const headless = payload?.headless !== false;
  const rawHtmlOnly = payload?.rawHtmlOnly === true;
  const blockResources = payload?.blockResources !== false;
  const waitForSelector = (payload?.waitForSelector || "").trim();
  const waitTimeoutSecondsRaw = Number.isFinite(Number(payload?.waitTimeoutSeconds))
    ? Number(payload.waitTimeoutSeconds)
    : 15;
  const waitTimeoutSeconds = rawHtmlOnly ? 0 : waitTimeoutSecondsRaw;

  const results = [];
  if (!urls.length) return results;

  if (currentScrape) {
    event.sender.send("scrape-status", { type: "status", message: "Scrape already running." });
    return results;
  }

  let browser;
  let page = null;
  let abortController = null;
  currentScrape = { cancel: false, browser: null, abort: null };
  try {
    if (rawHtmlOnly) {
      event.sender.send("scrape-status", {
        type: "status",
        message: "Fetching raw HTML (no JS rendering)..."
      });
    } else {
      event.sender.send("scrape-status", {
        type: "status",
        message: `Launching browser (${headless ? "headless" : "headed"})...`
      });
      browser = await chromium.launch({ headless });
      currentScrape.browser = browser;
      event.sender.send("scrape-status", { type: "status", message: "Browser ready." });
      const context = await browser.newContext({ userAgent: DEFAULT_USER_AGENT });
      page = await context.newPage();
      if (blockResources) {
        await page.route("**/*", (route) => {
          const type = route.request().resourceType();
          if (["image", "media", "font", "stylesheet"].includes(type)) {
            route.abort();
            return;
          }
          route.continue();
        });
      }
    }

    const startedAt = Date.now();
    for (let i = 0; i < urls.length; i += 1) {
      if (currentScrape.cancel) {
        event.sender.send("scrape-status", { type: "status", message: "Scrape stopped." });
        break;
      }
      const url = urls[i];
      const completed = i;
      const total = urls.length;
      const elapsed = Date.now() - startedAt;
      const avgPer = completed > 0 ? elapsed / completed : 0;
      const remainingMs = Math.max(0, Math.round(avgPer * (total - completed)));
      event.sender.send("scrape-status", {
        type: "progress",
        completed,
        total,
        remainingMs
      });
      event.sender.send("scrape-status", { type: "status", message: `Fetching ${url}...` });
      try {
        if (rawHtmlOnly) {
          abortController = new AbortController();
          currentScrape.abort = abortController;
          const html = await fetchHtml(url, {
            userAgent: DEFAULT_USER_AGENT,
            timeoutMs: 30000,
            signal: abortController.signal
          });
          const result = { url, html, error: "" };
          results.push(result);
          event.sender.send("scrape-result", { index: i, total: urls.length, result });
        } else {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
          if (waitForSelector) {
            const selectorTimeoutMs = Math.round(
              (waitTimeoutSeconds > 0 ? waitTimeoutSeconds : 15) * 1000
            );
            try {
              await page.waitForFunction(
                (selector) => {
                  const el = document.querySelector(selector);
                  if (!el) return false;
                  if (el instanceof HTMLAnchorElement) {
                    return !!el.getAttribute("href");
                  }
                  const anchor = el.querySelector && el.querySelector("a[href]");
                  return !!anchor || true;
                },
                waitForSelector,
                { timeout: selectorTimeoutMs }
              );
            } catch {
              event.sender.send("scrape-status", {
                type: "status",
                message: `Wait selector timed out: ${waitForSelector}`
              });
            }
          } else {
            if (waitTimeoutSeconds > 0) {
              try {
                await page.waitForLoadState("load", { timeout: 30000 });
              } catch {
                // ignore load timeout
              }
              await page.waitForTimeout(Math.round(waitTimeoutSeconds * 1000));
            } else {
              await page.waitForTimeout(250);
            }
          }
          const html = await page.content();
          const result = { url, html, error: "" };
          results.push(result);
          event.sender.send("scrape-result", { index: i, total: urls.length, result });
        }
        event.sender.send("scrape-status", { type: "status", message: `Done ${url}` });
      } catch (err) {
        const result = { url, html: "", error: err?.message || "Navigation failed" };
        results.push(result);
        event.sender.send("scrape-result", { index: i, total: urls.length, result });
        event.sender.send("scrape-status", {
          type: "status",
          message: `Failed ${url} (${err?.message || "error"})`
        });
      } finally {
        abortController = null;
        currentScrape.abort = null;
      }

      if (i < urls.length - 1) {
        event.sender.send("scrape-status", {
          type: "status",
          message: `Waiting ${delaySeconds}s...`
        });
        await delay(Math.round(delaySeconds * 1000));
      }

      const completedAfter = i + 1;
      const elapsedAfter = Date.now() - startedAt;
      const avgAfter = completedAfter > 0 ? elapsedAfter / completedAfter : 0;
      const remainingAfter = Math.max(0, Math.round(avgAfter * (urls.length - completedAfter)));
      event.sender.send("scrape-status", {
        type: "progress",
        completed: completedAfter,
        total: urls.length,
        remainingMs: remainingAfter
      });
    }
  } finally {
    if (browser) await browser.close();
    currentScrape = null;
  }

  return results;
});

ipcMain.handle("scrape-stop", async (event) => {
  if (!currentScrape) {
    event.sender.send("scrape-status", { type: "status", message: "No active scrape." });
    return false;
  }
  currentScrape.cancel = true;
  if (currentScrape.abort) {
    try {
      currentScrape.abort.abort();
    } catch {
      // ignore
    }
  }
  if (currentScrape.browser) {
    try {
      await currentScrape.browser.close();
    } catch {
      // ignore
    }
  }
  return true;
});

ipcMain.handle("open-external", async (_event, url) => {
  if (!url) return;
  await shell.openExternal(url);
});
