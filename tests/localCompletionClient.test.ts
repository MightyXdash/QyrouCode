import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import test from 'node:test'
import { LocalCompletionClient } from '../src/main/localCompletionClient.js'

const startServer = async (handler: (request: IncomingMessage, response: ServerResponse) => void) => {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

test('sends a bounded non-streaming OpenAI-compatible chat completion request', async () => {
  let receivedBody = ''
  const server = await startServer((request, response) => {
    request.on('data', (chunk: Buffer) => { receivedBody += chunk.toString() })
    request.on('end', () => {
      assert.equal(request.method, 'POST')
      assert.equal(request.url, '/v1/chat/completions')
      assert.equal(request.headers['content-type'], 'application/json')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: 'Hello from the local runtime.' } }] }))
    })
  })

  try {
    const client = new LocalCompletionClient(server.url)
    const completion = await client.complete({
      messages: [{ role: 'user', content: 'Reply with a short greeting.' }],
      maxTokens: 32,
      temperature: 0
    })

    assert.equal(completion.text, 'Hello from the local runtime.')
    assert.deepEqual(JSON.parse(receivedBody), {
      messages: [{ role: 'user', content: 'Reply with a short greeting.' }],
      stream: false,
      max_tokens: 32,
      temperature: 0
    })
  } finally {
    await server.close()
  }
})

test('returns a diagnostic error when the local runtime rejects a completion request', async () => {
  const server = await startServer((_request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'model is loading' } }))
  })

  try {
    const client = new LocalCompletionClient(server.url)
    await assert.rejects(
      client.complete({ messages: [{ role: 'user', content: 'Hello' }] }),
      /503.*model is loading/
    )
  } finally {
    await server.close()
  }
})
