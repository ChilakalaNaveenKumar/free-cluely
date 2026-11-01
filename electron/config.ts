import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const HOME_DIR = process.env.SCREEN_COPILOT_HOME || path.join(os.homedir(), ".screen-copilot")
const CONFIG_PATH = path.join(HOME_DIR, "config.json")

export type Area = { x: number; y: number; width: number; height: number }

export type Config = {
  inboxDir: string // "folder X": every image that lands here is processed
  area: Area | null // saved capture area in screen points; null = display under the cursor
  quietSeconds: number // a group closes after this long with no new screenshot
  maxGroupSeconds: number // a group never waits longer than this; 0 = no cap
  redact: string[] // exact phrases, matched case-insensitively
  redactRegex: string[]
  extractDiagrams: boolean
  opacity: number
  blur: boolean // frosted background; off = plain see-through tint
  startHidden: boolean // panel stays hidden after start until the first screenshot arrives
  windowBounds?: { x: number; y: number; width: number; height: number }
  gcpProject: string
  gcpRegion: string
  provider: string // pi-ai provider: "openai", "google", "anthropic", ...
  answerModel: string
  routerModel: string
  effort: "low" | "medium" | "high" | "xhigh" | "max"
}

const DEFAULTS: Config = {
  inboxDir: path.join(os.homedir(), "ScreenCopilot", "inbox"),
  area: null,
  quietSeconds: 10,
  maxGroupSeconds: 0,
  redact: [],
  redactRegex: [],
  extractDiagrams: true,
  opacity: 0.45,
  blur: false,
  startHidden: true,
  gcpProject: process.env.GOOGLE_CLOUD_PROJECT || "",
  gcpRegion: "global",
  provider: "openai",
  answerModel: "gpt-5.5",
  routerModel: "claude-haiku-5-5",
  effort: "high"
}

let current: Config | null = null

// A config file that doesn't parse (a typo while editing) keeps the last good settings and is
// never overwritten, so redaction rules can't silently switch off or be lost.
let broken = false

export function loadConfig(): Config {
  fs.mkdirSync(HOME_DIR, { recursive: true })
  let saved: Partial<Config> = {}
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
      broken = false
    } catch (e) {
      broken = true
      console.error(`[config] ${CONFIG_PATH} doesn't parse, keeping the last good settings: ${(e as Error).message}`)
      if (current) return current
    }
  }
  current = { ...DEFAULTS, ...saved }
  fs.mkdirSync(current.inboxDir, { recursive: true })
  if (!fs.existsSync(CONFIG_PATH)) saveConfig(current)
  return current
}

export function configBroken(): boolean {
  return broken
}

export function getConfig(): Config {
  return current ?? loadConfig()
}

export function saveConfig(patch: Partial<Config>): Config {
  current = { ...(current ?? DEFAULTS), ...patch }
  if (broken) return current // don't replace the user's half-edited file
  fs.mkdirSync(HOME_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2))
  return current
}

// Re-read on change so redaction rules edited by hand apply without a restart.
export function watchConfig(onChange: (c: Config) => void): void {
  fs.watchFile(CONFIG_PATH, { interval: 2000 }, () => onChange(loadConfig()))
}
