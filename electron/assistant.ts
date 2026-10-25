import { AnthropicVertex } from "@anthropic-ai/vertex-sdk"
import type { ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources/messages"
import { diffLines } from "diff"
import fs from "node:fs"
import path from "node:path"
import { HOME_DIR, getConfig } from "./config"
import type { Extracted } from "./extract"

const THREADS_DIR = path.join(HOME_DIR, "threads")

export type Iteration = {
  at: number
  kind: "screens" | "question"
  markdown: string // what was sent (already redacted), for "what changed" and the payload view
  diagrams: number
  user: ContentBlockParam[]
  assistant: ContentBlockParam[] | null // full response content, thinking blocks included, replayed unchanged
  answer: string
}

export type Thread = { id: string; title: string; createdAt: number; updatedAt: number; iterations: Iteration[] }

const SYSTEM = `You help the user while they are on a live call with their team, working through a technical problem or discussion.
You receive text and diagram images extracted from their screenshots. Some text may be OCR-garbled, and [redacted] marks removed names; ignore both.
Each new message is the next iteration of the same problem: build on what was already tried and answered.

Answer in Markdown with these sections, leaving out any that don't apply:
**Headline** — one line on what's going on.
**Answer** — the explanation: the root cause, or the recommended approach and why.
**What changed** — from the second iteration on: what is different from last time.
**Fix / next step** — code, command or config.
**Architecture view** — only when relevant: options, tradeoffs, a recommendation; a mermaid diagram if it helps.
**They might ask** — likely follow-up questions from teammates, each with a short answer.`

const ROUTER = `Decide whether new screenshots continue the user's current problem or start a different one.
Continuing includes: the same error after a fix, the next error in the same code or task, more of the same document, page or diagram.
Also give a short title (3-6 words) for the problem the new screenshots are about.
Reply with only JSON: {"same_problem": true|false, "title": "..."}`

export class Assistant {
  private client: AnthropicVertex | null = null
  private clientKey = ""
  private threads: Thread[] = []
  public current: Thread | null = null
  private forceNew = false
  private lastRouted: { group: Extracted[]; from: Thread | null; to: Thread } | null = null

  constructor() {
    fs.mkdirSync(THREADS_DIR, { recursive: true })
    for (const f of fs.readdirSync(THREADS_DIR)) {
      try {
        this.threads.push(JSON.parse(fs.readFileSync(path.join(THREADS_DIR, f), "utf8")))
      } catch {
        // skip unreadable thread files
      }
    }
    this.threads.sort((a, b) => b.updatedAt - a.updatedAt)
    this.current = this.threads[0] ?? null
  }

  private vertex(): AnthropicVertex {
    const { gcpProject, gcpRegion } = getConfig()
    const key = `${gcpProject}/${gcpRegion}`
    if (!this.client || key !== this.clientKey) {
      if (!gcpProject) throw new Error("Set gcpProject in ~/.screen-copilot/config.json")
      this.client = new AnthropicVertex({ projectId: gcpProject, region: gcpRegion })
      this.clientKey = key
    }
    return this.client
  }

  list(): Thread[] {
    return this.threads
  }

  open(id: string): Thread | null {
    this.current = this.threads.find((t) => t.id === id) ?? this.current
    return this.current
  }

  // The next group starts a fresh thread regardless of what the router would say.
  startNewThread(): void {
    this.forceNew = true
    this.current = null
  }

  private save(t: Thread): void {
    t.updatedAt = Date.now()
    fs.writeFileSync(path.join(THREADS_DIR, `${t.id}.json`), JSON.stringify(t))
    this.threads = [t, ...this.threads.filter((x) => x.id !== t.id)]
  }

  private remove(t: Thread): void {
    fs.rmSync(path.join(THREADS_DIR, `${t.id}.json`), { force: true })
    this.threads = this.threads.filter((x) => x.id !== t.id)
  }

  private newThread(title: string): Thread {
    const now = Date.now()
    return { id: `${now}`, title, createdAt: now, updatedAt: now, iterations: [] }
  }

  private async route(markdown: string): Promise<{ same: boolean; title: string }> {
    const cur = this.current
    const last = cur?.iterations.filter((i) => i.kind === "screens").at(-1)
    const minutes = cur ? Math.round((Date.now() - cur.updatedAt) / 60000) : null
    const prompt = cur
      ? `Current problem: ${cur.title}\nMinutes since its last update: ${minutes}\n\n<previous_screens>\n${last?.markdown ?? ""}\n</previous_screens>\n\n<new_screens>\n${markdown}\n</new_screens>`
      : `There is no current problem.\n\n<new_screens>\n${markdown}\n</new_screens>`
    const res = await this.vertex().messages.create({
      model: getConfig().routerModel,
      max_tokens: 16000,
      system: ROUTER,
      thinking: { type: "adaptive" },
      // structured outputs are blocked by the org's Vertex policy, so the JSON is asked for in the prompt
      output_config: { effort: "high" },
      messages: [{ role: "user", content: prompt }]
    })
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("")
    const json = text.match(/\{[\s\S]*\}/)
    if (!json) throw new Error(`router gave no JSON: ${text.slice(0, 200)}`)
    const parsed = JSON.parse(json[0])
    return { same: !!cur && parsed.same_problem === true, title: String(parsed.title || "New problem") }
  }

  private changes(prev: string | undefined, next: string): string {
    if (!prev) return ""
    const parts = diffLines(prev, next)
    const added = parts.filter((p) => p.added).map((p) => p.value.trim()).filter(Boolean)
    const removed = parts.filter((p) => p.removed).map((p) => p.value.trim()).filter(Boolean)
    if (!added.length && !removed.length) return "Changes since the previous screenshots: none, the screen text is identical."
    return [
      "Changes since the previous screenshots:",
      ...removed.map((r) => `- gone: ${r}`),
      ...added.map((a) => `+ new: ${a}`)
    ].join("\n")
  }

  // A closed screenshot group: decide the thread, then answer in it.
  async handleGroup(group: Extracted[], h: AnswerHandlers): Promise<void> {
    const markdown = group.map((g, i) => (group.length > 1 ? `## Screenshot ${i + 1}\n\n` : "") + g.markdown).join("\n\n")
    h.onStatus("routing")
    const tRoute = Date.now()
    let thread = this.current
    const from = this.current
    const routeErr = (fallback: { same: boolean; title: string }) => (e: unknown) => {
      console.error("[router]", e)
      return fallback
    }
    if (this.forceNew || !thread) {
      const { title } = await this.route(markdown).catch(routeErr({ same: false, title: "New problem" }))
      thread = this.newThread(title)
    } else {
      const r = await this.route(markdown).catch(routeErr({ same: true, title: thread.title }))
      if (!r.same) thread = this.newThread(r.title)
      else if (thread.title === "New problem") thread.title = r.title
    }
    this.forceNew = false
    console.log(`[timing] routing ${((Date.now() - tRoute) / 1000).toFixed(1)}s`)
    this.lastRouted = { group, from, to: thread }
    this.current = thread
    h.onThread(thread, thread !== from)
    await this.answerScreens(thread, group, markdown, h)
  }

  // Hotkey: the last group was put in a new thread by mistake; move it back and re-answer there.
  async joinPrevious(h: AnswerHandlers): Promise<boolean> {
    const r = this.lastRouted
    if (!r || !r.from || r.from === r.to) return false
    if (r.to.iterations.length > 1) return false // the new thread has moved on; leave it
    this.remove(r.to)
    this.current = r.from
    this.lastRouted = { ...r, to: r.from }
    h.onThread(r.from, false)
    const markdown = r.group.map((g, i) => (r.group.length > 1 ? `## Screenshot ${i + 1}\n\n` : "") + g.markdown).join("\n\n")
    await this.answerScreens(r.from, r.group, markdown, h)
    return true
  }

  private async answerScreens(thread: Thread, group: Extracted[], markdown: string, h: AnswerHandlers): Promise<void> {
    const prev = thread.iterations.filter((i) => i.kind === "screens").at(-1)?.markdown
    const n = thread.iterations.length + 1
    const delta = this.changes(prev, markdown)
    const user: ContentBlockParam[] = [
      { type: "text", text: `Iteration ${n} — ${group.length} screenshot(s).\n\n${delta ? delta + "\n\n" : ""}<screens>\n${markdown}\n</screens>` }
    ]
    for (const g of group)
      for (const d of g.diagrams) {
        user.push({ type: "text", text: d.caption })
        user.push({ type: "image", source: { type: "base64", media_type: "image/png", data: d.png } })
      }
    const diagrams = group.reduce((a, g) => a + g.diagrams.length, 0)
    await this.answer(thread, { at: Date.now(), kind: "screens", markdown, diagrams, user, assistant: null, answer: "" }, h)
  }

  // Typed follow-up from the overlay's input box.
  async ask(question: string, h: AnswerHandlers): Promise<void> {
    const thread = this.current ?? this.newThread(question.slice(0, 48))
    this.current = thread
    h.onThread(thread, thread.iterations.length === 0)
    const user: ContentBlockParam[] = [{ type: "text", text: question }]
    await this.answer(thread, { at: Date.now(), kind: "question", markdown: question, diagrams: 0, user, assistant: null, answer: "" }, h)
  }

  private async answer(thread: Thread, it: Iteration, h: AnswerHandlers): Promise<void> {
    const history: MessageParam[] = thread.iterations
      .filter((i) => i.assistant)
      .flatMap((i) => [
        { role: "user" as const, content: i.user },
        { role: "assistant" as const, content: i.assistant! }
      ])
    const messages: MessageParam[] = [...history, { role: "user", content: it.user }]
    h.onStatus("thinking")
    const tAsk = Date.now()
    const { answerModel, effort } = getConfig()
    const stream = this.vertex().messages.stream({
      model: answerModel,
      max_tokens: 64000,
      system: SYSTEM,
      thinking: { type: "adaptive" },
      output_config: { effort },
      cache_control: { type: "ephemeral" }, // whole thread prefix is reused on the next iteration
      messages
    })
    let streamed = ""
    stream.on("text", (delta) => {
      if (!streamed) {
        h.onStatus("answering")
        console.log(`[timing] first words after ${((Date.now() - tAsk) / 1000).toFixed(1)}s`)
      }
      streamed += delta
      h.onDelta(streamed)
    })
    const msg = await stream.finalMessage()
    console.log(`[timing] full answer after ${((Date.now() - tAsk) / 1000).toFixed(1)}s, ${msg.usage.output_tokens} output tokens`)
    if (msg.stop_reason === "refusal") {
      it.answer = "_The model declined to answer this one._"
    } else {
      it.answer = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("")
      it.assistant = msg.content as unknown as ContentBlockParam[]
    }
    thread.iterations.push(it)
    this.save(thread)
    h.onDone(thread)
  }
}

export type AnswerHandlers = {
  onStatus: (s: "routing" | "thinking" | "answering") => void
  onThread: (t: Thread, isNew: boolean) => void
  onDelta: (text: string) => void
  onDone: (t: Thread) => void
}
