# Screen Copilot

A fork of [free-cluely](https://github.com/Prat011/free-cluely). Take screenshots with a hotkey or a mouse button. They are grouped, turned into text and diagram crops on your Mac, redacted, and answered by Claude Opus on Vertex AI. The answer appears in an overlay that screen shares and recordings don't capture.

## Run it in the background

```bash
bin/sc start      # runs as a background service (no terminal needed); survives closing this session
bin/sc status     # running? starts at login?
bin/sc logs       # follow the log (screenshot added / group closed / answered / errors)
bin/sc stop       # quit it
bin/sc restart    # after pulling changes: bin/sc build && bin/sc restart
bin/sc login on   # also start it when you log in (off by default)
```

The service runs `/Applications/Screen Copilot.app`, signed once and never rebuilt; a fixed starter inside it loads this repo, so the Screen Recording grant survives code updates (`bin/sc build && bin/sc restart`). Only one copy runs at a time. The panel's ✕ hides it. Your next screenshot brings it back, and so do ⌃⌥⌘H, the SC menu, opening Screen Copilot from Applications/Spotlight, or `bin/sc show`. An answer that arrives while it's hidden doesn't reopen it; the menu bar shows **SC ●**. Drag the panel by its header.

Run `bin/sc start` from your normal terminal: it passes your `GOOGLE_APPLICATION_CREDENTIALS` (service account) to the service, so Vertex keeps working without re-signing in.

## Setup

```bash
npm install          # also builds native/bin/ocr (Apple Vision OCR)
gcloud auth application-default login
npm start
```

On first use, macOS asks for **Screen Recording** permission (for screenshots).

Settings live in `~/.screen-copilot/config.json` and are re-read on save:

| key | meaning |
|---|---|
| `inboxDir` | folder X: every image that lands here is processed (default `~/ScreenCopilot/inbox`) |
| `area` | saved capture area; `null` = the whole screen under the cursor |
| `quietSeconds` / `maxGroupSeconds` | a group closes 20s after the last screenshot (each new one restarts the wait); `maxGroupSeconds` 0 = no overall cap |
| `redact` / `redactRegex` | phrases (case- and spacing-insensitive) and regexes removed before anything is sent |
| `extractDiagrams` | send diagram regions as cropped images |
| `opacity` | panel tint over the blurred background |
| `gcpProject`, `gcpRegion`, `answerModel`, `routerModel`, `effort` | Vertex settings |

## Hotkeys (⌃⌥⌘ +)

`S` screenshot · `A` choose area · `⇧A` clear area · `↩` send now · `N` new thread · `J` move the last group back to the previous thread · `K` ask a follow-up · `←/→` previous/next answer · `↑/↓` scroll · `⇧+arrows` move the panel · `I` interactive (drag/click) · `-`/`=` opacity · `P` pause · `⌫` drop the last screenshot · `D` show the text that was sent · `H` hide

The panel lets clicks through to the apps behind it. Only the header (buttons: ⌖ Area, ⛶ whole screen, 📷 screenshot, ＋ new thread, ✕ hide) and a thin strip on the right edge (trackpad scroll) catch the mouse. The same actions are in the **SC** menu-bar item.

To use a Logitech mouse button, map it in Logi Options+ to the keystroke ⌃⌥⌘S.

The original screenshots never leave the Mac. Only the extracted, redacted text and the diagram crops are sent. Threads are stored in `~/.screen-copilot/threads/`.
