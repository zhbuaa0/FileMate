const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "safeBox",
  Object.freeze({
    pickFiles: (mode) => ipcRenderer.invoke("files:pick", mode),
    pickFolder: (mode) => ipcRenderer.invoke("folder:pick", mode),
    pickDestination: () => ipcRenderer.invoke("destination:pick"),
    start: (payload) => ipcRenderer.invoke("batch:start", payload),
    splitPdf: (payload) => ipcRenderer.invoke("pdf:split", payload),
    cancel: () => ipcRenderer.invoke("batch:cancel"),
    reveal: (outputPath) => ipcRenderer.invoke("output:reveal", outputPath),
    onProgress: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on("batch:progress", listener);
      return () => ipcRenderer.removeListener("batch:progress", listener);
    },
  }),
);
