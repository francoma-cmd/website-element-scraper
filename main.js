const path = require("path");
const { app, BrowserWindow, ipcMain, shell } = require("electron");
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

let currentScrape = null;

ipcMain.handle("scrape-urls", async (event, payload) => {
  const urls = Array.isArray(payload?.urls) ? payload.urls : [];
  const delaySeconds = Math.max(0, Number(payload?.delaySeconds ?? 0));
  const headless = payload?.headless !== false;

  const results = [];
  if (!urls.length) return results;

  if (currentScrape) {
    event.sender.send("scrape-status", { type: "status", message: "Scrape already running." });
    return results;
  }

  let browser;
  currentScrape = { cancel: false, browser: null };
  try {
    event.sender.send("scrape-status", {
      type: "status",
      message: `Launching browser (${headless ? "headless" : "headed"})...`
    });
    browser = await chromium.launch({ headless });
    currentScrape.browser = browser;
    event.sender.send("scrape-status", { type: "status", message: "Browser ready." });
    const context = await browser.newContext({ userAgent: DEFAULT_USER_AGENT });
    const page = await context.newPage();

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
        await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
        const html = await page.content();
        results.push({ url, html, error: "" });
        event.sender.send("scrape-status", { type: "status", message: `Done ${url}` });
      } catch (err) {
        results.push({ url, html: "", error: err?.message || "Navigation failed" });
        event.sender.send("scrape-status", {
          type: "status",
          message: `Failed ${url} (${err?.message || "error"})`
        });
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
