import { app, globalShortcut, ipcMain, Menu, shell, Tray, nativeImage } from "electron"
import path from "node:path"
import { Assistant, AnswerHandlers, Thread } from "./assistant"
import { captureArea, clearArea, pickArea } from "./capture"
import { getConfig, HOME_DIR, loadConfig, watchConfig } from "./config"
import { extract, Extracted } from "./extract"
import { GroupStatus, Inbox } from "./inbox"
import { WindowHelper } from "./WindowHelper"

type Status = "idle" | "reading" | "routing" | "thinking" | "answering" | "error"

const overlay = new WindowHelper()
const assistant = new Assistant()
const pending = new Map<string, Promise<Extracted>>()
let queue: Promise<void> = Promise.resolve()

const state = {
  status: "idle" as Status,
  error: null as string | null,
  group: { count: 0, closesAt: null, paused: false } as GroupStatus,
  notice: null as string | null,
  thread: null as null | { id: string; title: string; iterations: { at: number; kind: string; answer: string; diagrams: number }[] },
  viewIndex: -1, // -1 follows the latest answer
  live: "",
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

function showThread(t: Thread | null): void {
  state.thread = t && {
    id: t.id,
    title: t.title,
    iterations: t.iterations.map((i) => ({ at: i.at, kind: i.kind, answer: i.answer, diagrams: i.diagrams }))
  }
}

const handlers: AnswerHandlers = {
  onStatus: (s) => {
    state.status = s
    push()
  },
  onThread: (t, isNew) => {
    showThread(t)
    state.viewIndex = -1
    state.live = ""
    notice(isNew ? `✦ New thread: ${t.title}` : `↻ Continuing: ${t.title} — iteration ${t.iterations.length + 1}`)
  },
  onDelta: (text) => {
    state.live = text
    push()
  },
  onDone: (t) => {
    showThread(t)
    state.live = ""
    state.status = "idle"
    push()
  }
}

function fail(err: unknown): void {
  console.error(err)
  state.status = "error"
  state.error = err instanceof Error ? err.message : String(err)
  state.live = ""
  push()
}

function enqueue(job: () => Promise<void>): void {
  queue = queue.then(job).catch(fail)
}

const inbox = new Inbox({
  onFile: (file) => pending.set(file, extract(file)),
  onGroup: (files) =>
    enqueue(async () => {
      state.status = "reading"
      state.error = null
      push()
      const group = await Promise.all(files.map((f) => pending.get(f) ?? extract(f)))
      files.forEach((f) => pending.delete(f))
      const redactions = group.reduce((a, g) => a + g.redactions, 0)
      state.payload =
        group.map((g) => g.markdown).join("\n\n---\n\n") +
        `\n\n_${group.reduce((a, g) => a + g.diagrams.length, 0)} diagram image(s) · ${redactions} redaction(s)_`
      await assistant.handleGroup(group, handlers)
    }),
  onStatus: (s) => {
    state.group = s
    push()
  }
})

function registerShortcuts(): void {
  const mod = "Control+Alt+Command+"
  const keys: Record<string, () => void> = {
    S: () => captureArea().catch(fail),
    A: () =>
      pickArea().then((a) => {
        if (a) notice(`Capture area saved: ${a.width}×${a.height}`)
      }),
    "Shift+A": () => {
      clearArea()
      notice("Capture area cleared: whole screen under the cursor")
    },
    Return: () => inbox.close(),
    N: () => {
      assistant.startNewThread()
      showThread(null)
      state.viewIndex = -1
      notice("✦ Next screenshots start a new thread")
    },
    J: () =>
      enqueue(async () => {
        if (!(await assistant.joinPrevious(handlers))) notice("Nothing to move back")
      }),
    H: () => overlay.toggleVisible(),
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
      { label: "Screenshot  ⌃⌥⌘S", click: () => captureArea().catch(fail) },
      { label: "Choose capture area  ⌃⌥⌘A", click: () => pickArea() },
      { label: "Send now  ⌃⌥⌘↩", click: () => inbox.close() },
      { label: "New thread  ⌃⌥⌘N", click: () => assistant.startNewThread() },
      { label: "Show / hide overlay  ⌃⌥⌘H", click: () => overlay.toggleVisible() },
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
ipcMain.handle("ask", (_e, q: string) => {
  state.asking = false
  overlay.focusForTyping(false)
  push()
  if (q.trim()) enqueue(() => assistant.ask(q.trim(), handlers))
})
ipcMain.handle("close-ask", () => {
  state.asking = false
  overlay.focusForTyping(false)
  push()
})
ipcMain.handle("open-thread", (_e, id: string) => {
  showThread(assistant.open(id))
  state.viewIndex = -1
  push()
})

if (process.env.SC_DEBUG_PORT) app.commandLine.appendSwitch("remote-debugging-port", process.env.SC_DEBUG_PORT)
app.dock?.hide()
app.whenReady().then(() => {
  loadConfig()
  let inboxDir = getConfig().inboxDir
  watchConfig((c) => {
    if (c.inboxDir !== inboxDir) {
      inboxDir = c.inboxDir
      inbox.restart()
    }
    push()
  })
  overlay.create()
  createTray()
  registerShortcuts()
  inbox.start()
  showThread(assistant.current)
})

app.on("will-quit", () => globalShortcut.unregisterAll())
app.on("window-all-closed", () => {
  // stay alive in the menu bar
})
