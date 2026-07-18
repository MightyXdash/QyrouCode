import assert from 'node:assert/strict'
import test from 'node:test'
import { TerminalTranscript } from '../src/main/terminalTranscript.js'

test('terminal transcript advances monotonic cursors and strips ANSI from model reads', () => {
  const transcript = new TerminalTranscript(1024, 1024)
  transcript.append('\u001b[32mready\u001b[0m\r\n')

  const read = transcript.read(0)

  assert.equal(read.output, 'ready\r\n')
  assert.equal(read.cursor, transcript.cursor)
  assert.equal(read.truncated, false)
  assert.match(transcript.replay(), /\u001b\[32m/u)
})

test('terminal transcript retains a bounded ring and reports stale cursors', () => {
  const transcript = new TerminalTranscript(8, 8)
  transcript.append('123456')
  transcript.append('7890')

  assert.equal(transcript.replay(), '34567890')
  assert.deepEqual(transcript.read(0), { output: '34567890', cursor: 10, truncated: true })
  assert.deepEqual(transcript.read(100), { output: '', cursor: 10, truncated: false })
})

test('terminal transcript paginates reads without losing cursor position', () => {
  const transcript = new TerminalTranscript(1024, 4)
  transcript.append('abcdefgh')

  const first = transcript.read(0)
  const second = transcript.read(first.cursor)

  assert.deepEqual(first, { output: 'abcd', cursor: 4, truncated: false })
  assert.deepEqual(second, { output: 'efgh', cursor: 8, truncated: false })
})
