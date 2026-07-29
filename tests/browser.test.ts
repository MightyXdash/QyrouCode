import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BROWSER_NEW_TAB_URL,
  DEFAULT_BROWSER_STATE,
  MAX_BROWSER_PANEL_WIDTH,
  MIN_BROWSER_PANEL_WIDTH,
  normalizeBrowserInput,
  normalizePersistedBrowserState
} from '../src/shared/browser.js'

test('normalizes web addresses and local development URLs', () => {
  assert.equal(normalizeBrowserInput('https://example.com/docs'), 'https://example.com/docs')
  assert.equal(normalizeBrowserInput('example.com/docs'), 'https://example.com/docs')
  assert.equal(normalizeBrowserInput('localhost:5173'), 'http://localhost:5173/')
  assert.equal(normalizeBrowserInput('127.0.0.1:3000/app'), 'http://127.0.0.1:3000/app')
  assert.equal(normalizeBrowserInput(''), BROWSER_NEW_TAB_URL)
})

test('turns ordinary text into a real Google search', () => {
  assert.equal(
    normalizeBrowserInput('how can I center a div?'),
    'https://www.google.com/search?q=how%20can%20I%20center%20a%20div%3F'
  )
  assert.equal(
    normalizeBrowserInput('typescript'),
    'https://www.google.com/search?q=typescript'
  )
})

test('rejects executable and local-file schemes', () => {
  assert.throws(() => normalizeBrowserInput('javascript:alert(1)'), /HTTP and HTTPS/)
  assert.throws(() => normalizeBrowserInput('file:///tmp/example.html'), /HTTP and HTTPS/)
  assert.throws(() => normalizeBrowserInput('data:text/html,hello'), /HTTP and HTTPS/)
})

test('falls back to a valid default browser state', () => {
  assert.deepEqual(normalizePersistedBrowserState(undefined), DEFAULT_BROWSER_STATE)
  assert.deepEqual(normalizePersistedBrowserState({ tabs: [], activeTabId: 'missing' }), DEFAULT_BROWSER_STATE)
})

test('reconciles persisted tabs, active tab, and panel width', () => {
  const state = normalizePersistedBrowserState({
    tabs: [
      { id: 'new', title: '', url: BROWSER_NEW_TAB_URL },
      { id: 'one', title: ' Example ', url: 'https://example.com' },
      { id: 'one', title: 'Duplicate', url: 'https://duplicate.example' },
      { id: 'unsafe', title: 'Unsafe', url: 'file:///tmp/example.html' },
      { id: 'two', title: '', url: 'http://localhost:5173' }
    ],
    activeTabId: 'unsafe',
    panelWidth: MIN_BROWSER_PANEL_WIDTH - 100
  })

  assert.deepEqual(state.tabs, [
    { id: 'new', title: 'New tab', url: BROWSER_NEW_TAB_URL },
    { id: 'one', title: 'Example', url: 'https://example.com/' },
    { id: 'two', title: 'localhost', url: 'http://localhost:5173/' }
  ])
  assert.equal(state.activeTabId, 'new')
  assert.equal(state.panelWidth, MIN_BROWSER_PANEL_WIDTH)
  assert.equal(normalizePersistedBrowserState({ ...state, panelWidth: Number.MAX_SAFE_INTEGER }).panelWidth, MAX_BROWSER_PANEL_WIDTH)
})
