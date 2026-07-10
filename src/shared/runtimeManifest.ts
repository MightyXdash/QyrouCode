export type RuntimePlatform = 'darwin' | 'linux' | 'win32'
export type RuntimeArchitecture = 'arm64' | 'x64'
export type RuntimeBackend = 'cpu' | 'cuda' | 'metal' | 'vulkan'

export interface RuntimeArtifact {
  id: string
  release: string
  platform: RuntimePlatform
  architecture: RuntimeArchitecture
  backend: RuntimeBackend
  sourceUrl: string
  sha256: string
  executablePath: string
  companionLibraries: string[]
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const WINDOWS_DRIVE_PATH_PATTERN = /^[a-z]:[\\/]/i

const ensureHttpsUrl = (sourceUrl: string): void => {
  let parsed: URL

  try {
    parsed = new URL(sourceUrl)
  } catch {
    throw new Error('Runtime artifact source URL must be HTTPS')
  }

  if (parsed.protocol !== 'https:') throw new Error('Runtime artifact source URL must be HTTPS')
}

const ensureRelativePath = (value: string, fieldName: string): void => {
  if (!value || value.startsWith('/') || value.startsWith('\\') || WINDOWS_DRIVE_PATH_PATTERN.test(value)) {
    throw new Error(`Runtime artifact ${fieldName} must be a relative path`)
  }

  const segments = value.split(/[\\/]+/)
  if (segments.some((segment) => segment === '..' || segment.length === 0)) {
    throw new Error(`Runtime artifact ${fieldName} must be a relative path`)
  }
}

const runtimeIdentity = (artifact: RuntimeArtifact): string =>
  `${artifact.platform}:${artifact.architecture}:${artifact.backend}`

const validateRuntimeArtifact = (artifact: RuntimeArtifact): void => {
  if (!artifact.id || !artifact.release) throw new Error('Runtime artifact id and release are required')
  ensureHttpsUrl(artifact.sourceUrl)
  if (!SHA256_PATTERN.test(artifact.sha256)) throw new Error('Runtime artifact SHA-256 must be a 64-character hexadecimal digest')
  ensureRelativePath(artifact.executablePath, 'executable path')
  artifact.companionLibraries.forEach((library) => ensureRelativePath(library, 'companion library path'))
}

export const validateRuntimeArtifacts = (artifacts: readonly RuntimeArtifact[]): readonly RuntimeArtifact[] => {
  const identities = new Set<string>()

  artifacts.forEach((artifact) => {
    validateRuntimeArtifact(artifact)
    const identity = runtimeIdentity(artifact)
    if (identities.has(identity)) throw new Error(`Duplicate runtime artifact for ${identity}`)
    identities.add(identity)
  })

  return artifacts
}

export const getRuntimeArtifact = (
  artifacts: readonly RuntimeArtifact[],
  platform: RuntimePlatform,
  architecture: RuntimeArchitecture,
  backend: RuntimeBackend
): RuntimeArtifact | undefined =>
  artifacts.find((artifact) => artifact.platform === platform && artifact.architecture === architecture && artifact.backend === backend)

export const INITIAL_RUNTIME_ARTIFACTS = validateRuntimeArtifacts([
  {
    id: 'llama.cpp-b9951-linux-x64-cpu',
    release: 'b9951',
    platform: 'linux',
    architecture: 'x64',
    backend: 'cpu',
    sourceUrl: 'https://codeload.github.com/ggml-org/llama.cpp/tar.gz/082b326fc76f6e9bbb835b3920a3022bfdb6691c',
    sha256: '0bed19f882c98c452998311de58121cf74ec572eec3343cbcd33cc507766c359',
    executablePath: 'llama-server',
    companionLibraries: []
  }
])
