import { app, desktopCapturer, globalShortcut, ipcMain, Menu, shell, systemPreferences, Tray, nativeImage } from "electron"
import { execFile, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { captureArea, clearArea, pickArea } from "./capture"
import { configBroken, getConfig, HOME_DIR, loadConfig, watchConfig } from "./config"
import { GroupStatus, Inbox } from "./inbox"
import { Handlers, Session, SessionView } from "./session"
import { WindowHelper } from "./WindowHelper"

type Status = "idle" | "reading" | "thinking" | "answering" | "error"

const overlay = new WindowHelper()
const session = new Session() // one continuing conversation until End
let queue: Promise<void> = Promise.resolve()

const state = {
  status: "idle" as Status,
  error: null as string | null,
  group: { count: 0, closesAt: null, paused: false } as GroupStatus,
  notice: null as string | null,
  thread: null as null | { id: string; title: string; iterations: { at: number; kind: string; answer: string; diagrams: number }[] },
  viewIndex: -1, // -1 follows the latest answer
  live: "",
  statusSince: 0, // when the current step started, for the elapsed-time display
  thinking: "", // Opus's live thinking summary until the answer starts
  asking: false,
  interactive: false,
  area: null as ReturnType<typeof getConfig>["area"],
  payload: null as string | null,
  showPayload: false,
  opacity: 0.6
}

function push(): void {
  state.area = getConfig().area
  state.interactive = overlay.interactive
  state.opacity = getConfig().opacity
  overlay.get()?.webContents.send("state", state)
}

let noticeTimer: NodeJS.Timeout | null = null
function notice(text: string): void {
  state.notice = text
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    state.notice = null
    push()
  }, 5000)
  push()
}

// the panel's "thread" is the current session; each turn is one screenshot group or question
function showSession(v: SessionView): void {
  state.thread = {
    id: v.id,
    title: v.title,
    iterations: v.turns.map((t) => ({ at: t.at, kind: t.kind, answer: t.answer, diagrams: t.shots }))
  }
}

const handlers: Handlers = {
  onStatus: (s) => {
    state.status = s
    state.statusSince = Date.now()
    push()
  },
  onThinking: (summary) => {
    state.thinking = summary
    push()
  },
  onDelta: (text) => {
    state.live = text
    state.thinking = ""
    push()
  },
  onNote: (msg) => notice(msg),
  onDone: (v) => {
    if (!overlay.visible) tray?.setTitle("SC ●") // an answer is waiting in the hidden panel
    log(`answered: ${v.title}, turn ${v.turns.length}`)
    showSession(v)
    state.viewIndex = -1
    state.live = ""
    state.thinking = ""
    state.status = "idle"
    push()
  }
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

function fail(err: unknown): void {
  console.error(err)
  state.status = "error"
  state.error = err instanceof Error ? err.message : String(err)
  state.live = ""
  state.thinking = ""
  push()
}

function enqueue(job: () => Promise<void>): void {
  queue = queue.then(job).catch(fail)
}

// Groups and typed questions run one after another: anything that arrives while an answer is
// streaming waits its turn and is answered next, in the same session.
const inbox = new Inbox({
  onFile: (file) => {
    log(`screenshot added: ${path.basename(file)}`)
    // a new screenshot means you want the panel: bring it back if it was closed or started hidden
    if (!overlay.visible) {
      overlay.show()
      tray?.setTitle("SC")
    }
  },
  onGroup: (files) =>
    enqueue(async () => {
      log(`group closed: ${files.length} screenshot(s)`)
      state.status = "reading"
      state.statusSince = Date.now()
      state.error = null
      state.payload = `${files.length} screenshot(s) sent as images:\n` + files.map((f) => `- ${path.basename(f)}`).join("\n")
      push()
      await session.addScreens(files, handlers)
    }),
  onStatus: (s) => {
    state.group = s
    push()
  }
})

// Keyed by hotkey (⌃⌥⌘ + key); the panel buttons and tray menu call the same entries.
const keys: Record<string, () => void> = {
  S: () =>
    captureArea()
      .then(() => {
        if (state.error?.startsWith("Screenshots need")) (state.error = null), (state.status = "idle"), push()
      })
      .catch((e) => (/could not create image/.test(String(e)) ? checkScreenPermission() : fail(e))),
  A: () => {
    overlay.setHover(false) // the picker covers the panel, so its mouse-leave never fires
    pickArea().then((a) => {
      if (a) notice(`Capture area saved: ${a.width}×${a.height}`)
    })
  },
  "Shift+A": () => {
    clearArea()
    notice("Capture area cleared: whole screen under the cursor")
  },
  Return: () => inbox.close(),
  E: () =>
    enqueue(async () => {
      const v = session.end()
      showSession(v)
      state.viewIndex = -1
      log(`session ended; new ${v.title}`)
      notice("Session ended — the next screenshot or question starts a new one")
    }),
  H: () => {
    overlay.toggleVisible()
    if (overlay.visible) tray?.setTitle("SC")
  },
  I: () => {
    overlay.setInteractive(!overlay.interactive)
    notice(overlay.interactive ? "Interactive: drag, scroll, click" : "Click-through")
  },
  K: () => {
    state.asking = true
    overlay.focusForTyping(true)
    push()
  },
  P: () => {
    inbox.setPaused(!inbox.paused)
    notice(inbox.paused ? "⏸ Paused — screenshots are not sent" : "▶ Resumed")
  },
  Backspace: () => {
    if (inbox.dropLast()) notice("Removed the last screenshot from this group")
  },
  D: () => {
    state.showPayload = !state.showPayload
    push()
  },
  Up: () => overlay.get()?.webContents.send("scroll", -120),
  Down: () => overlay.get()?.webContents.send("scroll", 120),
  Left: () => {
    const n = state.thread?.iterations.length ?? 0
    if (!n) return
    const cur = state.viewIndex < 0 ? n - 1 : state.viewIndex
    state.viewIndex = Math.max(0, cur - 1)
    push()
  },
  Right: () => {
    const n = state.thread?.iterations.length ?? 0
    if (state.viewIndex < 0) return
    state.viewIndex = state.viewIndex + 1 >= n ? -1 : state.viewIndex + 1
    push()
  },
  "Shift+Up": () => overlay.move(0, -40),
  "Shift+Down": () => overlay.move(0, 40),
  "Shift+Left": () => overlay.move(-40, 0),
  "Shift+Right": () => overlay.move(40, 0),
  "-": () => notice(`Opacity ${Math.round(overlay.nudgeOpacity(-0.05) * 100)}%`),
  "=": () => notice(`Opacity ${Math.round(overlay.nudgeOpacity(0.05) * 100)}%`)
}

function registerShortcuts(): void {
  const mod = "Control+Alt+Command+"
  for (const [k, fn] of Object.entries(keys)) {
    globalShortcut.register(mod + k, fn)
    if (!globalShortcut.isRegistered(mod + k)) console.warn(`[shortcuts] could not register ⌃⌥⌘${k} (taken by another app?)`)
  }
}

let tray: Tray | null = null
function createTray(): void {
  tray = new Tray(nativeImage.createEmpty())
  tray.setTitle("SC")
  tray.setToolTip("Screen Copilot")
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Screenshot  ⌃⌥⌘S", click: keys.S },
      { label: "Choose capture area  ⌃⌥⌘A", click: keys.A },
      { label: "Whole screen (clear area)  ⌃⌥⌘⇧A", click: keys["Shift+A"] },
      { label: "Send now  ⌃⌥⌘↩", click: keys.Return },
      { label: "End session  ⌃⌥⌘E", click: keys.E },
      { label: "Show / hide overlay  ⌃⌥⌘H", click: keys.H },
      { type: "separator" },
      { label: "Open settings file", click: () => shell.openPath(path.join(HOME_DIR, "config.json")) },
      { label: "Open screenshot folder", click: () => shell.openPath(getConfig().inboxDir) },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() }
    ])
  )
}

ipcMain.handle("ready", () => push())
ipcMain.on("hover", (_e, on: boolean) => overlay.setHover(on))
ipcMain.on("drag", (_e, phase: "start" | "move" | "end", x: number, y: number) =>
  phase === "start" ? overlay.dragStart(x, y) : phase === "move" ? overlay.dragMove(x, y) : overlay.dragEnd()
)
ipcMain.on("action", (_e, key: string) => keys[key]?.())
ipcMain.handle("ask", (_e, q: string) => {
  state.asking = false
  overlay.focusForTyping(false)
  push()
  if (q.trim()) enqueue(() => session.ask(q.trim(), handlers))
})
ipcMain.handle("close-ask", () => {
  state.asking = false
  overlay.focusForTyping(false)
  push()
})
if (process.env.SC_DEBUG_PORT) app.commandLine.appendSwitch("remote-debugging-port", process.env.SC_DEBUG_PORT)
// One copy only. A second launch (opening the app, bin/sc show, macOS "Quit & Reopen") just tells
// the running copy to show its panel and exits.
const primary = app.requestSingleInstanceLock()
if (!primary) app.exit(0)

// Opened outside the service while it isn't running: that copy lacks the service's environment
// (log file, working directory), so start the service, which shows the panel, and exit.
const SERVICE_PLIST = path.join(HOME_DIR, "com.screencopilot.app.plist")
if (primary && !process.env.SC_SERVICE && app.isPackaged && fs.existsSync(SERVICE_PLIST)) {
  app.releaseSingleInstanceLock()
  const domain = `gui/${process.getuid?.()}`
  spawn("/bin/sh", ["-c", `sleep 1; /bin/launchctl kickstart ${domain}/com.screencopilot.app || /bin/launchctl bootstrap ${domain} "${SERVICE_PLIST}"`], {
    detached: true,
    stdio: "ignore"
  }).unref()
  app.exit(0)
}

const showPanel = () => {
  overlay.show()
  tray?.setTitle("SC")
}
app.on("second-instance", showPanel)
app.on("activate", showPanel) // macOS sends this instead when the app is opened while running
app.dock?.hide()
app.whenReady().then(() => {
  loadConfig()
  let inboxDir = getConfig().inboxDir
  watchConfig((c) => {
    if (configBroken()) notice("config.json has a typo — keeping your last good settings until it's fixed")
    if (c.inboxDir !== inboxDir) {
      inboxDir = c.inboxDir
      inbox.restart()
    }
    push()
  })
  log(`starting (${process.env.NODE_ENV ?? "production"})${getConfig().startHidden ? ", panel hidden until the first screenshot" : ""}`)
  overlay.create().webContents.on("did-finish-load", () => log("panel loaded"))
  createTray()
  registerShortcuts()
  inbox.start()
  showSession(session.view)
  checkScreenPermission()
})

const SCREEN_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"

// screencapture runs as this app, so it needs Screen Recording permission; asking for a source list
// makes macOS show its prompt and list the app in System Settings.
async function checkScreenPermission(): Promise<void> {
  const ok = await canCapture()
  log(`screen capture self-test: ${ok ? "ok" : "failed"} (macOS reports ${systemPreferences.getMediaAccessStatus("screen")})`)
  if (ok) return
  // Apple's request call (run as our child, so it counts for this app) shows the system prompt
  // and lists the app in System Settings; the source list is a fallback that sometimes does too
  execFile(path.join(__dirname, "..", "native", "bin", "screen-access"), (_e, out) => log(`screen access request: ${String(out).trim() || "failed"}`))
  await desktopCapturer.getSources({ types: ["screen"] }).catch((): Electron.DesktopCapturerSource[] => [])
  state.status = "error"
  state.error =
    "Screenshots need Screen Recording permission. In System Settings → Privacy & Security → Screen & System Audio Recording, " +
    "turn on \"Screen Copilot Overlay\", then run bin/sc restart."
  push()
  shell.openExternal(SCREEN_SETTINGS)
}

// The permission API misreports for ad-hoc signed Electron on recent macOS; a 10×10 capture is the real test.
function canCapture(): Promise<boolean> {
  const file = path.join(app.getPath("temp"), `sc-selftest-${process.pid}.png`)
  return new Promise((resolve) =>
    execFile("/usr/sbin/screencapture", ["-x", "-R", "0,0,10,10", file], (err) => {
      fs.rm(file, { force: true }, () => resolve(!err))
    })
  )
}

app.on("will-quit", () => globalShortcut.unregisterAll())
app.on("window-all-closed", () => {
  // stay alive in the menu bar
})
