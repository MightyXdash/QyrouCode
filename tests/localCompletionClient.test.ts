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
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false }
    })
  } finally {
    await server.close()
  }
})

test('sends multimodal image content to the local OpenAI-compatible endpoint', async () => {
  let receivedBody = ''
  const server = await startServer((request, response) => {
    request.on('data', (chunk: Buffer) => { receivedBody += chunk.toString() })
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: 'I can see the image.' } }] }))
    })
  })

  try {
    const imageUrl = 'data:image/png;base64,iVBORw0KGgo='
    const completion = await new LocalCompletionClient(server.url).complete({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is shown here?' },
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }]
    })
    const body = JSON.parse(receivedBody)
    assert.equal(body.messages[0].content[0].text, 'What is shown here?')
    assert.equal(body.messages[0].content[1].image_url.url, imageUrl)
    assert.equal(completion.text, 'I can see the image.')
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

test('emits deltas from a fragmented server-sent event response', async () => {
  const server = await startServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"choices":[{"delta":{"content":"Qyrou"}}]}\n\n')
    response.write('data: {"choices":[{"delta":{"content":"Code"}}]}\n\n')
    response.end('data: [DONE]\n\n')
  })

  try {
    const deltas: string[] = []
    const client = new LocalCompletionClient(server.url)
    const completion = await client.stream(
      { messages: [{ role: 'user', content: 'Stream a response.' }] },
      (delta) => deltas.push(delta)
    )
    assert.deepEqual(deltas, ['Qyrou', 'Code'])
    assert.equal(completion.text, 'QyrouCode')
    assert.deepEqual(completion.toolCalls, [])
  } finally {
    await server.close()
  }
})

test('reconstructs fragmented streamed reasoning and tool calls', async () => {
  const server = await startServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"choices":[{"delta":{"reasoning_content":"checking ","tool_calls":[{"index":0,"id":"call_","function":{"name":"re","arguments":"{\\"file"}}]}}]}\n\n')
    response.write('data: {"choices":[{"delta":{"reasoning_content":"files","tool_calls":[{"index":0,"id":"1","function":{"name":"ad","arguments":"Path\\":\\"src/app.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n')
    response.end('data: [DONE]\n\n')
  })

  try {
    const generatedCharacters: number[] = []
    const completion = await new LocalCompletionClient(server.url).stream(
      { messages: [{ role: 'user', content: 'Inspect the app.' }], enableThinking: true },
      () => {},
      (characters) => generatedCharacters.push(characters)
    )
    assert.equal(completion.reasoningText, 'checking files')
    assert.equal(completion.finishReason, 'tool_calls')
    assert.deepEqual(completion.toolCalls, [{ id: 'call_1', name: 'read', arguments: { filePath: 'src/app.ts' } }])
    assert.equal(
      generatedCharacters.reduce((total, characters) => total + characters, 0),
      'checking files'.length + 'read'.length + '{"filePath":"src/app.ts"}'.length
    )
  } finally {
    await server.close()
  }
})

test('sends tool schemas and parses native local-model tool calls', async () => {
  let receivedBody = ''
  const server = await startServer((request, response) => {
    request.on('data', (chunk: Buffer) => { receivedBody += chunk.toString() })
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"filePath":"src/app.ts"}' } }]
          }
        }]
      }))
    })
  })

  try {
    const client = new LocalCompletionClient(server.url)
    const completion = await client.complete({
      messages: [{ role: 'user', content: 'Inspect the app.' }],
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] } }]
    })
    const body = JSON.parse(receivedBody)
    assert.equal(body.tool_choice, 'auto')
    assert.equal(body.tools[0].function.name, 'read')
    assert.equal(completion.text, '')
    assert.equal(completion.finishReason, 'tool_calls')
    assert.deepEqual(completion.toolCalls, [{ id: 'call_1', name: 'read', arguments: { filePath: 'src/app.ts' } }])
  } finally {
    await server.close()
  }
})

test('preserves reasoning-only completions for agent recovery without exposing them as assistant text', async () => {
  const server = await startServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { content: null, reasoning_content: 'private model reasoning' }
      }]
    }))
  })

  try {
    const completion = await new LocalCompletionClient(server.url).complete({
      messages: [{ role: 'user', content: 'Inspect the project.' }],
      enableThinking: true
    })
    assert.equal(completion.text, '')
    assert.equal(completion.reasoningText, 'private model reasoning')
    assert.deepEqual(completion.toolCalls, [])
  } finally {
    await server.close()
  }
})

test('rejects reasoning-only completions when thinking is disabled', async () => {
  const server = await startServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { content: null, reasoning_content: 'private model reasoning' }
      }]
    }))
  })

  try {
    await assert.rejects(
      new LocalCompletionClient(server.url).complete({
        messages: [{ role: 'user', content: 'Answer directly.' }],
        enableThinking: false
      }),
      /only reasoning while thinking was disabled/
    )
  } finally {
    await server.close()
  }
})

test('accepts up to 8192 output tokens', async () => {
  const server = await startServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: 'Complete' } }] }))
  })

  try {
    const client = new LocalCompletionClient(server.url)
    const completion = await client.complete({ messages: [{ role: 'user', content: 'Write a longer response.' }], maxTokens: 8192 })
    assert.equal(completion.text, 'Complete')
  } finally {
    await server.close()
  }
})

test('uses the raw completion endpoint for chat titles', async () => {
  let receivedBody = ''
  const server = await startServer((request, response) => {
    request.on('data', (chunk: Buffer) => { receivedBody += chunk.toString() })
    request.on('end', () => {
      assert.equal(request.url, '/completion')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ content: 'Streaming Local Responses' }))
    })
  })

  try {
    const client = new LocalCompletionClient(server.url)
    const completion = await client.completePrompt({
      prompt: 'User: Make local streaming work\nTitle: ',
      maxTokens: 10,
      temperature: 0.55,
      topK: 15,
      topP: 0.85,
      repetitionPenalty: 1.35
    })
    assert.equal(completion.text, 'Streaming Local Responses')
    assert.deepEqual(JSON.parse(receivedBody), {
      prompt: 'User: Make local streaming work\nTitle: ',
      n_predict: 10,
      temperature: 0.55,
      top_k: 15,
      top_p: 0.85,
      repeat_penalty: 1.35,
      stream: false
    })
  } finally {
    await server.close()
  }
})
