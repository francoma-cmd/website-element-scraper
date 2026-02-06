const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("scraper", {
  scrapeUrls: (payload) => ipcRenderer.invoke("scrape-urls", payload),
  stopScrape: () => ipcRenderer.invoke("scrape-stop"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  openPath: (targetPath) => ipcRenderer.invoke("open-path", targetPath),
  startPicker: (payload) => ipcRenderer.invoke("picker-start", payload),
  stopPicker: () => ipcRenderer.invoke("picker-stop"),
  onStatus: (handler) => {
    ipcRenderer.removeAllListeners("scrape-status");
    ipcRenderer.on("scrape-status", (_event, data) => handler(data));
  },
  onResult: (handler) => {
    ipcRenderer.removeAllListeners("scrape-result");
    ipcRenderer.on("scrape-result", (_event, data) => handler(data));
  },
  onPickerStatus: (handler) => {
    ipcRenderer.removeAllListeners("picker-status");
    ipcRenderer.on("picker-status", (_event, data) => handler(data));
  },
  onPickerSelection: (handler) => {
    ipcRenderer.removeAllListeners("picker-selection");
    ipcRenderer.on("picker-selection", (_event, data) => handler(data));
  }
});
