import fs from "node:fs"
import path from "node:path"
import { getConfig } from "./config"

const IMAGE = /\.(png|jpe?g|webp|heic|tiff?)$/i

export type GroupStatus = { count: number; closesAt: number | null; paused: boolean }

type Handlers = {
  onFile: (file: string) => void // fires per screenshot so extraction can start early
  onGroup: (files: string[]) => void // fires when the quiet gap (or the max wait) ends
  onStatus: (s: GroupStatus) => void
}

export class Inbox {
  private seen = new Set<string>()
  private files: string[] = []
  private startedAt = 0
  private closesAt: number | null = null
  private timer: NodeJS.Timeout | null = null
  private watcher: fs.FSWatcher | null = null
  public paused = false

  constructor(private h: Handlers) {}

  start(): void {
    const dir = getConfig().inboxDir
    for (const f of fs.readdirSync(dir)) this.seen.add(path.join(dir, f)) // old files are not re-sent
    this.watcher = fs.watch(dir, (_event, name) => {
      if (name && IMAGE.test(name)) this.consider(path.join(dir, name))
    })
  }

  restart(): void {
    this.watcher?.close()
    this.start()
  }

  private async consider(file: string): Promise<void> {
    if (this.seen.has(file) || name(file).startsWith(".")) return
    this.seen.add(file)
    if (!(await settled(file))) return
    if (this.paused) return
    this.add(file)
  }

  private add(file: string): void {
    const now = Date.now()
    if (this.files.length === 0) this.startedAt = now
    this.files.push(file)
    this.h.onFile(file)
    const { quietSeconds, maxGroupSeconds } = getConfig()
    const remainingMax = this.startedAt + maxGroupSeconds * 1000 - now
    this.schedule(Math.max(0, Math.min(quietSeconds * 1000, remainingMax)))
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.closesAt = Date.now() + ms
    this.timer = setTimeout(() => this.close(), ms)
    this.emit()
  }

  // Close the current group right away (the "send now" hotkey).
  close(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.closesAt = null
    const files = this.files
    this.files = []
    this.emit()
    if (files.length) this.h.onGroup(files)
  }

  dropLast(): string | null {
    const f = this.files.pop() ?? null
    if (!this.files.length) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      this.closesAt = null
    }
    this.emit()
    return f
  }

  setPaused(p: boolean): void {
    this.paused = p
    this.emit()
  }

  status(): GroupStatus {
    return { count: this.files.length, closesAt: this.closesAt, paused: this.paused }
  }

  private emit(): void {
    this.h.onStatus(this.status())
  }
}

function name(f: string): string {
  return path.basename(f)
}

// screencapture and browsers write in steps; wait until the size stops changing.
async function settled(file: string): Promise<boolean> {
  let last = -1
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150))
    let size: number
    try {
      size = fs.statSync(file).size
    } catch {
      return false
    }
    if (size > 0 && size === last) return true
    last = size
  }
  return last > 0
}
