import { useEffect, useRef, useState } from "react"
import Markdown from "./Markdown"

type Iteration = { at: number; kind: string; answer: string; diagrams: number; question?: string }
type State = {
  status: "idle" | "reading" | "thinking" | "answering" | "error"
  error: string | null
  group: { count: number; closesAt: number | null; paused: boolean }
  notice: string | null
  thread: { id: string; title: string; iterations: Iteration[] } | null
  pending: { question?: string; shots: number } | null
  viewIndex: number
  live: string
  thinking: string
  statusSince: number
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
      typing: (on: boolean) => void
      ready: () => Promise<void>
      hover: (on: boolean) => void
      action: (key: string) => void
      drag: (phase: "start" | "move" | "end", x?: number, y?: number) => void
    }
  }
}

const STATUS: Record<State["status"], string> = {
  idle: "",
  reading: "Sending screenshots…",
  thinking: "Thinking…",
  answering: "Answering…",
  error: "Error"
}

const HOTKEYS: [string, string][] = [
  ["S", "screenshot"],
  ["A", "choose area"],
  ["↩", "send now"],
  ["E", "end session"],
  ["K", "type in the chat box"],
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
  const input = useRef<HTMLTextAreaElement>(null)
  const dragging = useRef(false)
  const now = useNow(!!s?.group.closesAt || (!!s && s.status !== "idle" && s.status !== "error"))

  useEffect(() => {
    const off1 = window.copilot.onState(setS)
    const off2 = window.copilot.onScroll((dy) => body.current?.scrollBy({ top: dy, behavior: "smooth" }))
    window.copilot.ready()
    return () => {
      off1()
      off2()
    }
  }, [])

  // ⌃⌥⌘K (or a click) gives the panel the keyboard; put the cursor in the chat box
  useEffect(() => {
    if (s?.asking) setTimeout(() => input.current?.focus(), 30)
  }, [s?.asking])

  useEffect(() => {
    if (s?.thinking && !s.live) body.current?.scrollTo({ top: body.current.scrollHeight })
  }, [s?.thinking, s?.live])

  if (!s) return null
  // the header and rail take the mouse while hovered; during a drag keep it even if the pointer outruns the panel
  const hit = {
    onMouseEnter: () => window.copilot.hover(true),
    onMouseLeave: () => !dragging.current && window.copilot.hover(false)
  }
  const drag = {
    onPointerDown: (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest("button")) return
      dragging.current = true
      e.currentTarget.setPointerCapture(e.pointerId)
      window.copilot.drag("start", e.screenX, e.screenY)
    },
    onPointerMove: (e: React.PointerEvent) => dragging.current && window.copilot.drag("move", e.screenX, e.screenY),
    onPointerUp: (e: React.PointerEvent) => {
      dragging.current = false
      window.copilot.drag("end")
      const r = e.currentTarget.getBoundingClientRect()
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) window.copilot.hover(false)
    }
  }
  const its = s.thread?.iterations ?? []
  const idx = s.viewIndex < 0 ? its.length - 1 : s.viewIndex
  const showing = s.live || its[idx]?.answer || ""
  // the question shown above the answer: the one being answered now, or the one for the turn in view
  const asked = s.live || (s.thinking && !s.live) ? s.pending?.question : s.viewIndex >= -1 ? its[idx]?.question : undefined
  const shots = s.live || s.thinking ? s.pending?.shots : its[idx]?.diagrams
  const send = () => {
    if (!q.trim()) return
    window.copilot.ask(q)
    setQ("")
    input.current?.blur()
  }
  const secs = s.group.closesAt ? Math.max(0, Math.ceil((s.group.closesAt - now) / 1000)) : 0

  return (
    <div className={`panel ${s.interactive ? "interactive" : ""}`} style={{ ["--tint" as string]: s.opacity }}>
      {/* only the header and the scroll rail take the mouse; clicks anywhere else reach the app behind */}
      <header {...hit} {...drag} onWheel={(e) => body.current?.scrollBy({ top: e.deltaY })}>
        <span className={`dot ${s.status}`} />
        <span className="title">{s.thread?.title ?? "New session"}</span>
        {its.length > 0 && (
          <span className="pill">
            {s.live ? its.length + 1 : idx + 1}/{s.live ? its.length + 1 : its.length}
          </span>
        )}
        {s.group.count > 0 && (
          <span className="pill accent">
            {s.group.count} screenshot{s.group.count > 1 ? "s" : ""} · sending in {secs}s
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
          <button title="End this session; the next screenshot starts a new one (⌃⌥⌘E)" onClick={() => window.copilot.action("E")}>
            End
          </button>
          <button className="hide" title="Hide panel — bring it back with ⌃⌥⌘H or the SC menu" onClick={() => window.copilot.action("H")}>
            ✕
          </button>
        </span>
      </header>
      <div className="rail" {...hit} onWheel={(e) => body.current?.scrollBy({ top: e.deltaY })} />


      {s.notice && <div className="notice">{s.notice}</div>}
      {s.status !== "idle" && s.status !== "error" && (
        <div className="status">
          {STATUS[s.status]} {s.statusSince ? `${Math.max(0, Math.floor((now - s.statusSince) / 1000))}s` : ""}
        </div>
      )}
      {s.error && <div className="error">{s.error}</div>}

      <div className="body" ref={body}>
        {s.showPayload ? (
          <>
            <div className="label">Last sent to the model</div>
            <pre className="payload">{s.payload ?? "Nothing sent yet."}</pre>
          </>
        ) : s.thinking && !s.live ? (
          <>
            {(asked || shots) && <Asked question={asked} shots={shots} />}
            <div className="thinking">
              <div className="label">Thinking…</div>
              <Markdown text={s.thinking} />
            </div>
          </>
        ) : showing ? (
          <>
            {(asked || (shots ?? 0) > 0) && <Asked question={asked} shots={shots} />}
            <Markdown text={showing} />
          </>
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

      {/* always there; only gets the keyboard while you're typing in it */}
      <form
        className={`chat ${s.asking ? "active" : ""}`}
        {...hit}
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <textarea
          ref={input}
          rows={1}
          value={q}
          placeholder={s.group.count ? `Add a question to the ${s.group.count} waiting screenshot(s)… Enter sends` : "Ask anything… Enter sends"}
          onMouseDown={() => window.copilot.typing(true)}
          onBlur={() => window.copilot.typing(false)}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              send()
            } else if (e.key === "Escape") {
              input.current?.blur()
            }
          }}
        />
      </form>
    </div>
  )
}

function Asked({ question, shots }: { question?: string; shots?: number }) {
  return (
    <div className="asked">
      {question && <div className="q">{question}</div>}
      {!!shots && <div className="shots">📷 {shots} screenshot{shots > 1 ? "s" : ""}</div>}
    </div>
  )
}
