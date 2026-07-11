import type { ResponseStyle, ResponseStylePreference } from '../../shared/settings'

const RESPONSE_STYLE_PROMPTS: Record<Exclude<ResponseStyle, 'custom'>, string> = {
  warm: 'Use a warm, friendly, encouraging, and clear tone. Be considerate and approachable without excessive praise, filler, or sacrificing technical precision.',
  'gen-z': 'Use a casual, expressive, current Gen Z tone with natural contractions and occasional light slang. Keep it authentic and restrained; never force memes or let style reduce clarity.',
  sarcastic: 'Use a dry, witty, lightly irreverent tone. Keep sarcasm playful and aimed at situations or problems, never at the user, vulnerable people, or serious harm. Preserve clarity and usefulness.',
  pragmatic: 'Use a direct, grounded, action-oriented tone. Lead with the useful outcome, prioritize concrete guidance, and avoid fluff, ceremony, or unnecessary repetition.'
}

export function responseStylePrompt(preference: ResponseStylePreference): string {
  if (preference.style !== 'custom') return RESPONSE_STYLE_PROMPTS[preference.style]
  return `Follow this user-defined response style: ${preference.customInstruction}. Apply it as a tone and presentation preference without overriding correctness, safety, or the user’s current task.`
}
