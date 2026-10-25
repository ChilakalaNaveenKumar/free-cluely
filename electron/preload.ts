import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("copilot", {
  onState: (cb: (s: unknown) => void) => {
    const fn = (_e: unknown, s: unknown) => cb(s)
    ipcRenderer.on("state", fn)
    return () => ipcRenderer.removeListener("state", fn)
  },
  onScroll: (cb: (dy: number) => void) => {
    const fn = (_e: unknown, dy: number) => cb(dy)
    ipcRenderer.on("scroll", fn)
    return () => ipcRenderer.removeListener("scroll", fn)
  },
  ask: (q: string) => ipcRenderer.invoke("ask", q),
  closeAsk: () => ipcRenderer.invoke("close-ask"),
  openThread: (id: string) => ipcRenderer.invoke("open-thread", id),
  ready: () => ipcRenderer.invoke("ready"),
  hover: (on: boolean) => ipcRenderer.send("hover", on)
})
