export interface Ratings {
  coding: number
  reasoning: number
  writing: number
  agentic: number
  math: number
  data_science: number
  tool_use: number
  speed: number
  instruction_following: number
  long_context: number
}

export interface CatalogModel {
  id: string
  name: string
  hf_repo: string
  base_model: string
  developer: string
  quantizer: string
  size: string
  parameters: string
  architecture: string
  context_length: number
  license: string
  vision: boolean
  tool_calling: boolean
  reasoning: boolean
  recommended_vram_gb: number
  quantization: string
  ratings: Ratings
  strengths: string[]
  weaknesses: string[]
  best_for: string[]
  why_selected: string
  alternatives: string[]
}

export const MODEL_LIST: CatalogModel[] = [
  {
    id: 'qwen3_5_4b_q4km',
    name: 'Qwen3.5-4B GGUF Q4_K_M',
    hf_repo: 'hinny/Qwen3.5-4B-GGUF-Q4_K_M',
    base_model: 'Qwen/Qwen3.5-4B',
    developer: 'Qwen',
    quantizer: 'hinny',
    size: 'Small',
    parameters: '4.66B',
    architecture: 'Dense',
    context_length: 262144,
    license: 'Apache-2.0',
    vision: true,
    tool_calling: true,
    reasoning: true,
    recommended_vram_gb: 8,
    quantization: 'Q4_K_M',
    ratings: {
      coding: 4, reasoning: 4, writing: 3, agentic: 4, math: 4,
      data_science: 4, tool_use: 5, speed: 5, instruction_following: 4, long_context: 5
    },
    strengths: ['Fast local multimodal agent model', 'Good small-tier tool use', 'Very long context for its size'],
    weaknesses: ['Third-party GGUF quantization', 'Lower ceiling than 9B, 27B, and 35B models'],
    best_for: ['small local agents', 'tool calling', 'fast coding help'],
    why_selected: 'Best verified small GGUF option for local agentic workflows with vision and tool calling.',
    alternatives: ['google/gemma-4-E4B-it-qat-q4_0-gguf']
  },
  {
    id: 'gemma4_e2b_it_q4_0',
    name: 'Gemma 4 E2B IT QAT GGUF Q4_0',
    hf_repo: 'google/gemma-4-E2B-it-qat-q4_0-gguf',
    base_model: 'google/gemma-4-E2B-it',
    developer: 'Google DeepMind',
    quantizer: 'Google',
    size: 'Small',
    parameters: '5.12B total, 2.3B effective',
    architecture: 'Dense',
    context_length: 128000,
    license: 'Apache-2.0',
    vision: true,
    tool_calling: true,
    reasoning: true,
    recommended_vram_gb: 6,
    quantization: 'Q4_0 QAT GGUF',
    ratings: {
      coding: 3, reasoning: 3, writing: 4, agentic: 3, math: 3,
      data_science: 3, tool_use: 4, speed: 5, instruction_following: 4, long_context: 4
    },
    strengths: ['Official Google GGUF', 'Very low local footprint', 'Good everyday assistant behavior'],
    weaknesses: ['Not ideal for hard coding', 'Lower reasoning ceiling'],
    best_for: ['everyday assistant', 'README drafts', 'Markdown'],
    why_selected: 'Best low-memory official GGUF assistant option under the constraints.',
    alternatives: ['google/gemma-4-E4B-it-qat-q4_0-gguf']
  },
  {
    id: 'gemma4_e4b_it_q4_0',
    name: 'Gemma 4 E4B IT QAT GGUF Q4_0',
    hf_repo: 'google/gemma-4-E4B-it-qat-q4_0-gguf',
    base_model: 'google/gemma-4-E4B-it',
    developer: 'Google DeepMind',
    quantizer: 'Google',
    size: 'Small',
    parameters: '8.0B total, 4.5B effective',
    architecture: 'Dense',
    context_length: 128000,
    license: 'Apache-2.0',
    vision: true,
    tool_calling: true,
    reasoning: true,
    recommended_vram_gb: 8,
    quantization: 'Q4_0 QAT GGUF',
    ratings: {
      coding: 4, reasoning: 4, writing: 4, agentic: 4, math: 4,
      data_science: 3, tool_use: 4, speed: 5, instruction_following: 5, long_context: 4
    },
    strengths: ['Official Google GGUF', 'Strong small assistant model', 'Good writing and instruction following'],
    weaknesses: ['Shorter context than Qwen', 'Less coding-specialized than Qwen'],
    best_for: ['technical writing', 'documentation', 'summarization'],
    why_selected: 'Best official small GGUF model for writing-heavy assistant workflows.',
    alternatives: ['hinny/Qwen3.5-4B-GGUF-Q4_K_M']
  },
  {
    id: 'qwen3_5_9b_q4km',
    name: 'Qwen3.5-9B GGUF Q4_K_M',
    hf_repo: 'jc-builds/Qwen3.5-9B-Q4_K_M-GGUF',
    base_model: 'Qwen/Qwen3.5-9B',
    developer: 'Qwen',
    quantizer: 'jc-builds',
    size: 'Medium',
    parameters: '9.65B',
    architecture: 'Dense',
    context_length: 262144,
    license: 'Apache-2.0',
    vision: true,
    tool_calling: true,
    reasoning: true,
    recommended_vram_gb: 12,
    quantization: 'Q4_K_M',
    ratings: {
      coding: 4, reasoning: 4, writing: 4, agentic: 5, math: 4,
      data_science: 4, tool_use: 5, speed: 4, instruction_following: 5, long_context: 5
    },
    strengths: ['Best verified medium GGUF option found', 'Strong tool use', 'Long context'],
    weaknesses: ['Third-party GGUF quantization', 'Not as strong as large models for difficult coding'],
    best_for: ['medium local agents', 'coding', 'analytics', 'terminal use'],
    why_selected: 'Default medium recommendation because it satisfies 2026, vision, local viability, GGUF availability, and tool calling.',
    alternatives: ['microsoft/Phi-4-reasoning-vision-15B excluded because native tool calling was not verified']
  },
  {
    id: 'qwen3_6_27b_q4km',
    name: 'Qwen3.6-27B GGUF Q4_K_M',
    hf_repo: 'sm54/Qwen3.6-27B-Q4_K_M-GGUF',
    base_model: 'Qwen/Qwen3.6-27B',
    developer: 'Qwen',
    quantizer: 'sm54',
    size: 'Large',
    parameters: '27.78B',
    architecture: 'Dense',
    context_length: 262144,
    license: 'Apache-2.0',
    vision: true,
    tool_calling: true,
    reasoning: true,
    recommended_vram_gb: 24,
    quantization: 'Q4_K_M',
    ratings: {
      coding: 5, reasoning: 5, writing: 4, agentic: 5, math: 5,
      data_science: 5, tool_use: 5, speed: 3, instruction_following: 5, long_context: 5
    },
    strengths: ['Strong dense coding and reasoning model', 'Excellent for repo understanding and debugging', 'Long context'],
    weaknesses: ['Third-party GGUF quantization', 'Slower than MoE alternatives'],
    best_for: ['debugging', 'repository understanding', 'analytics', 'terminal work'],
    why_selected: 'Best dense large GGUF recommendation for coding, debugging, and data work.',
    alternatives: ['Abiray/Qwen3.6-35B-A3B-Q4_K_M-GGUF']
  },
  {
    id: 'qwen3_6_35b_a3b_q4km',
    name: 'Qwen3.6-35B-A3B GGUF Q4_K_M',
    hf_repo: 'Abiray/Qwen3.6-35B-A3B-Q4_K_M-GGUF',
    base_model: 'Qwen/Qwen3.6-35B-A3B',
    developer: 'Qwen',
    quantizer: 'Abiray',
    size: 'Large',
    parameters: '35.95B total, about 3B active',
    architecture: 'MoE',
    context_length: 262144,
    license: 'Apache-2.0',
    vision: true,
    tool_calling: true,
    reasoning: true,
    recommended_vram_gb: 24,
    quantization: 'Q4_K_M',
    ratings: {
      coding: 5, reasoning: 5, writing: 4, agentic: 5, math: 5,
      data_science: 5, tool_use: 5, speed: 4, instruction_following: 5, long_context: 5
    },
    strengths: ['Best overall local agentic model in this pool', 'Strong coding and tool use', 'Efficient active-parameter profile'],
    weaknesses: ['Third-party GGUF quantization', 'MoE serving can be more complex'],
    best_for: ['agentic coding', 'tool calling', 'DevOps', 'frontend implementation'],
    why_selected: 'Best large GGUF model for autonomous local agent workflows under the constraints.',
    alternatives: ['sm54/Qwen3.6-27B-Q4_K_M-GGUF', 'google/gemma-4-26B-A4B-it-qat-q4_0-gguf']
  },
  {
    id: 'gemma4_26b_a4b_it_q4_0',
    name: 'Gemma 4 26B A4B IT QAT GGUF Q4_0',
    hf_repo: 'google/gemma-4-26B-A4B-it-qat-q4_0-gguf',
    base_model: 'google/gemma-4-26B-A4B-it',
    developer: 'Google DeepMind',
    quantizer: 'Google',
    size: 'Large',
    parameters: '26.54B total, about 3.8B active',
    architecture: 'MoE',
    context_length: 256000,
    license: 'Apache-2.0',
    vision: true,
    tool_calling: true,
    reasoning: true,
    recommended_vram_gb: 24,
    quantization: 'Q4_0 QAT GGUF',
    ratings: {
      coding: 4, reasoning: 5, writing: 4, agentic: 5, math: 5,
      data_science: 4, tool_use: 5, speed: 4, instruction_following: 5, long_context: 5
    },
    strengths: ['Official Google GGUF', 'Fast large MoE option', 'Strong reasoning and long context'],
    weaknesses: ['Less coding-specialized than Qwen3.6', 'Q4_0 is less preferred than Q4_K_M in many llama.cpp workflows'],
    best_for: ['reasoning', 'research', 'long documents', 'general agents'],
    why_selected: 'Best official large MoE GGUF alternative to Qwen.',
    alternatives: ['Abiray/Qwen3.6-35B-A3B-Q4_K_M-GGUF']
  },
  {
    id: 'gemma4_31b_it_q4_0',
    name: 'Gemma 4 31B IT QAT GGUF Q4_0',
    hf_repo: 'google/gemma-4-31B-it-qat-q4_0-gguf',
    base_model: 'google/gemma-4-31B-it',
    developer: 'Google DeepMind',
    quantizer: 'Google',
    size: 'Large',
    parameters: '32.68B',
    architecture: 'Dense',
    context_length: 256000,
    license: 'Apache-2.0',
    vision: true,
    tool_calling: true,
    reasoning: true,
    recommended_vram_gb: 28,
    quantization: 'Q4_0 QAT GGUF',
    ratings: {
      coding: 4, reasoning: 5, writing: 5, agentic: 5, math: 5,
      data_science: 4, tool_use: 5, speed: 3, instruction_following: 5, long_context: 5
    },
    strengths: ['Official Google GGUF', 'Best writing and research model in this pool', 'Strong instruction following'],
    weaknesses: ['Slower than MoE alternatives', 'Less coding-specialized than Qwen3.6'],
    best_for: ['writing', 'documentation', 'summarization', 'literature review'],
    why_selected: 'Best large GGUF choice for writing, documentation, and research-heavy assistant tasks.',
    alternatives: ['google/gemma-4-26B-A4B-it-qat-q4_0-gguf', 'sm54/Qwen3.6-27B-Q4_K_M-GGUF']
  }
]
