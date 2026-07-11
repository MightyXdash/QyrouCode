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
  Instant: 'Answer immediately using the most direct reliable response. Do not perform an extended analysis. Be concise and avoid tangents.',
  Low: 'Use a short, focused internal reasoning pass. Identify the key constraint, select the most direct sound approach, and avoid exploring unnecessary alternatives.',
  Medium: 'Reason internally through a few plausible approaches and their important tradeoffs. Check the main assumptions, then choose the strongest approach without exhaustively exploring every branch.',
  High: 'Reason deeply and explore multiple viable approaches. Test important assumptions, compare tradeoffs, consider meaningful failure modes and edge cases, then select and verify the best answer.',
  'Extra high': 'Use the deepest feasible internal analysis. Systematically consider the relevant solution space, competing approaches, assumptions, edge cases, failure modes, and success conditions. Challenge and revise the leading answer, verify it from multiple angles, and produce the highest-quality answer you can.'
}

export function reasoningProfile(model: CatalogModel, effort: ReasoningEffort): ReasoningProfile {
  const enableThinking = effort !== 'Instant'
  const isGemma = model.base_model.toLowerCase().includes('gemma')
  const isQwen36Dense = model.base_model.includes('Qwen3.6-27B')
  const systemPrefix = enableThinking && isGemma ? '<|think|>\n' : ''
  const systemPrompt = `${systemPrefix}${EFFORT_INSTRUCTIONS[effort]} Keep internal reasoning private: never reveal chain-of-thought, hidden analysis, or thinking tokens. Return only the useful final answer, with detail proportional to the task.`

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
