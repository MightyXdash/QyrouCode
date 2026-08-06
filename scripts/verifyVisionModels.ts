import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MODEL_LIST } from '../src/renderer/src/modelCatalog.js'
import { EXTERNAL_PROJECTOR_SOURCES, isModelProjectorFile, selectModelProjectorFile, type ModelProjectorSource, type ModelTreeEntry } from '../src/shared/modelProjector.js'

interface VerifiedProjector extends ModelProjectorSource {
  sizeBytes: number
  sha256: string
  bundled: boolean
}

const REQUEST_TIMEOUT_MS = 15000

const fetchModelTree = async (repository: string): Promise<ModelTreeEntry[]> => {
  const response = await fetch(`https://huggingface.co/api/models/${repository}/tree/main?recursive=true`, {
    headers: { 'user-agent': 'qyroucode-verify-vision-models' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`Failed to list ${repository} (HTTP ${response.status})`)
  const value = (await response.json()) as unknown
  if (!Array.isArray(value)) throw new Error(`Unexpected tree response for ${repository}`)
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const candidate = entry as { path?: unknown; size?: unknown; type?: unknown }
    if (typeof candidate.path !== 'string' || typeof candidate.size !== 'number') return []
    return [{ path: candidate.path, size: candidate.size }]
  })
}

const downloadProjector = async (source: ModelProjectorSource): Promise<{ sizeBytes: number; sha256: string }> => {
  const url = `https://huggingface.co/${source.repository}/resolve/main/${source.path}`
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'qyroucode-verify-vision-models' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`Failed to download ${source.path} (HTTP ${response.status})`)
  const buffer = Buffer.from(await response.arrayBuffer())
  return { sizeBytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') }
}

const isNetworkFailure = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError' || error.name === 'TypeError')

const verifiedSources: Record<string, VerifiedProjector> = {}
const failures: string[] = []
const skipped: string[] = []

const main = async (): Promise<void> => {
  for (const model of MODEL_LIST) {
    const repoId = model.hf_repo
    try {
      const tree = await fetchModelTree(repoId)
      const bundled = selectModelProjectorFile(tree)
      if (bundled) {
        verifiedSources[repoId] = {
          repository: repoId,
          path: bundled,
          sizeBytes: tree.find((entry) => entry.path === bundled)?.size ?? 0,
          sha256: 'pending',
          bundled: true
        }
        continue
      }
      const external = EXTERNAL_PROJECTOR_SOURCES[repoId]
      if (!external) {
        failures.push(`${repoId}: no bundled projector and no EXTERNAL_PROJECTOR_SOURCES entry`)
        continue
      }
      const externalTree = await fetchModelTree(external.repository)
      const entry = externalTree.find((candidate) => candidate.path === external.path)
      if (!entry || !isModelProjectorFile(entry.path)) {
        failures.push(`${repoId}: external source ${external.repository}/${external.path} does not exist`)
        continue
      }
      verifiedSources[repoId] = { ...external, sizeBytes: entry.size, sha256: 'pending', bundled: false }
    } catch (error) {
      if (isNetworkFailure(error)) {
        skipped.push(`${repoId}: ${error instanceof Error ? error.message : String(error)}`)
      } else {
        failures.push(`${repoId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  for (const [repoId, source] of Object.entries(verifiedSources)) {
    try {
      if (source.bundled) {
        const tree = await fetchModelTree(repoId)
        const entry = tree.find((candidate) => candidate.path === source.path)
        if (!entry) throw new Error('projector disappeared from the repository tree')
        source.sizeBytes = entry.size
      }
      const download = await downloadProjector(source)
      source.sizeBytes = download.sizeBytes
      source.sha256 = download.sha256
      console.log(`ok ${repoId} -> ${source.repository}/${source.path} (${source.sizeBytes} bytes, ${source.sha256.slice(0, 12)}…)`)
    } catch (error) {
      if (isNetworkFailure(error)) {
        skipped.push(`${repoId}: ${error instanceof Error ? error.message : String(error)}`)
      } else {
        failures.push(`${repoId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  console.log(`\n${Object.keys(verifiedSources).filter((id) => verifiedSources[id].sha256 !== 'pending').length} verified, ${failures.length} failed, ${skipped.length} skipped`)

  const outputPath = process.argv[2]
  if (outputPath) {
    const block = Object.entries(verifiedSources)
      .map(([repoId, source]) => `  '${repoId}': {\n    repository: '${source.repository}',\n    path: '${source.path}',\n    sizeBytes: ${source.sizeBytes},\n    sha256: '${source.sha256}'\n  },`)
      .join('\n')
    writeFileSync(join(process.cwd(), outputPath), `const EXTERNAL_PROJECTOR_SOURCES: Readonly<Record<string, ModelProjectorSource>> = {\n${block}\n}\n`)
    console.log(`Wrote projector manifest to ${outputPath}`)
  }

  if (failures.length > 0) {
    console.error('\nFailures:')
    for (const failure of failures) console.error(`- ${failure}`)
  }
  if (skipped.length > 0) {
    console.error('\nSkipped (network unavailable):')
    for (const item of skipped) console.error(`- ${item}`)
  }
}

void main()
