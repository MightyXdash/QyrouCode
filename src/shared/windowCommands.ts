export const WINDOW_COMMANDS = {
  reload: 'reload',
  toggleDevTools: 'toggle-dev-tools',
  toggleFullscreen: 'toggle-fullscreen'
} as const

export type WindowCommand = (typeof WINDOW_COMMANDS)[keyof typeof WINDOW_COMMANDS]
