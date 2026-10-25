import { useEffect, useRef, useState } from "react"
import Markdown from "./Markdown"

type Iteration = { at: number; kind: string; answer: string; diagrams: number }
type State = {
  status: "idle" | "reading" | "routing" | "thinking" | "answering" | "error"
  error: string | null
  group: { count: number; closesAt: number | null; paused: boolean }
  notice: string | null
  thread: { id: string; title: string; iterations: Iteration[] } | null
  viewIndex: number
  live: string
  asking: boolean
  interactive: boolean
  area: { width: number; height: number } | null
  payload: string | null
  showPayload: boolean
  opacity: number
}

declare global {
  interface Window {
    copilot: {
      onState: (cb: (s: State) => void) => () => void
      onScroll: (cb: (dy: number) => void) => () => void
      ask: (q: string) => Promise<void>
      closeAsk: () => Promise<void>
      ready: () => Promise<void>
      hover: (on: boolean) => void
      action: (key: string) => void
    }
  }
}

const STATUS: Record<State["status"], string> = {
  idle: "",
  reading: "Reading screenshots…",
  routing: "Matching to a thread…",
  thinking: "Thinking…",
  answering: "Answering…",
  error: "Error"
}

const HOTKEYS: [string, string][] = [
  ["S", "screenshot"],
  ["A", "choose area"],
  ["↩", "send now"],
  ["N", "new thread"],
  ["J", "join previous"],
  ["K", "ask"],
  ["←/→", "history"],
  ["↑/↓", "scroll"],
  ["I", "interactive"],
  ["P", "pause"],
  ["D", "sent text"],
  ["H", "hide"]
]

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [active])
  return now
}

export default function App() {
  const [s, setS] = useState<State | null>(null)
  const [q, setQ] = useState("")
  const body = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const now = useNow(!!s?.group.closesAt)

  useEffect(() => {
    const off1 = window.copilot.onState(setS)
    const off2 = window.copilot.onScroll((dy) => body.current?.scrollBy({ top: dy, behavior: "smooth" }))
    window.copilot.ready()
    return () => {
      off1()
      off2()
    }
  }, [])

  useEffect(() => {
    if (s?.asking) input.current?.focus()
  }, [s?.asking])

  if (!s) return null
  const hit = { onMouseEnter: () => window.copilot.hover(true), onMouseLeave: () => window.copilot.hover(false) }
  const its = s.thread?.iterations ?? []
  const idx = s.viewIndex < 0 ? its.length - 1 : s.viewIndex
  const showing = s.live || its[idx]?.answer || ""
  const secs = s.group.closesAt ? Math.max(0, Math.ceil((s.group.closesAt - now) / 1000)) : 0

  return (
    <div className={`panel ${s.interactive ? "interactive" : ""}`} style={{ ["--tint" as string]: s.opacity }}>
      {/* only the header and the scroll rail take the mouse; clicks anywhere else reach the app behind */}
      <header {...hit} onWheel={(e) => body.current?.scrollBy({ top: e.deltaY })}>
        <span className={`dot ${s.status}`} />
        <span className="title">{s.thread?.title ?? "No thread yet"}</span>
        {its.length > 0 && (
          <span className="pill">
            {s.live ? its.length + 1 : idx + 1}/{s.live ? its.length + 1 : its.length}
          </span>
        )}
        {s.group.count > 0 && (
          <span className="pill accent">
            📸 {s.group.count} · {secs}s
          </span>
        )}
        {s.group.paused && <span className="pill warn">paused</span>}
        <span className="tools">
          <button title="Choose capture area (⌃⌥⌘A)" onClick={() => window.copilot.action("A")}>
            ⌖ Area
          </button>
          {s.area && (
            <button title="Capture the whole screen instead (⌃⌥⌘⇧A)" onClick={() => window.copilot.action("Shift+A")}>
              ⛶
            </button>
          )}
          <button title="Screenshot now (⌃⌥⌘S)" onClick={() => window.copilot.action("S")}>
            📷
          </button>
          <button title="New thread (⌃⌥⌘N)" onClick={() => window.copilot.action("N")}>
            ＋
          </button>
          <button title="Hide panel (⌃⌥⌘H)" onClick={() => window.copilot.action("H")}>
            ✕
          </button>
        </span>
      </header>
      <div className="rail" {...hit} onWheel={(e) => body.current?.scrollBy({ top: e.deltaY })} />

      {s.notice && <div className="notice">{s.notice}</div>}
      {s.status !== "idle" && s.status !== "error" && <div className="status">{STATUS[s.status]}</div>}
      {s.error && <div className="error">{s.error}</div>}

      <div className="body" ref={body}>
        {s.showPayload ? (
          <>
            <div className="label">Last text sent to the model</div>
            <pre className="payload">{s.payload ?? "Nothing sent yet."}</pre>
          </>
        ) : showing ? (
          <Markdown text={showing} />
        ) : (
          <div className="help">
            <div className="label">⌃⌥⌘ +</div>
            {HOTKEYS.map(([k, v]) => (
              <div key={k} className="hk">
                <kbd>{k}</kbd> {v}
              </div>
            ))}
            <div className="label" style={{ marginTop: 10 }}>
              Area: {s.area ? `${s.area.width}×${s.area.height}` : "whole screen under cursor"}
            </div>
          </div>
        )}
      </div>

      {s.asking && (
        <form
          className="ask"
          onSubmit={(e) => {
            e.preventDefault()
            window.copilot.ask(q)
            setQ("")
          }}
        >
          <input
            ref={input}
            value={q}
            placeholder="Ask about this thread…  (Esc to close)"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQ("")
                window.copilot.closeAsk()
              }
            }}
          />
        </form>
      )}
    </div>
  )
}
