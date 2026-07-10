export interface ModelProjectorArtifact {
  filename: string
  sizeBytes: number
  sha256: string
}

export interface ModelArtifact {
  id: string
  repository: string
  revision: string
  filename: string
  sizeBytes: number
  sha256: string
  mmproj?: ModelProjectorArtifact
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const REVISION_PATTERN = /^[a-f0-9]{40}$/i
const REPOSITORY_PATTERN = /^[^./][^/]*\/[^./][^/]*$/
const PROJECTOR_MARKERS = ['mmproj', 'projector']

const ensureFilename = (filename: string, isProjector: boolean): void => {
  const normalized = filename.toLowerCase()
  if (!filename || filename.includes('/') || filename.includes('\\') || !normalized.endsWith('.gguf')) {
    throw new Error('Model artifact filename must name a GGUF file')
  }
  const identifiesProjector = PROJECTOR_MARKERS.some((marker) => normalized.includes(marker))
  if (identifiesProjector !== isProjector) throw new Error('Model artifact filename does not match its artifact type')
}

const ensureDigest = (digest: string, fieldName: string): void => {
  if (!SHA256_PATTERN.test(digest)) throw new Error(`Model artifact ${fieldName} must be a SHA-256 digest`)
}

export const validateModelArtifact = (artifact: ModelArtifact): ModelArtifact => {
  if (!artifact.id || !REPOSITORY_PATTERN.test(artifact.repository)) throw new Error('Model artifact repository is invalid')
  if (!REVISION_PATTERN.test(artifact.revision)) throw new Error('Model artifact revision must be a 40-character commit')
  ensureFilename(artifact.filename, false)
  if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0) throw new Error('Model artifact size must be a positive integer')
  ensureDigest(artifact.sha256, 'hash')
  if (artifact.mmproj) {
    ensureFilename(artifact.mmproj.filename, true)
    if (!Number.isSafeInteger(artifact.mmproj.sizeBytes) || artifact.mmproj.sizeBytes <= 0) {
      throw new Error('Model projector size must be a positive integer')
    }
    ensureDigest(artifact.mmproj.sha256, 'projector hash')
  }
  return artifact
}

export const validateModelArtifacts = (artifacts: readonly ModelArtifact[]): readonly ModelArtifact[] => {
  const identities = new Set<string>()
  artifacts.forEach((artifact) => {
    validateModelArtifact(artifact)
    if (identities.has(artifact.id)) throw new Error(`Duplicate model artifact: ${artifact.id}`)
    identities.add(artifact.id)
  })
  return artifacts
}

export const getModelArtifact = (artifacts: readonly ModelArtifact[], id: string): ModelArtifact | undefined =>
  artifacts.find((artifact) => artifact.id === id)

export const INITIAL_MODEL_ARTIFACTS = validateModelArtifacts([
  {
    id: 'qwen3_5_4b_q4km',
    repository: 'hinny/Qwen3.5-4B-GGUF-Q4_K_M',
    revision: '2ac4eb93304ceeba92a2776fec0f862e390b90c2',
    filename: 'Qwen3.5-4B-Q4_K_M.gguf',
    sizeBytes: 2707514080,
    sha256: '26b1d83e22463de5cb72b7750bd8de229f9f99a989a63cb12783fd295467c9bd'
  }
])
