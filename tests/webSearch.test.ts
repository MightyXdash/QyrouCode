import assert from 'node:assert/strict'
import test from 'node:test'
import { NoApiWebClient, formatWebSearchResults, parseDuckDuckGoResults } from '../src/main/webSearch.js'

const fixture = `
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Example Docs</a></h2>
  <a class="result__snippet">A useful &amp; current result.</a>
</div>`

test('parses and unwraps DuckDuckGo HTML results', () => {
  assert.deepEqual(parseDuckDuckGoResults(fixture), [{
    title: 'Example Docs',
    url: 'https://example.com/docs',
    snippet: 'A useful & current result.'
  }])
})

test('runs no-key web search with an injectable fetch transport', async () => {
  let requestedUrl = ''
  const fetcher = (async (input: string | URL | Request) => {
    requestedUrl = input.toString()
    return new Response(fixture, { status: 200, headers: { 'content-type': 'text/html' } })
  }) as typeof fetch
  const results = await new NoApiWebClient(fetcher).search('typescript agents', 3)
  assert.match(requestedUrl, /html\.duckduckgo\.com\/html\/\?q=typescript%20agents/)
  assert.match(formatWebSearchResults(results), /URL: https:\/\/example\.com\/docs/)
})
