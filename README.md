# Screen Copilot

A fork of [free-cluely](https://github.com/Prat011/free-cluely). Take screenshots with a hotkey or a mouse button. They are grouped, turned into text and diagram crops on your Mac, redacted, and answered by Claude Opus on Vertex AI. The answer appears in an overlay that screen shares and recordings don't capture.

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
| `quietSeconds` / `maxGroupSeconds` | a group closes after 50s with no new shot, or 120s at most |
| `redact` / `redactRegex` | phrases (case- and spacing-insensitive) and regexes removed before anything is sent |
| `extractDiagrams` | send diagram regions as cropped images |
| `opacity` | panel tint over the blurred background |
| `gcpProject`, `gcpRegion`, `answerModel`, `routerModel`, `effort` | Vertex settings |

## Hotkeys (⌃⌥⌘ +)

`S` screenshot · `A` choose area · `⇧A` clear area · `↩` send now · `N` new thread · `J` move the last group back to the previous thread · `K` ask a follow-up · `←/→` previous/next answer · `↑/↓` scroll · `⇧+arrows` move the panel · `I` interactive (drag/click) · `-`/`=` opacity · `P` pause · `⌫` drop the last screenshot · `D` show the text that was sent · `H` hide

The panel lets clicks through to the apps behind it. Only the header (buttons: ⌖ Area, ⛶ whole screen, 📷 screenshot, ＋ new thread, ✕ hide) and a thin strip on the right edge (trackpad scroll) catch the mouse. The same actions are in the **SC** menu-bar item.

To use a Logitech mouse button, map it in Logi Options+ to the keystroke ⌃⌥⌘S.

The original screenshots never leave the Mac. Only the extracted, redacted text and the diagram crops are sent. Threads are stored in `~/.screen-copilot/threads/`.
