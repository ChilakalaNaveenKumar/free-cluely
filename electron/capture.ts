import { BrowserWindow, ipcMain, screen } from "electron"
import { execFile } from "node:child_process"
import path from "node:path"
import { Area, getConfig, saveConfig } from "./config"

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function displayUnderCursor(): Area {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  return { ...d.bounds }
}

// Silent capture (-x: no sound, no thumbnail) of the saved area into the inbox.
// The overlay has content protection, so it never appears in the image.
export function captureArea(): Promise<string> {
  const area = getConfig().area ?? displayUnderCursor()
  const file = path.join(getConfig().inboxDir, `shot-${stamp()}.png`)
  const rect = [area.x, area.y, area.width, area.height].map(Math.round).join(",")
  return new Promise((resolve, reject) => {
    execFile("/usr/sbin/screencapture", ["-x", "-t", "png", "-R", rect, file], (err) =>
      err ? reject(err) : resolve(file)
    )
  })
}

let selector: BrowserWindow | null = null

// Full-screen see-through layer on the display under the cursor; drag a box, Enter/release saves it.
export function pickArea(): Promise<Area | null> {
  if (selector) return Promise.resolve(null)
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  selector = new BrowserWindow({
    ...display.bounds,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    enableLargerThanScreen: true,
    webPreferences: { preload: path.join(__dirname, "area-preload.js"), contextIsolation: true }
  })
  selector.setContentProtection(true)
  selector.setAlwaysOnTop(true, "screen-saver")
  selector.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  selector.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(SELECTOR_HTML))

  return new Promise((resolve) => {
    const done = (area: Area | null) => {
      ipcMain.removeAllListeners("area-picked")
      selector?.close()
      selector = null
      if (area && area.width > 10 && area.height > 10) {
        const global = { ...area, x: area.x + display.bounds.x, y: area.y + display.bounds.y }
        saveConfig({ area: global })
        resolve(global)
      } else resolve(null)
    }
    ipcMain.on("area-picked", (_e, area: Area | null) => done(area))
    selector!.on("closed", () => {
      if (selector) done(null)
    })
  })
}

export function clearArea(): void {
  saveConfig({ area: null })
}

const SELECTOR_HTML = `<!doctype html><html><body style="margin:0;cursor:crosshair;background:rgba(0,0,0,.25);user-select:none;font:14px -apple-system">
<div id="hint" style="position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:8px 14px;border-radius:8px">
Drag to choose the screenshot area · Esc cancels</div>
<div id="box" style="position:fixed;border:2px solid #4af;background:rgba(68,170,255,.12);display:none"></div>
<script>
let s=null,r=null;const b=document.getElementById('box');
onmousedown=e=>{s={x:e.clientX,y:e.clientY};r=null};
onmousemove=e=>{if(!s)return;r={x:Math.min(s.x,e.clientX),y:Math.min(s.y,e.clientY),width:Math.abs(e.clientX-s.x),height:Math.abs(e.clientY-s.y)};
Object.assign(b.style,{display:'block',left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px'})};
onmouseup=()=>{s=null;if(r)window.areaPicker.done(r)};
onkeydown=e=>{if(e.key==='Escape')window.areaPicker.done(null)};
</script></body></html>`
