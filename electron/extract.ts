import { execFile } from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import sharp from "sharp"
import { getConfig } from "./config"

type Box = [number, number, number, number] // x, y, w, h in image pixels, top-left origin
type OcrLine = { text: string; box: Box }
type Ocr = {
  width: number
  height: number
  paragraphs: { text: string; box: Box; lines: OcrLine[] }[]
  lists: { box: Box; items: string[] }[]
  tables: { box: Box; rows: string[][] }[]
}

export type Diagram = { png: string; caption: string } // png is base64
export type Extracted = { file: string; markdown: string; diagrams: Diagram[]; redactions: number }

function ocrBinary(): string {
  const dev = path.join(__dirname, "..", "native", "bin", "ocr")
  const packaged = path.join(process.resourcesPath || "", "native", "bin", "ocr")
  return fs.existsSync(dev) ? dev : packaged
}

function runOcr(file: string): Promise<Ocr> {
  return new Promise((resolve, reject) => {
    execFile(ocrBinary(), [file], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message))
      resolve(JSON.parse(stdout))
    })
  })
}

// ---------- redaction ----------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function rules(): RegExp[] {
  const { redact, redactRegex } = getConfig()
  const out: RegExp[] = []
  // OCR sometimes splits or joins words ("Life Vantage"), so phrases match with any spacing
  const loose = (p: string) => [...p.replace(/\s+/g, "")].map(escapeRe).join("\\s*")
  for (const p of redact) if (p.trim()) out.push(new RegExp(loose(p.trim()), "gi"))
  for (const r of redactRegex) {
    try {
      out.push(new RegExp(r, "gi"))
    } catch {
      console.warn("[redact] bad regex skipped:", r)
    }
  }
  return out
}

export function redact(text: string): { text: string; count: number } {
  let count = 0
  for (const re of rules()) {
    text = text.replace(re, () => {
      count++
      return "[redacted]"
    })
  }
  return { text, count }
}

// ---------- layout → Markdown ----------

const inside = (a: Box, b: Box, slack = 4) =>
  a[0] >= b[0] - slack && a[1] >= b[1] - slack && a[0] + a[2] <= b[0] + b[2] + slack && a[1] + a[3] <= b[1] + b[3] + slack

const CODE_SYMBOL = /[{};]|=>|===?|!=|::|\w\(.*\)|^\s*(\$ |>>> |\/\/|#include|at \S+ ?\(|Traceback)|^\w*(Error|Exception)\b.*:/
const CODE_KEYWORD = /^\s*(const|let|var|def|class|import|from|return|function|public|private|async|await|if|for|while|try|catch|SELECT|UPDATE|INSERT)\b/

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

// Rebuild indentation from where each line starts, so code keeps its shape.
function codeBlock(lines: OcrLine[]): string {
  const charW = median(lines.map((l) => l.box[2] / Math.max(1, l.text.length))) || 8
  const minX = Math.min(...lines.map((l) => l.box[0]))
  const body = lines
    .map((l) => " ".repeat(Math.max(0, Math.round((l.box[0] - minX) / charW))) + l.text)
    .join("\n")
  return "```\n" + body + "\n```"
}

function tableMd(rows: string[][]): string {
  if (!rows.length) return ""
  const width = Math.max(...rows.map((r) => r.length))
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")].map((c) => c.replace(/\|/g, "\\|").replace(/\n/g, " "))
  const [head, ...rest] = rows.map(pad)
  return [`| ${head.join(" | ")} |`, `|${" --- |".repeat(width)}`, ...rest.map((r) => `| ${r.join(" | ")} |`)].join("\n")
}

type Atom = { box: Box; text: string; para: number; md?: string } // md set = ready-made block (list/table)
type Row = { top: number; bottom: number; atoms: Atom[] }
type Region = { atoms: Atom[]; label: string | null; panel: number }

// OCR reads icons as stray symbols ("†i‡", "<>", "©"); drop those and strip them off the front of labels.
const ICON_LEAD = /^[\s©®†‡<>~^¶§%!&•·*#|]+(?=[A-Za-z0-9])/
function clean(text: string): string | null {
  const t = text.replace(ICON_LEAD, "").trim()
  return (t.match(/[A-Za-z0-9]/g) ?? []).length < 2 ? null : t
}

const bbox = (atoms: Atom[]): Box => {
  const x0 = Math.min(...atoms.map((a) => a.box[0])), y0 = Math.min(...atoms.map((a) => a.box[1]))
  const x1 = Math.max(...atoms.map((a) => a.box[0] + a.box[2])), y1 = Math.max(...atoms.map((a) => a.box[1] + a.box[3]))
  return [x0, y0, x1 - x0, y1 - y0]
}

// Gaps in coverage along one axis, as cut positions.
function gaps(atoms: Atom[], axis: 0 | 1, minGap: number): { at: number; size: number }[] {
  const spans = atoms.map((a) => [a.box[axis], a.box[axis] + a.box[axis + 2]]).sort((p, q) => p[0] - q[0])
  const cuts: { at: number; size: number }[] = []
  let end = spans[0][1]
  for (const [s, e] of spans.slice(1)) {
    if (s - end >= minGap) cuts.push({ at: (s + end) / 2, size: s - end })
    end = Math.max(end, e)
  }
  return cuts
}

const split = (atoms: Atom[], axis: 0 | 1, cuts: number[]): Atom[][] => {
  const bounds = [-Infinity, ...cuts, Infinity]
  return bounds.slice(1).map((end, i) => atoms.filter((a) => a.box[axis] >= bounds[i] && a.box[axis] < end)).filter((g) => g.length)
}

// Side-by-side columns whose lines sit on the same rows are a form or table, not separate panels.
// Tight tolerance on the shorter column: dense code beside a file tree lines up only by chance.
function rowAligned(cols: Atom[][], lineH: number): boolean {
  const [short, long] = cols[0].length <= cols[1].length ? cols : [cols[1], cols[0]]
  const mids = long.map((a) => a.box[1] + a.box[3] / 2)
  if (long.length > 1.4 * short.length) return false // a form's columns have about as many rows
  const hit = short.filter((a) => mids.some((m) => Math.abs(m - (a.box[1] + a.box[3] / 2)) < 0.4 * lineH)).length
  return hit / short.length > 0.7
}

// Recursive XY-cut: split into side-by-side panels where possible, otherwise into bands, and recurse.
// The first panel split names each panel; everything nested inside keeps that name and panel id.
let panelSeq = 0
function regions(atoms: Atom[], width: number, lineH: number, label: string | null = null, panel = -1, depth = 0): Region[] {
  if (atoms.length < 2 || depth > 6) return [{ atoms, label, panel }]
  // wide gutters always split; narrower ones (a heading close to a column) only outside code,
  // where aligned trailing comments leave gaps inside lines
  const codeHeavy = atoms.filter((a) => CODE_SYMBOL.test(a.text) || CODE_KEYWORD.test(a.text)).length / atoms.length > 0.5
  const wide = Math.max(width * 0.02, 2 * lineH)
  const vg = gaps(atoms, 0, 1.2 * lineH).filter((g) => g.size >= wide || !codeHeavy)
  // neighbouring columns that share rows (label | value) stay together; split only between the rest
  const cols: Atom[][] = []
  for (const c of split(atoms, 0, vg.map((g) => g.at))) {
    const prev = cols[cols.length - 1]
    if (prev && rowAligned([prev, c], lineH)) cols[cols.length - 1] = [...prev, ...c]
    else cols.push(c)
  }
  if (cols.length > 1) {
    const widths = cols.map((c) => bbox(c)[2])
    const main = widths.indexOf(Math.max(...widths))
    // only columns that run a good part of the height are panels; a lone button at the edge is not
    const h = bbox(atoms)[3]
    const real = cols.filter((c) => bbox(c)[3] >= 0.3 * h).length >= 2
    return cols.flatMap((c, i) => {
      if (label || !real) return regions(c, width, lineH, label, panel, depth + 1)
      const own = i === main ? "Main" : i < main ? "Left panel" : "Right panel"
      return regions(c, width, lineH, own, panelSeq++, depth + 1)
    })
  }
  // only the big gaps (under a header, between sections), so a sidebar's spacing doesn't slice the page
  const hg = gaps(atoms, 1, 1.2 * lineH)
  const big = Math.max(0, ...hg.map((g) => g.size))
  const bands = split(atoms, 1, hg.filter((g) => g.size >= 0.6 * big).map((g) => g.at))
  if (bands.length < 2) return [{ atoms, label, panel }]
  return bands.flatMap((b) => regions(b, width, lineH, label, panel, depth + 1))
}

function rows(atoms: Atom[]): Row[] {
  const out: Row[] = []
  for (const a of [...atoms].sort((p, q) => p.box[1] - q.box[1])) {
    const mid = a.box[1] + a.box[3] / 2
    const row = out.find((r) => mid > r.top && mid < r.bottom && !a.md && !r.atoms[0].md)
    if (row) {
      row.atoms.push(a)
      row.top = Math.min(row.top, a.box[1])
      row.bottom = Math.max(row.bottom, a.box[1] + a.box[3])
    } else out.push({ top: a.box[1], bottom: a.box[1] + a.box[3], atoms: [a] })
  }
  for (const r of out) r.atoms.sort((p, q) => p.box[0] - q.box[0])
  // editor line numbers: a leading number in most rows is gutter, not content
  const numbered = out.filter((r) => r.atoms.length > 1 && /^\d{1,5}$/.test(r.atoms[0].text)).length
  if (numbered >= 3 && numbered / out.length > 0.5) for (const r of out) if (r.atoms.length > 1 && /^\d{1,5}$/.test(r.atoms[0].text)) r.atoms.shift()
  return out.filter((r) => !(r.atoms.length === 1 && /^\d{1,5}$/.test(r.atoms[0].text) && numbered >= 3))
}

// "Type:" "Bug" "Resolution:" "Fixed" → "Type: Bug · Resolution: Fixed"
function fieldRow(atoms: Atom[]): string | null {
  if (!atoms.some((a) => /:$/.test(a.text))) return null
  const parts: string[] = []
  for (let i = 0; i < atoms.length; i++) {
    if (/:$/.test(atoms[i].text) && atoms[i + 1] && !/:$/.test(atoms[i + 1].text))
      parts.push(`${atoms[i].text} ${atoms[++i].text.replace(/^- /, "")}`)
    else parts.push(atoms[i].text)
  }
  return parts.join(" · ")
}

// A narrow panel of short single items (file tree, nav) reads best as an indented list.
function treeList(rs: Row[], lineH: number): string | null {
  const items = rs.filter((r) => !r.atoms[0].md)
  if (items.length < 3 || items.some((r) => r.atoms.length > 2 || r.atoms[0].text.length > 48)) return null
  // indent levels = distinct start positions (icons shift each name a little, so group nearby ones)
  const xs = [...new Set(items.map((r) => Math.round(r.atoms[0].box[0])))].sort((a, b) => a - b)
  const stops: number[] = []
  for (const x of xs) if (!stops.length || x - stops[stops.length - 1] > 0.3 * lineH) stops.push(x)
  const levelOf = (x: number) => stops.filter((st) => st <= x + 0.3 * lineH).length - 1
  const raw = items.map((r) => levelOf(r.atoms[0].box[0]))
  // a tree goes at most one level deeper per item; the first item is the root
  let level = 0
  return items
    .map((r, i) => {
      if (i > 0) level = Math.max(0, Math.min(level + 1, level + raw[i] - raw[i - 1]))
      return "  ".repeat(level) + "- " + r.atoms.map((a) => a.text).join(" · ")
    })
    .join("\n")
}

function regionMarkdown(rs: Row[], lineH: number): string[] {
  const out: string[] = []
  let i = 0
  while (i < rs.length) {
    const r = rs[i]
    if (r.atoms[0].md) {
      out.push(r.atoms[0].md)
      i++
      continue
    }
    const n = r.atoms.length
    if (n >= 2) {
      const field = fieldRow(r.atoms)
      if (field) {
        out.push(field)
        i++
        continue
      }
      // rows with the same number (2+) of cells in a row form a table
      let j = i
      while (j < rs.length && rs[j].atoms.length === n && !rs[j].atoms[0].md && !fieldRow(rs[j].atoms)) j++
      if (j - i >= 2) out.push(tableMd(rs.slice(i, j).map((x) => x.atoms.map((a) => a.text))))
      else out.push(r.atoms.map((a) => a.text).join(" · "))
      i = Math.max(j, i + 1)
      continue
    }
    // a run of tightly spaced single-cell rows is either code or prose
    let j = i + 1
    while (j < rs.length && rs[j].atoms.length === 1 && !rs[j].atoms[0].md && rs[j].top - rs[j - 1].bottom < 0.7 * lineH) j++
    const run = rs.slice(i, j).map((x) => x.atoms[0])
    const codeish = run.filter((a) => CODE_SYMBOL.test(a.text) || CODE_KEYWORD.test(a.text)).length
    if (run.length >= 2 && codeish / run.length >= 0.5 && run.some((a) => CODE_SYMBOL.test(a.text))) {
      out.push(codeBlock(run.map((a) => ({ text: a.text, box: a.box }))))
    } else {
      let para: string[] = []
      let pid = -1
      const flush = () => {
        if (para.length) out.push(para.join(" ").replace(/\s+/g, " ").trim())
        para = []
      }
      for (const a of run) {
        const heading = a.box[3] > 1.35 * lineH && a.text.length < 80 && /[A-Za-z]{3}/.test(a.text) && !/^[-•*·]/.test(a.text)
        if (heading) {
          flush()
          out.push(`### ${a.text}`)
          pid = -1
          continue
        }
        if (a.para !== pid) flush()
        pid = a.para
        para.push(a.text)
      }
      flush()
    }
    i = j
  }
  return out
}

// Editors colour keywords separately, so OCR splits a code line into pieces; a region that is
// mostly code is rebuilt row by row (pieces re-joined by their gaps) as one block.
function codeRegion(rs: Row[]): string | null {
  const plain = rs.filter((r) => !r.atoms[0].md)
  if (plain.length < 4) return null
  const line = (r: Row) => r.atoms.map((a) => a.text).join(" ")
  const codeish = plain.filter((r) => CODE_SYMBOL.test(line(r)) || CODE_KEYWORD.test(line(r))).length
  if (codeish / plain.length < 0.6) return null
  const charW = median(plain.flatMap((r) => r.atoms.map((a) => a.box[2] / Math.max(1, a.text.length)))) || 8
  const lineH = median(plain.map((r) => r.bottom - r.top)) || 20
  const minX = Math.min(...plain.map((r) => r.atoms[0].box[0]))
  const body: string[] = []
  plain.forEach((r, i) => {
    if (i > 0 && r.top - plain[i - 1].bottom > 0.9 * lineH) body.push("") // blank source line
    let text = " ".repeat(Math.max(0, Math.round((r.atoms[0].box[0] - minX) / charW)))
    r.atoms.forEach((a, k) => {
      if (k > 0) {
        const prev = r.atoms[k - 1]
        text += " ".repeat(Math.max(1, Math.round((a.box[0] - prev.box[0] - prev.box[2]) / charW)))
      }
      text += a.text
    })
    body.push(text)
  })
  return "```\n" + body.join("\n") + "\n```"
}

function toMarkdown(ocr: Ocr, skip: Box[]): string {
  const keep = (b: Box) => !skip.some((s) => inside(b, s))
  const blocks: Atom[] = ocr.tables.filter((t) => keep(t.box)).map((t) => ({ box: t.box, text: "", para: -1, md: tableMd(t.rows) }))
  // list items become ordinary lines (boxes split evenly) so they pair with labels beside them ("Type:" "Bug")
  const listAtoms: Atom[] = ocr.lists.filter((l) => keep(l.box)).flatMap((l, li) =>
    l.items.map((item, k) => {
      const h = l.box[3] / l.items.length
      const bullet = /^\s*[•◦▪\-*·]/.test(item)
      const text = item.replace(/^\s*[•◦▪\-*·]\s*/, "")
      return { box: [l.box[0], l.box[1] + k * h, l.box[2], h] as Box, text: bullet ? `- ${text}` : text, para: -100 - li }
    })
  )
  const listBoxes = ocr.lists.map((l) => l.box)
  const atoms: Atom[] = [...blocks, ...listAtoms]
  ocr.paragraphs.forEach((p, pi) => {
    for (const l of p.lines.length ? p.lines : [{ text: p.text, box: p.box }]) {
      if (!keep(l.box) || blocks.some((b) => inside(l.box, b.box)) || listBoxes.some((b) => inside(l.box, b))) continue
      const text = clean(l.text)
      if (text) atoms.push({ box: l.box, text, para: pi })
    }
  })
  if (!atoms.length) return ""
  const lineH = median(atoms.filter((a) => !a.md).map((a) => a.box[3])) || 20
  const out: string[] = []
  panelSeq = 0
  const regs = regions(atoms, ocr.width, lineH)
  for (let i = 0; i < regs.length; ) {
    // consecutive pieces of one panel are rendered together under one name
    let j = i + 1
    while (j < regs.length && regs[i].panel >= 0 && regs[j].panel === regs[i].panel) j++
    const group = regs.slice(i, j)
    i = j
    const all = group.flatMap((g) => g.atoms)
    const box = bbox(all)
    const label = group[0].label
    if (label && box[3] > ocr.height * 0.12) out.push(`#### ${label}`)
    // a narrow side panel of short items (file tree, nav) reads best as an indented list
    const tree = label && label !== "Main" && box[2] < ocr.width * 0.3 ? treeList(rows(all), lineH) : null
    if (tree) {
      out.push(tree)
      continue
    }
    for (const g of group) {
      if (g.atoms.length >= 3 && g.atoms.every((a) => /^\d{1,5}$/.test(a.text))) continue // editor line numbers
      const rs = rows(g.atoms)
      if (!rs.length) continue
      const code = codeRegion(rs)
      out.push(...(code ? [code] : regionMarkdown(rs, lineH)))
    }
  }
  return out.join("\n\n").trim()
}

// ---------- diagrams ----------

// Drawn content (strokes, shapes, arrows) that is not text and has only sparse labels is kept as an image.
async function findDiagrams(file: string, ocr: Ocr): Promise<Box[]> {
  const W = 800
  const scale = W / ocr.width
  const { data, info } = await sharp(file).greyscale().resize({ width: W }).raw().toBuffer({ resolveWithObject: true })
  const w = info.width, h = info.height
  // edges, not filled areas: a dark code panel is one rectangle outline, not a solid blob
  const ink = new Uint8Array(w * h)
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      if (Math.abs(data[i + 1] - data[i - 1]) + Math.abs(data[i + w] - data[i - w]) > 30) ink[i] = 1
    }
  const lines = ocr.paragraphs.flatMap((p) => p.lines)
  for (const l of lines) {
    const [x, y, bw, bh] = l.box.map((v) => v * scale)
    for (let yy = Math.max(0, Math.floor(y) - 2); yy < Math.min(h, Math.ceil(y + bh) + 2); yy++)
      for (let xx = Math.max(0, Math.floor(x) - 2); xx < Math.min(w, Math.ceil(x + bw) + 2); xx++) ink[yy * w + xx] = 0
  }

  const C = 12
  const gw = Math.ceil(w / C), gh = Math.ceil(h / C)
  const busy = new Uint8Array(gw * gh)
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      let n = 0
      for (let y = gy * C; y < Math.min(h, gy * C + C); y++) for (let x = gx * C; x < Math.min(w, gx * C + C); x++) n += ink[y * w + x]
      if (n >= 3) busy[gy * gw + gx] = 1
    }

  const seen = new Uint8Array(gw * gh)
  const found: { box: Box; cells: number }[] = []
  for (let start = 0; start < busy.length; start++) {
    if (!busy[start] || seen[start]) continue
    let minX = gw, minY = gh, maxX = 0, maxY = 0, cells = 0
    const stack = [start]
    seen[start] = 1
    while (stack.length) {
      const c = stack.pop()!
      const cx = c % gw, cy = Math.floor(c / gw)
      cells++
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx); minY = Math.min(minY, cy); maxY = Math.max(maxY, cy)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue
          const n = ny * gw + nx
          if (busy[n] && !seen[n]) {
            seen[n] = 1
            stack.push(n)
          }
        }
    }
    const pad = 12
    const x = Math.max(0, (minX * C) / scale - pad), y = Math.max(0, (minY * C) / scale - pad)
    const box: Box = [x, y, Math.min(ocr.width - x, ((maxX - minX + 1) * C) / scale + 2 * pad), Math.min(ocr.height - y, ((maxY - minY + 1) * C) / scale + 2 * pad)]
    if (box[2] >= 0.15 * ocr.width && box[3] >= 0.15 * ocr.height && cells >= 25) found.push({ box, cells })
  }
  // A region dense with text is UI or a code panel, not a diagram.
  const textCover = (r: Box) => lines.filter((l) => inside(l.box, r, 2)).reduce((a, l) => a + l.box[2] * l.box[3], 0) / (r[2] * r[3])
  return found
    .map((f) => f.box)
    .filter((r) => textCover(r) < 0.12)
    .sort((a, b) => b[2] * b[3] - a[2] * a[3])
    .slice(0, 4)
}

async function cropDiagram(file: string, box: Box, ocr: Ocr): Promise<{ diagram: Diagram; count: number }> {
  const x = Math.floor(box[0]), y = Math.floor(box[1])
  const w = Math.min(Math.round(box[2]), Math.floor(ocr.width) - x)
  const h = Math.min(Math.round(box[3]), Math.floor(ocr.height) - y)
  const labels: string[] = []
  const masks: Buffer[] = []
  let count = 0
  for (const p of ocr.paragraphs)
    for (const l of p.lines) {
      if (!inside(l.box, box, 2)) continue
      const r = redact(l.text)
      labels.push(r.text)
      if (r.count) {
        count += r.count
        const [lx, ly, lw, lh] = l.box.map(Math.round)
        masks.push(
          Buffer.from(`<rect x="${lx - x - 2}" y="${ly - y - 2}" width="${lw + 4}" height="${lh + 4}" fill="black"/>`)
        )
      }
    }
  let img = sharp(file).extract({ left: x, top: y, width: w, height: h })
  if (masks.length) {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${masks.join("")}</svg>`)
    // sharp resizes before compositing within one pipeline, so mask first in its own pass
    img = sharp(await sharp(await img.png().toBuffer()).composite([{ input: svg }]).png().toBuffer())
  }
  const png = await img.resize({ width: Math.min(w, 1600), withoutEnlargement: true }).png().toBuffer()
  const caption = labels.length ? `Diagram labels: ${labels.join(" · ")}` : "Diagram"
  return { diagram: { png: png.toString("base64"), caption }, count }
}

// ---------- entry ----------

export async function extract(file: string): Promise<Extracted> {
  const ocr = await runOcr(file)
  const regions = getConfig().extractDiagrams ? await findDiagrams(file, ocr) : []
  const diagrams: Diagram[] = []
  let redactions = 0
  for (const r of regions) {
    const { diagram, count } = await cropDiagram(file, r, ocr)
    diagrams.push(diagram)
    redactions += count
  }
  const md = redact(toMarkdown(ocr, regions))
  redactions += md.count
  return { file, markdown: md.text, diagrams, redactions }
}
