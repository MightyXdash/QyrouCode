import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, chmod, copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { INITIAL_RUNTIME_ARTIFACTS, getRuntimeArtifact, type RuntimeArtifact, type RuntimeBackend } from '../src/shared/runtimeManifest'
import { developmentRuntimeDirectory } from '../src/main/runtimePaths'

const hashFile = async (path: string): Promise<string> =>
  new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk: Buffer) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolveHash(hash.digest('hex')))
  })

const download = async (sourceUrl: string, destination: string): Promise<void> => {
  const response = await fetch(sourceUrl)
  const body = response.body
  if (!response.ok || !body) throw new Error(`Runtime source download failed with status ${response.status}`)
  const file = await import('node:fs').then(({ createWriteStream }) => createWriteStream(destination))
  await new Promise<void>((resolveDownload, reject) => {
    body
      .pipeTo(new WritableStream({
        write(chunk) {
          return new Promise<void>((resolveWrite, rejectWrite) => {
            file.write(chunk, (error) => error ? rejectWrite(error) : resolveWrite())
          })
        },
        close() {
          file.end(resolveDownload)
        },
        abort(reason) {
          file.destroy(reason instanceof Error ? reason : undefined)
          reject(reason)
        }
      }))
      .catch(reject)
  })
}

const execute = (command: string, args: string[]): void => {
  execFileSync(command, args, { stdio: 'inherit' })
}

const requestedBackend = (): RuntimeBackend => {
  const flagIndex = process.argv.lastIndexOf('--backend')
  const backend = flagIndex === -1 ? 'cuda' : process.argv[flagIndex + 1]
  if (backend === 'cpu' || backend === 'cuda' || backend === 'vulkan') return backend
  throw new Error(`Unsupported runtime backend: ${backend ?? ''}`)
}

const backendCmakeArguments = (backend: RuntimeBackend): string[] => [
  `-DGGML_CUDA=${backend === 'cuda' ? 'ON' : 'OFF'}`,
  '-DGGML_METAL=OFF',
  `-DGGML_VULKAN=${backend === 'vulkan' ? 'ON' : 'OFF'}`
]

const bootstrap = async (): Promise<void> => {
  const targetPlatform = platform()
  const targetArchitecture = arch()
  if (targetPlatform !== 'linux' || targetArchitecture !== 'x64') {
    throw new Error(`No bootstrap runtime is available for ${targetPlatform}-${targetArchitecture}`)
  }

  const backend = requestedBackend()
  const artifact = getRuntimeArtifact(INITIAL_RUNTIME_ARTIFACTS, 'linux', 'x64', backend)
  if (!artifact) throw new Error(`No pinned Linux x64 ${backend} runtime artifact is configured`)

  const appPath = resolve(process.cwd())
  const targetDirectory = developmentRuntimeDirectory(appPath, artifact)
  const targetExecutable = join(targetDirectory, artifact.executablePath)
  try {
    await access(targetExecutable)
    process.stdout.write(`Verified runtime already staged at ${targetExecutable}\n`)
    return
  } catch {
    undefined
  }

  const runtimeRoot = join(appPath, 'vendor', 'llama.cpp')
  await mkdir(runtimeRoot, { recursive: true })
  const temporaryDirectory = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(runtimeRoot, '.staging-')))
  const archivePath = join(temporaryDirectory, 'llama.cpp.tar.gz')
  const sourceDirectory = join(temporaryDirectory, 'source')
  const buildDirectory = join(temporaryDirectory, 'build')
  const stagingDirectory = join(temporaryDirectory, 'runtime')

  try {
    await download(artifact.sourceUrl, archivePath)
    if (await hashFile(archivePath) !== artifact.sha256) throw new Error('Runtime source archive SHA-256 does not match the manifest')
    await mkdir(sourceDirectory, { recursive: true })
    execute('tar', ['-xzf', archivePath, '--strip-components=1', '-C', sourceDirectory])
    execute('cmake', [
      '-S', sourceDirectory,
      '-B', buildDirectory,
      '-G', 'Ninja',
      '-DCMAKE_BUILD_TYPE=Release',
      '-DBUILD_SHARED_LIBS=OFF',
      '-DGGML_NATIVE=OFF',
      ...backendCmakeArguments(backend)
    ])
    execute('cmake', ['--build', buildDirectory, '--target', 'llama-server', '--parallel'])

    const builtExecutable = join(buildDirectory, 'bin', artifact.executablePath)
    const builtStats = await stat(builtExecutable)
    if (!builtStats.isFile()) throw new Error('llama-server build did not produce an executable')
    await mkdir(stagingDirectory, { recursive: true })
    await copyFile(builtExecutable, join(stagingDirectory, artifact.executablePath))
    await chmod(join(stagingDirectory, artifact.executablePath), 0o755)
    await writeFile(join(stagingDirectory, 'receipt.json'), JSON.stringify({
      id: artifact.id,
      release: artifact.release,
      backend: artifact.backend,
      sourceUrl: artifact.sourceUrl,
      sourceSha256: artifact.sha256,
      executablePath: artifact.executablePath
    }, null, 2) + '\n')
    await rm(targetDirectory, { recursive: true, force: true })
    await rename(stagingDirectory, targetDirectory)
    process.stdout.write(`Staged ${basename(targetExecutable)} at ${targetExecutable}\n`)
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

void bootstrap().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
