import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error?: Error }

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = {}

  static getDerivedStateFromError(error: Error): State { return { error } }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('SupraCode renderer error', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return <main className="app-error-screen"><div><span>SupraCode</span><h1>Something went wrong</h1><p>{this.state.error.message}</p><button type="button" onClick={() => window.location.reload()}>Reload app</button></div></main>
  }
}
