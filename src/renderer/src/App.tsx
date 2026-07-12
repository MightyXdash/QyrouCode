import WelcomeScreen from './WelcomeScreen'
import MainApp from './MainApp'
import AppErrorBoundary from './AppErrorBoundary'

const MAIN_WINDOW_QUERY_VALUE = 'app'

function App(): JSX.Element {
  const windowType = new URLSearchParams(window.location.search).get('window')

  if (windowType === MAIN_WINDOW_QUERY_VALUE) {
    return <AppErrorBoundary><MainApp /></AppErrorBoundary>
  }

  return <AppErrorBoundary><WelcomeScreen /></AppErrorBoundary>
}

export default App
