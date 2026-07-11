import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'

interface MarkdownMessageProps {
  content: string
}

function MarkdownMessage({ content }: MarkdownMessageProps): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>
      }}
    >
      {content}
    </ReactMarkdown>
  )
}

export default memo(MarkdownMessage)
