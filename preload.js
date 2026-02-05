const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("scraper", {
  scrapeUrls: (payload) => ipcRenderer.invoke("scrape-urls", payload),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  stopScrape: () => ipcRenderer.invoke("scrape-stop"),
  onStatus: (handler) => {
    ipcRenderer.removeAllListeners("scrape-status");
    ipcRenderer.on("scrape-status", (_event, data) => handler(data));
  }
});
