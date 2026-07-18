export const DESKTOP_PLATFORMS = {
  macOS: 'darwin',
  linux: 'linux',
  windows: 'win32'
} as const

export function usesNativeWindowControls(platform: string): boolean {
  return platform === DESKTOP_PLATFORMS.macOS || platform === DESKTOP_PLATFORMS.linux
}
