import { Children, createElement, memo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'
import { Check, Copy } from 'lucide-react'

interface MarkdownMessageProps {
  content: string
  animateWords?: boolean
}

const remarkMathOptions = { singleDollarTextMath: false }

interface AnimatedMarkdownElementProps {
  node?: unknown
  children?: ReactNode
  [key: string]: unknown
}

interface WordSegment {
  index: number
  segment: string
}

function wordSegments(value: string): WordSegment[] {
  try {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
    return [...segmenter.segment(value)].flatMap((part) => part.isWordLike ? [{ index: part.index, segment: part.segment }] : [])
  } catch {
    return [...value.matchAll(/\S+/gu)].map((match) => ({ index: match.index, segment: match[0] }))
  }
}

function animatedText(value: string): ReactNode {
  const words = wordSegments(value)
  if (!words.length) return value
  return words.map((word, index) => {
    const start = index === 0 ? 0 : word.index
    const end = words[index + 1]?.index ?? value.length
    return <span className="assistant-word-fade" key={`${word.index}:${word.segment}`}>{value.slice(start, end)}</span>
  })
}

function animatedChildren(children: ReactNode): ReactNode {
  return Children.map(children, (child) => typeof child === 'string' ? animatedText(child) : child)
}

function animatedElement(tag: string): (props: AnimatedMarkdownElementProps) => JSX.Element {
  return function AnimatedMarkdownElement({ node: _node, children, ...props }: AnimatedMarkdownElementProps): JSX.Element {
    return createElement(tag, props, animatedChildren(children))
  }
}

const baseComponents = {
  a: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
  pre: ({ children, ...props }: React.ComponentProps<'pre'>) => <CodeBlock {...props}>{children}</CodeBlock>
}

const animatedComponents = {
  ...baseComponents,
  p: animatedElement('p'),
  h1: animatedElement('h1'),
  h2: animatedElement('h2'),
  h3: animatedElement('h3'),
  h4: animatedElement('h4'),
  h5: animatedElement('h5'),
  h6: animatedElement('h6'),
  li: animatedElement('li'),
  strong: animatedElement('strong'),
  em: animatedElement('em'),
  del: animatedElement('del'),
  blockquote: animatedElement('blockquote'),
  th: animatedElement('th'),
  td: animatedElement('td'),
  code: animatedElement('code'),
  a: ({ node: _node, children, ...props }: AnimatedMarkdownElementProps) => createElement('a', { ...props, target: '_blank', rel: 'noreferrer' }, animatedChildren(children))
}

function MarkdownMessage({ content, animateWords = false }: MarkdownMessageProps): JSX.Element {
  const hasAnimatedWords = useRef(false)
  if (animateWords) hasAnimatedWords.current = true
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, [remarkMath, remarkMathOptions]]}
      rehypePlugins={[rehypeKatex]}
      components={hasAnimatedWords.current ? animatedComponents : baseComponents}
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
