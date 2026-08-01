import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { type ModelArtifact, validateModelArtifact } from '../shared/modelManifest'

export type { ModelArtifact } from '../shared/modelManifest'

export interface ResolvedModelArtifact {
  artifact: ModelArtifact
  path: string
  mmprojPath?: string
}

export const modelSnapshotPath = (hubPath: string, artifact: ModelArtifact): string =>
  join(hubPath, `models--${artifact.repository.replace(/[/.]/g, '--')}`, 'snapshots', artifact.revision)

const ensureContainedPath = (rootPath: string, targetPath: string): void => {
  const pathFromRoot = relative(rootPath, targetPath)
  if (pathFromRoot === '' || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error('Model artifact resolved outside its cache snapshot')
  }
}

const hashFile = async (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk: Buffer) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })

export const resolveModelArtifact = async (hubPath: string, artifact: ModelArtifact): Promise<ResolvedModelArtifact> => {
  validateModelArtifact(artifact)
  const snapshotPath = modelSnapshotPath(hubPath, artifact)
  const modelPath = join(snapshotPath, artifact.filename)

  let modelStats: Awaited<ReturnType<typeof stat>>
  try {
    modelStats = await stat(modelPath)
  } catch {
    throw new Error('The selected GGUF model does not exist')
  }

  if (!modelStats.isFile()) throw new Error('The selected GGUF model is not a regular file')
  if (modelStats.size !== artifact.sizeBytes) throw new Error('The selected GGUF model size does not match the manifest')

  const resolvedSnapshotPath = await realpath(snapshotPath)
  const resolvedModelPath = await realpath(modelPath)
  ensureContainedPath(resolvedSnapshotPath, resolvedModelPath)

  const handle = await open(resolvedModelPath, 'r')
  try {
    const header = Buffer.alloc(4)
    await handle.read(header, 0, header.length, 0)
    if (header.toString('ascii') !== 'GGUF') throw new Error('The selected model has an invalid GGUF header')
  } finally {
    await handle.close()
  }

  if (await hashFile(resolvedModelPath) !== artifact.sha256) {
    throw new Error('The selected GGUF model SHA-256 does not match the manifest')
  }

  let mmprojPath: string | undefined
  if (artifact.mmproj) {
    const projectorPath = join(snapshotPath, artifact.mmproj.filename)
    let projectorStats: Awaited<ReturnType<typeof stat>>
    try {
      projectorStats = await stat(projectorPath)
    } catch {
      throw new Error('The selected vision projector does not exist')
    }
    if (!projectorStats.isFile()) throw new Error('The selected vision projector does not exist')
    if (projectorStats.size !== artifact.mmproj.sizeBytes) throw new Error('The selected vision projector size does not match the manifest')
    if (await hashFile(projectorPath) !== artifact.mmproj.sha256) throw new Error('The selected vision projector SHA-256 does not match the manifest')
    const resolvedProjectorPath = await realpath(projectorPath)
    ensureContainedPath(resolvedSnapshotPath, resolvedProjectorPath)
    mmprojPath = resolvedProjectorPath
  }

  return { artifact, path: resolvedModelPath, mmprojPath }
}
