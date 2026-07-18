const ANSI_SEQUENCE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu

export interface TerminalTranscriptRead {
  output: string
  cursor: number
  truncated: boolean
}

export class TerminalTranscript {
  private raw = ''
  private start = 0
  private position = 0

  constructor(private readonly capacity: number, private readonly maximumRead: number) {}

  get cursor(): number {
    return this.position
  }

  append(data: string): void {
    this.raw += data
    this.position += data.length
    if (this.raw.length <= this.capacity) return
    const removed = this.raw.length - this.capacity
    this.raw = this.raw.slice(removed)
    this.start += removed
  }

  replay(): string {
    return this.raw
  }

  read(cursor = this.start, limit = this.maximumRead): TerminalTranscriptRead {
    const requested = Math.max(0, Math.floor(cursor))
    const from = Math.min(this.position, Math.max(requested, this.start))
    const offset = from - this.start
    const raw = this.raw.slice(offset, offset + Math.min(this.maximumRead, Math.max(1, limit)))
    return {
      output: raw.replace(ANSI_SEQUENCE, ''),
      cursor: from + raw.length,
      truncated: requested < this.start
    }
  }
}
