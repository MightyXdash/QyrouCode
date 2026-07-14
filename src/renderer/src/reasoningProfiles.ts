import type { CatalogModel } from './modelCatalog'

export const REASONING_EFFORTS = ['Instant', 'Low', 'Medium', 'High', 'Extra high'] as const
export type ReasoningEffort = typeof REASONING_EFFORTS[number]

export interface ReasoningProfile {
  enableThinking: boolean
  systemPrompt: string
  temperature: number
  topP: number
  topK: number
  minP: number
  presencePenalty: number
  repetitionPenalty: number
}

const EFFORT_INSTRUCTIONS: Record<ReasoningEffort, string> = {
  Instant: 'Answer immediately using the obvious fastest reliable path. Optimize for and reward the absolute least possible number of tool calls. For observation, inspection, lookup, and research, make at most the single decisive call needed and never call the same or a substantially similar tool again merely to reassure yourself, reconfirm evidence, or explore alternatives. If the answer is already available, call no tool. Writing and command tools are allowed when necessary, but keep them to the shortest possible sequence with no redundant reads or verification. Be decisive, concise, and avoid tangents.',
  Low: 'Use a short, focused internal reasoning pass and take the fastest sound path. Minimize tool calls aggressively. Do not call the same or a substantially similar observation, inspection, lookup, or research tool merely to reassure yourself or reconfirm an already-supported conclusion. Use one focused verification only when it materially affects correctness. Keep writing and command sequences compact and avoid redundant reads, searches, and post-change checks. Identify the key constraint and avoid unnecessary alternatives.',
  Medium: 'Reason internally through a few plausible approaches and their important tradeoffs. Check the main assumptions, then choose the strongest approach.',
  High: 'Reason deeply and explore multiple viable approaches. Test assumptions, compare tradeoffs, consider meaningful failure modes, then verify the best answer.',
  'Extra high': 'Use the deepest feasible internal analysis. Systematically consider approaches, assumptions, edge cases, failure modes, and success conditions, then verify the answer from multiple angles.'
}

export function reasoningProfile(model: CatalogModel, effort: ReasoningEffort): ReasoningProfile {
  const enableThinking = effort !== 'Instant'
  const isGemma = model.base_model.toLowerCase().includes('gemma')
  const isQwen36Dense = model.base_model.includes('Qwen3.6-27B')
  const systemPrefix = enableThinking && isGemma ? '<|think|>\n' : ''
  const responseInstruction = enableThinking
    ? 'Keep internal reasoning private: never reveal chain-of-thought, hidden analysis, or thinking tokens. Return only the useful final answer, with detail proportional to the task.'
    : 'Return only the useful final answer, with detail proportional to the task.'
  const systemPrompt = `${systemPrefix}${EFFORT_INSTRUCTIONS[effort]} ${responseInstruction}`

  if (isGemma) {
    return { enableThinking, systemPrompt, temperature: 1, topP: 0.95, topK: 64, minP: 0, presencePenalty: 0, repetitionPenalty: 1 }
  }

  if (!enableThinking) {
    return { enableThinking, systemPrompt, temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 1.5, repetitionPenalty: 1 }
  }

  const temperature = effort === 'Low' ? 0.6 : effort === 'Medium' ? 0.8 : 1
  return {
    enableThinking,
    systemPrompt,
    temperature,
    topP: 0.95,
    topK: 20,
    minP: 0,
    presencePenalty: isQwen36Dense ? 0 : (effort === 'Low' ? 0 : 1.5),
    repetitionPenalty: 1
  }
}
