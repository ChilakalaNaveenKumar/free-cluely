import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("areaPicker", {
  done: (area: { x: number; y: number; width: number; height: number } | null) =>
    ipcRenderer.send("area-picked", area)
})
