import { memo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'
import { Check, Copy } from 'lucide-react'

interface MarkdownMessageProps {
  content: string
}

const remarkMathOptions = { singleDollarTextMath: false }

function MarkdownMessage({ content }: MarkdownMessageProps): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, [remarkMath, remarkMathOptions]]}
      rehypePlugins={[rehypeKatex]}
      components={{
        a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
        pre: ({ children, ...props }) => <CodeBlock {...props}>{children}</CodeBlock>
      }}
    >
      {content}
    </ReactMarkdown>
  )
}

function CodeBlock({ children, ...props }: React.ComponentProps<'pre'>): JSX.Element {
  const [copied, setCopied] = useState(false)
  const code = extractText(children)

  async function copyCode(): Promise<void> {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div className="markdown-code-block">
      <button className="markdown-code-copy" type="button" onClick={copyCode} title={copied ? 'Copied' : 'Copy code'} aria-label={copied ? 'Code copied' : 'Copy code'}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      <pre {...props}>{children}</pre>
    </div>
  )
}

function extractText(value: React.ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(extractText).join('')
  if (value && typeof value === 'object' && 'props' in value) return extractText(value.props.children)
  return ''
}

export default memo(MarkdownMessage)
