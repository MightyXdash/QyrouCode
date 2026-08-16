import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatMessage } from '../src/shared/chat.js'
import { buildWorkLogPhases, isProgressActivity, shouldShowToolPhase, shouldShowWorkLog, upsertProgressActivity, workLogMessagesForAssistant } from '../src/renderer/src/workLog.js'

const assistant = (id: string, status: ChatMessage['status'] = 'pending'): ChatMessage => ({ id, role: 'assistant', content: '', status })
const progress = (id: string, parentAssistantId: string, content: string): ChatMessage => ({
  id,
  role: 'tool',
  content,
  parentAssistantId,
  activityKind: 'progress',
  progressId: id,
  progressSource: 'model'
})
const tool = (id: string, parentAssistantId: string): ChatMessage => ({
  id,
  role: 'tool',
  content: 'done',
  parentAssistantId,
  toolCalls: [{ id, name: 'read', arguments: {}, result: 'done' }]
})

test('upserts progress by stable id without duplicating the activity row', () => {
  const parent = assistant('assistant')
  const initial = upsertProgressActivity([parent], parent.id, {
    progressId: 'progress-1',
    summary: 'Inspecting the project structure before making the requested change.',
    source: 'model'
  }, 10, 'message-1')
  const updated = upsertProgressActivity(initial, parent.id, {
    progressId: 'progress-1',
    summary: 'Inspecting the relevant project files before making the requested change.',
    source: 'model'
  }, 20, 'message-2')

  assert.equal(updated.length, 2)
  assert.equal(updated[0].id, 'message-1')
  assert.equal(updated[0].content, 'Inspecting the relevant project files before making the requested change.')
  assert.equal(updated[0].messagePhase, 'commentary')
  assert.equal(updated[1].id, parent.id)
})

test('recognizes legacy progress and preserves milestone tool phase ordering', () => {
  const parent = assistant('assistant')
  const legacy: ChatMessage = { id: 'legacy', role: 'tool', content: 'Legacy progress', parentAssistantId: parent.id }
  const messages = [
    legacy,
    tool('read-1', parent.id),
    progress('progress-2', parent.id, 'Starting verification after completing the implementation work.'),
    tool('read-2', parent.id),
    parent
  ]
  const workMessages = workLogMessagesForAssistant(messages, messages.length - 1)
  const phases = buildWorkLogPhases(workMessages)

  assert.equal(isProgressActivity(legacy), true)
  assert.equal(phases.length, 2)
  assert.equal(phases[0].progress?.id, 'legacy')
  assert.deepEqual(phases[0].toolMessages.map((message) => message.id), ['read-1'])
  assert.equal(phases[1].progress?.id, 'progress-2')
  assert.deepEqual(phases[1].toolMessages.map((message) => message.id), ['read-2'])
})

test('active work is visible while completed work requires disclosure expansion', () => {
  assert.equal(shouldShowWorkLog('pending', false), true)
  assert.equal(shouldShowWorkLog('completed', false), false)
  assert.equal(shouldShowWorkLog('cancelled', false), false)
  assert.equal(shouldShowWorkLog('error', false), false)
  assert.equal(shouldShowWorkLog('completed', true), true)
})

test('keeps the active tool phase behind the single live activity row', () => {
  assert.equal(shouldShowToolPhase(true, true), false)
  assert.equal(shouldShowToolPhase(true, false), true)
  assert.equal(shouldShowToolPhase(false, true), true)
})
