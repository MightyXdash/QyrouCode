import {
  MAX_CUSTOM_RESPONSE_STYLE_LENGTH,
  type OnboardingPreferences
} from '../../shared/settings'

export type PreferenceQuestionKey =
  | 'theme'
  | 'contextWindowTokens'
  | 'mathModelTier'
  | 'codingModelTier'
  | 'autoModelRouting'
  | 'defaultReasoningEffort'
  | 'executionApproval'
  | 'responseStyle'

export type OnboardingDraft = Partial<Pick<OnboardingPreferences, PreferenceQuestionKey>> & {
  customResponseInstruction: string
}

export interface QuestionChoice {
  value: string | number | boolean
  label: string
  description: string
  detail?: string
  recommended?: boolean
  caution?: boolean
}

export interface OnboardingQuestion {
  key: PreferenceQuestionKey
  group: string
  title: string
  description: string
  choices: readonly QuestionChoice[]
}

export const CUSTOM_RESPONSE_INSTRUCTION_LABEL = 'How should SupraCode respond?'
export const CUSTOM_RESPONSE_INSTRUCTION_PLACEHOLDER =
  'For example: Be concise, challenge my assumptions, and explain trade-offs plainly.'

export const ONBOARDING_QUESTIONS: readonly OnboardingQuestion[] = [
  {
    key: 'theme',
    group: 'Appearance',
    title: 'Which appearance should SupraCode use?',
    description: 'Choose the visual environment that feels most comfortable for focused work.',
    choices: [
      { value: 'light', label: 'Light', description: 'Clean, bright, and easy to scan.' },
      { value: 'dark', label: 'Dark', description: 'Low-glare focus for longer sessions.' },
      { value: 'system', label: 'Match your system', description: 'Follow your device appearance.', recommended: true }
    ]
  },
  {
    key: 'contextWindowTokens',
    group: 'Model capacity',
    title: 'How much context should your models keep?',
    description: 'More context lets SupraCode consider more of your conversation and project at once. Larger windows use more RAM and VRAM.',
    choices: [
      { value: 32000, label: 'Focused', description: 'A lean context window for lighter work.', detail: '32K tokens' },
      { value: 72000, label: 'Balanced', description: 'A strong balance of context and resource use.', detail: '72K tokens', recommended: true },
      { value: 145000, label: 'Extended', description: 'More room for larger projects and longer sessions.', detail: '145K tokens' },
      { value: 256000, label: 'Maximum', description: 'The largest context window for demanding work.', detail: '256K tokens' }
    ]
  },
  {
    key: 'mathModelTier',
    group: 'Model routing',
    title: 'How should SupraCode handle demanding math?',
    description: 'Choose the default model tier for complex calculations and technical reasoning.',
    choices: [
      { value: 'large', label: 'Largest model', description: 'Prioritise capability over speed.' },
      { value: 'medium', label: 'Medium model', description: 'Balance capability, speed, and resource use.', recommended: true },
      { value: 'small', label: 'Smallest model', description: 'Favour speed and a lighter footprint.' }
    ]
  },
  {
    key: 'codingModelTier',
    group: 'Model routing',
    title: 'How should SupraCode handle demanding coding?',
    description: 'Choose the default model tier for difficult implementation and debugging work.',
    choices: [
      { value: 'large', label: 'Largest model', description: 'Favour the strongest planning and code reasoning.', recommended: true },
      { value: 'medium', label: 'Medium model', description: 'Balance quality, speed, and resource use.' },
      { value: 'small', label: 'Smallest model', description: 'Favour fast responses for lighter tasks.' }
    ]
  },
  {
    key: 'autoModelRouting',
    group: 'Model routing',
    title: 'Should SupraCode automatically route models?',
    description: 'Choose whether SupraCode should select from your downloaded models for each request.',
    choices: [
      { value: true, label: 'Yes', description: 'Let SupraCode decide which downloaded model best fits each request.' },
      { value: false, label: 'No', description: 'Choose the right AI model yourself for every prompt.', recommended: true }
    ]
  },
  {
    key: 'defaultReasoningEffort',
    group: 'Reasoning',
    title: 'How much reasoning effort should models use by default?',
    description: 'Higher effort can improve difficult responses, but may take more time.',
    choices: [
      { value: 'minimal', label: 'Minimal', description: 'Keep responses as fast and light as possible.' },
      { value: 'low', label: 'Low', description: 'Use a small amount of additional thought.' },
      { value: 'medium', label: 'Medium', description: 'Use a balanced level of reasoning.', recommended: true },
      { value: 'high', label: 'High', description: 'Spend more time on difficult responses.' },
      { value: 'extra-high', label: 'Extra high', description: 'Prioritise depth over response time.' }
    ]
  },
  {
    key: 'executionApproval',
    group: 'Safety and access',
    title: 'When should SupraCode ask for permission?',
    description: 'This will control how the future execution layer asks before taking action.',
    choices: [
      { value: 'always', label: 'Ask before every action', description: 'Review each action before it runs.' },
      { value: 'high-risk', label: 'Ask only for high-risk actions', description: 'Keep routine work moving while protecting sensitive operations.', recommended: true },
      { value: 'full', label: 'Full access', description: 'Allow all actions without approval. Only choose this if you understand the risks.', caution: true }
    ]
  },
  {
    key: 'responseStyle',
    group: 'Response style',
    title: 'What response style should SupraCode use?',
    description: 'This shapes how SupraCode communicates, not the quality of its work.',
    choices: [
      { value: 'warm', label: 'Warm', description: 'Friendly, encouraging, and clear.' },
      { value: 'gen-z', label: 'Gen Z', description: 'Casual, expressive, and current.' },
      { value: 'sarcastic', label: 'Sarcastic', description: 'Dry, witty, and lightly irreverent.' },
      { value: 'pragmatic', label: 'Pragmatic', description: 'Direct, grounded, and focused on getting things done.', recommended: true },
      { value: 'custom', label: 'Custom', description: 'Describe the tone and style that fits you best.' }
    ]
  }
]

export const isQuestionComplete = (question: OnboardingQuestion, draft: OnboardingDraft): boolean => {
  const selectedValue = draft[question.key]
  if (selectedValue === undefined) return false
  if (question.key !== 'responseStyle' || selectedValue !== 'custom') return true
  return draft.customResponseInstruction.trim().length > 0 &&
    draft.customResponseInstruction.trim().length <= MAX_CUSTOM_RESPONSE_STYLE_LENGTH
}

export const buildOnboardingPreferences = (
  draft: OnboardingDraft,
  selectedRoles: string[],
  selectedModelIds: string[]
): OnboardingPreferences => {
  if (ONBOARDING_QUESTIONS.some(question => !isQuestionComplete(question, draft))) {
    throw new Error('Complete every preference before saving')
  }

  return {
    selectedRoles,
    selectedModelIds,
    theme: draft.theme!,
    contextWindowTokens: draft.contextWindowTokens!,
    mathModelTier: draft.mathModelTier!,
    codingModelTier: draft.codingModelTier!,
    autoModelRouting: draft.autoModelRouting!,
    defaultReasoningEffort: draft.defaultReasoningEffort!,
    executionApproval: draft.executionApproval!,
    responseStyle: draft.responseStyle!,
    customResponseInstruction: draft.responseStyle === 'custom'
      ? draft.customResponseInstruction.trim()
      : ''
  }
}
