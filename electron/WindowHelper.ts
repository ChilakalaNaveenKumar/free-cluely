import { BrowserWindow, screen } from "electron"
import path from "node:path"
import { getConfig, saveConfig } from "./config"

const isDev = process.env.NODE_ENV === "development"
const startUrl = isDev ? "http://localhost:5180" : `file://${path.join(__dirname, "../dist/index.html")}`

// The overlay: hidden from screen capture, never takes focus unless asked, click-through by default.
export class WindowHelper {
  private win: BrowserWindow | null = null
  public interactive = false
  private visible = true

  create(): BrowserWindow {
    const saved = getConfig().windowBounds
    const wa = screen.getPrimaryDisplay().workArea
    this.win = new BrowserWindow({
      width: saved?.width ?? 460,
      height: saved?.height ?? 560,
      x: saved?.x ?? wa.x + wa.width - 480,
      y: saved?.y ?? wa.y + 40,
      minWidth: 280,
      minHeight: 160,
      type: "panel", // NSPanel: floats without activating the app
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      ...(getConfig().blur ? { vibrancy: "hud" as const, visualEffectState: "active" as const } : {}), // frosted blur hides what's behind

      roundedCorners: true,
      hasShadow: false,
      focusable: false,
      resizable: true,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true }
    })
    const w = this.win
    w.setContentProtection(process.env.SC_CAPTURABLE !== "1") // SC_CAPTURABLE=1 only for screenshots of the overlay itself
    w.setAlwaysOnTop(true, "screen-saver")
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    w.setHiddenInMissionControl(true)
    w.setIgnoreMouseEvents(true, { forward: true })
    w.loadURL(startUrl).catch((err) => console.error("Failed to load overlay:", err))
    w.once("ready-to-show", () => w.showInactive())

    let saveTimer: NodeJS.Timeout | null = null
    const remember = () => {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => saveConfig({ windowBounds: w.getBounds() }), 500)
    }
    w.on("move", remember)
    w.on("resize", remember)
    w.on("closed", () => (this.win = null))
    return w
  }

  get(): BrowserWindow | null {
    return this.win
  }

  toggleVisible(): void {
    if (!this.win) return
    this.visible = !this.visible
    this.visible ? this.win.showInactive() : this.win.hide()
  }

  // Interactive: clicks land on the overlay (drag, scroll, buttons). Otherwise they pass through.
  setInteractive(on: boolean): void {
    if (!this.win) return
    this.interactive = on
    this.win.setIgnoreMouseEvents(!on, { forward: true })
  }

  // While the pointer is over the panel it takes wheel/trackpad scrolling (still never focus);
  // mouse-move is forwarded in click-through mode, which is how the hover is noticed.
  setHover(on: boolean): void {
    if (!this.win || this.interactive) return
    this.win.setIgnoreMouseEvents(!on, { forward: true })
  }

  // Typing a follow-up needs keyboard focus; give it back as soon as the box closes.
  focusForTyping(on: boolean): void {
    if (!this.win) return
    this.win.setFocusable(on)
    if (on) {
      this.setInteractive(true)
      this.win.focus()
    } else {
      this.win.blur()
      this.setInteractive(false)
    }
  }

  // Opacity is the panel tint over the frosted blur; window-level opacity would let the blur through unblurred.
  nudgeOpacity(delta: number): number {
    const o = Math.min(1, Math.max(0.1, Math.round((getConfig().opacity + delta) * 100) / 100))
    saveConfig({ opacity: o })
    return o
  }

  move(dx: number, dy: number): void {
    if (!this.win) return
    const [x, y] = this.win.getPosition()
    this.win.setPosition(x + dx, y + dy)
  }
}
