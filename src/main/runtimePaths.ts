import { join } from 'node:path'
import type { RuntimeArtifact } from '../shared/runtimeManifest'

const runtimeDirectoryName = (artifact: RuntimeArtifact): string =>
  `${artifact.platform}-${artifact.architecture}-${artifact.backend}`

export const developmentRuntimeDirectory = (appPath: string, artifact: RuntimeArtifact): string =>
  join(appPath, 'vendor', 'llama.cpp', runtimeDirectoryName(artifact))

export const packagedRuntimeDirectory = (resourcesPath: string, artifact: RuntimeArtifact): string =>
  join(resourcesPath, 'llama.cpp', runtimeDirectoryName(artifact))

export const packagedRuntimeExecutable = (resourcesPath: string, artifact: RuntimeArtifact): string =>
  join(packagedRuntimeDirectory(resourcesPath, artifact), artifact.executablePath)
