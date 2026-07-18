const { chmod, readdir } = require('fs/promises')
const { join } = require('path')

const UNIX_EXECUTABLE_MODE = 0o755
const UNIX_PLATFORMS = new Set(['darwin', 'linux'])
const APP_RESOURCES_PATH = ['resources', 'app.asar.unpacked', 'node_modules', 'node-pty']
const PTY_HELPER_FILENAME = 'spawn-helper'

async function executableHelpers(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const paths = entries.filter((entry) => entry.isFile() && entry.name === PTY_HELPER_FILENAME).map((entry) => join(directory, entry.name))
  const nestedPaths = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => executableHelpers(join(directory, entry.name))))
  return paths.concat(...nestedPaths)
}

module.exports = async function afterPack(context) {
  if (!UNIX_PLATFORMS.has(context.electronPlatformName)) return
  const platformRoot = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents')
    : context.appOutDir
  const nodePtyPath = join(platformRoot, ...APP_RESOURCES_PATH)
  const helpers = await executableHelpers(nodePtyPath)
  await Promise.all(helpers.map((helperPath) => chmod(helperPath, UNIX_EXECUTABLE_MODE)))
}
