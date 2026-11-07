const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "desktopApp",
  Object.freeze({
    platform: "windows",
    getRealtimeSettings: () => ipcRenderer.invoke("kaikou:live-read"),
    saveRealtimeSettings: (input) => ipcRenderer.invoke("kaikou:live-save", input),
    getServiceSettings: () => ipcRenderer.invoke("kaikou:service-read"),
    saveServiceSettings: (input) =>
      ipcRenderer.invoke("kaikou:service-save", input),
    testServiceSettings: (input) =>
      ipcRenderer.invoke("kaikou:service-test", input),
    restart: () => ipcRenderer.invoke("kaikou:restart"),
  }),
);
