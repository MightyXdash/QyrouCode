import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import test from 'node:test'
import { RemoteCompletionClient } from '../src/main/remoteCompletionClient.js'

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not start')
  try {
    await run(`http://127.0.0.1:${address.port}/v1`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = ''
  for await (const chunk of request) body += chunk
  return JSON.parse(body) as Record<string, unknown>
}

test('sends OpenAI privacy and native reasoning controls without retaining reasoning', async () => {
  await withServer(async (request, response) => {
    assert.equal(request.url, '/v1/chat/completions')
    assert.equal(request.headers.authorization, 'Bearer secret-key')
    const body = await requestBody(request)
    assert.equal(body.model, 'gpt-5.6-sol')
    assert.equal(body.reasoning_effort, 'none')
    assert.equal(body.store, false)
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ choices: [{ message: { content: 'Done', reasoning_content: 'private' }, finish_reason: 'stop' }] }))
  }, async (baseUrl) => {
    const client = new RemoteCompletionClient({
      kind: 'openai',
      baseUrl,
      apiKey: 'secret-key',
      modelId: 'gpt-5.6-sol',
      retainReasoning: false,
      reasoning: { enabled: false, nativeEffort: 'none' }
    })
    const completion = await client.complete({ messages: [{ role: 'user', content: 'Hello' }] })
    assert.equal(completion.text, 'Done')
    assert.equal(completion.reasoningText, undefined)
  })
})

test('uses OpenRouter reasoning controls and retains allowlisted reasoning', async () => {
  await withServer(async (request, response) => {
    const body = await requestBody(request)
    assert.deepEqual(body.reasoning, { enabled: true, effort: 'high', max_tokens: 16384, exclude: false })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: '',
          reasoning_content: 'reasoning trace',
          tool_calls: [{ id: 'call-1', function: { name: 'read', arguments: '{"filePath":"src/index.ts"}' } }]
        },
        finish_reason: 'tool_calls'
      }]
    }))
  }, async (baseUrl) => {
    const client = new RemoteCompletionClient({
      kind: 'openrouter',
      baseUrl,
      apiKey: 'openrouter-key',
      modelId: 'qwen/qwen3.7-plus',
      retainReasoning: true,
      reasoning: { enabled: true, nativeEffort: 'high', maxTokens: 16384 }
    })
    const completion = await client.complete({ messages: [{ role: 'user', content: 'Inspect' }] })
    assert.equal(completion.reasoningText, 'reasoning trace')
    assert.deepEqual(completion.toolCalls, [{ id: 'call-1', name: 'read', arguments: { filePath: 'src/index.ts' } }])
  })
})

test('injects prompt fallback controls for compatible models', async () => {
  await withServer(async (request, response) => {
    const body = await requestBody(request)
    assert.deepEqual((body.messages as Array<Record<string, unknown>>)[0], { role: 'system', content: 'Use brief reasoning.' })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ choices: [{ message: { content: 'Ready' } }] }))
  }, async (baseUrl) => {
    const client = new RemoteCompletionClient({
      kind: 'openai-compatible',
      baseUrl,
      apiKey: 'custom-key',
      modelId: 'custom/model',
      retainReasoning: false,
      reasoning: { fallbackPrompt: 'Use brief reasoning.' }
    })
    const completion = await client.complete({ messages: [{ role: 'user', content: 'Hello' }] })
    assert.equal(completion.text, 'Ready')
  })
})

test('streams remote text and reconstructs fragmented tool calls', async () => {
  let requestCount = 0
  await withServer(async (request, response) => {
    requestCount += 1
    const body = await requestBody(request)
    assert.equal(body.stream, true)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_","function":{"name":"re","arguments":"{\\"file"}}]}}]}\n\n')
    response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"1","function":{"name":"ad","arguments":"Path\\":\\"src/index.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n')
    response.end('data: [DONE]\n\n')
  }, async (baseUrl) => {
    const client = new RemoteCompletionClient({
      kind: 'openai-compatible',
      baseUrl,
      apiKey: 'custom-key',
      modelId: 'custom/model',
      retainReasoning: false,
      reasoning: {}
    })
    const deltas: string[] = []
    const completion = await client.stream({ messages: [{ role: 'user', content: 'Inspect' }] }, (delta) => deltas.push(delta))
    assert.deepEqual(deltas, [])
    assert.deepEqual(completion.toolCalls, [{ id: 'call_1', name: 'read', arguments: { filePath: 'src/index.ts' } }])
  })
  assert.equal(requestCount, 1)
})
