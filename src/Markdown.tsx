import { useEffect, useId, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism"
import mermaid from "mermaid"

mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" })

function Mermaid({ code }: { code: string }) {
  const id = "m" + useId().replace(/[^a-zA-Z0-9]/g, "")
  const [svg, setSvg] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    // while the answer streams the diagram is often incomplete; keep the source visible until it parses
    mermaid
      .render(id, code)
      .then((r) => alive && setSvg(r.svg))
      .catch(() => alive && setSvg(null))
    return () => {
      alive = false
    }
  }, [code, id])
  if (!svg) return <Code lang="mermaid" code={code} />
  return <div className="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
}

function Code({ lang, code }: { lang: string; code: string }) {
  return (
    <div className="codeblock">
      {lang && <div className="lang">{lang}</div>}
      <SyntaxHighlighter
        language={lang || "text"}
        style={oneDark}
        customStyle={{ margin: 0, background: "transparent", padding: "8px 10px", fontSize: 12 }}
        codeTagProps={{ style: { fontFamily: "ui-monospace, Menlo, monospace" } }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  )
}

export default function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre: ({ children }) => <>{children}</>,
        code: ({ className, children }) => {
          const src = String(children ?? "")
          const lang = /language-([\w+-]+)/.exec(className || "")?.[1] ?? ""
          const block = !!lang || src.includes("\n")
          if (!block) return <code>{children}</code>
          const code = src.replace(/\n$/, "")
          return lang === "mermaid" ? <Mermaid code={code} /> : <Code lang={lang} code={code} />
        },
        a: ({ children, href }) => <span title={href}>{children}</span>
      }}
    >
      {text}
    </ReactMarkdown>
  )
}
