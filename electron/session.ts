import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { HOME_DIR, getConfig } from "./config"
import { prepareImage } from "./extract"

const SESSIONS_DIR = path.join(HOME_DIR, "sessions")
const CURRENT = path.join(SESSIONS_DIR, "current")

export type Turn = { at: number; kind: "screens" | "question"; shots: number; question?: string; answer: string; redactions: number }
export type SessionView = { id: string; title: string; startedAt: number; turns: Turn[] }

// Stored messages keep images as file references; they are read back as base64 when sent.
type StoredBlock = { type: "text"; text: string } | { type: "image"; file: string }
type StoredMessage = { role: "user"; content: StoredBlock[]; timestamp: number } | Record<string, unknown>

const SYSTEM = `You help the user while they work, often on a live call with their team.
You receive their screenshots directly. Everything in this session is one continuing conversation: build on earlier screenshots and answers.

Answer in Markdown with these sections, leaving out any that don't apply:
**Headline** — one line on what's going on.
**Answer** — the explanation: the root cause, or the recommended approach and why.
**What changed** — when this continues something from earlier: what is different now.
**Fix / next step** — code, command or config.
**Architecture view** — only when relevant: options, tradeoffs, a recommendation; a mermaid diagram if it helps.
**They might ask** — likely follow-up questions from teammates, each with a short answer.`

// pi-ai ships as ES modules; the main process is CommonJS, so it is loaded with a real import().
let pi: any
async function piai(): Promise<any> {
  if (!pi) {
    const entry = pathToFileURL(path.join(__dirname, "..", "node_modules", "@mariozechner", "pi-ai", "dist", "index.js")).href
    pi = await (new Function("u", "return import(u)") as (u: string) => Promise<any>)(entry)
  }
  return pi
}

// Keys live in the repo's .env (gitignored); re-read each call so a new key works without a restart.
function loadEnv(): void {
  const file = path.join(__dirname, "..", ".env")
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "")
  }
}

export type Handlers = {
  onStatus: (s: "thinking" | "answering") => void
  onThinking: (summary: string) => void
  onDelta: (text: string) => void
  onDone: (s: SessionView) => void
}

export class Session {
  view: SessionView
  private messages: StoredMessage[] = []

  constructor() {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true })
    const id = fs.existsSync(CURRENT) ? fs.readFileSync(CURRENT, "utf8").trim() : ""
    const saved = id && path.join(SESSIONS_DIR, id, "session.json")
    if (saved && fs.existsSync(saved)) {
      const s = JSON.parse(fs.readFileSync(saved, "utf8"))
      this.view = s.view
      this.messages = s.messages
    } else this.view = this.fresh()
  }

  private fresh(): SessionView {
    const now = new Date()
    const id = now.toISOString().replace(/[:.]/g, "-")
    fs.mkdirSync(path.join(SESSIONS_DIR, id), { recursive: true })
    fs.writeFileSync(CURRENT, id)
    const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    return { id, title: `Session · started ${time}`, startedAt: now.getTime(), turns: [] }
  }

  private dir(): string {
    return path.join(SESSIONS_DIR, this.view.id)
  }

  private save(): void {
    fs.writeFileSync(path.join(this.dir(), "session.json"), JSON.stringify({ view: this.view, messages: this.messages }))
  }

  // End: the finished session stays on disk; the next screenshot or question starts a new one.
  end(): SessionView {
    this.save()
    this.view = this.fresh()
    this.messages = []
    return this.view
  }

  async addScreens(files: string[], h: Handlers): Promise<void> {
    const content: StoredBlock[] = [{ type: "text", text: `${files.length} new screenshot(s).` }]
    let redactions = 0
    for (const f of files) {
      const { png, redactions: r } = await prepareImage(f)
      redactions += r
      const name = `shot-${Date.now()}-${content.length}.png`
      fs.writeFileSync(path.join(this.dir(), name), png)
      content.push({ type: "image", file: name })
    }
    await this.run(content, { at: Date.now(), kind: "screens", shots: files.length, answer: "", redactions }, h)
  }

  async ask(question: string, h: Handlers): Promise<void> {
    await this.run([{ type: "text", text: question }], { at: Date.now(), kind: "question", shots: 0, question, answer: "", redactions: 0 }, h)
  }

  private toWire(m: StoredMessage): unknown {
    if (m.role !== "user") return m
    return {
      ...m,
      content: (m.content as StoredBlock[]).map((b) =>
        b.type === "image"
          ? { type: "image", mimeType: "image/png", data: fs.readFileSync(path.join(this.dir(), b.file)).toString("base64") }
          : b
      )
    }
  }

  private async run(content: StoredBlock[], turn: Turn, h: Handlers): Promise<void> {
    loadEnv()
    const { getModel, stream: streamRaw, streamSimple } = await piai()
    const { provider, answerModel } = getConfig()
    const model = getModel(provider, answerModel)
    if (!model) throw new Error(`Unknown model ${provider}/${answerModel} — set provider and answerModel in config.json`)
    const user: StoredMessage = { role: "user", content, timestamp: Date.now() }
    const context = { systemPrompt: SYSTEM, messages: [...this.messages, user].map((m) => this.toWire(m)) }

    h.onStatus("thinking")
    const t0 = Date.now()
    // OpenAI streams a readable reasoning summary only when "detailed" is asked for explicitly
    const stream = String(model.api).includes("openai-responses")
      ? streamRaw(model, context, { reasoningEffort: "high", reasoningSummary: "detailed" })
      : streamSimple(model, context, { reasoning: "high" })
    let thinking = ""
    let text = ""
    for await (const e of stream) {
      if (e.type === "thinking_delta") {
        if (!thinking) console.log(`[timing] thinking starts after ${((Date.now() - t0) / 1000).toFixed(1)}s`)
        thinking += e.delta
        h.onThinking(thinking)
      } else if (e.type === "text_delta") {
        if (!text) {
          h.onStatus("answering")
          console.log(`[timing] first words after ${((Date.now() - t0) / 1000).toFixed(1)}s`)
        }
        text += e.delta
        h.onDelta(text)
      }
    }
    const reply = await stream.result()
    if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage || `model ${reply.stopReason}`)
    console.log(`[timing] full answer after ${((Date.now() - t0) / 1000).toFixed(1)}s`)

    turn.answer = text || reply.content.map((b: any) => (b.type === "text" ? b.text : "")).join("")
    this.messages.push(user, reply)
    this.view.turns.push(turn)
    this.save()
    h.onDone(this.view)
  }
}
