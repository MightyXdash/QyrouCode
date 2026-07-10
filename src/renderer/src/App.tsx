import WelcomeScreen from './WelcomeScreen'
import MainApp from './MainApp'

const MAIN_WINDOW_QUERY_VALUE = 'app'

function App(): JSX.Element {
  const windowType = new URLSearchParams(window.location.search).get('window')

  if (windowType === MAIN_WINDOW_QUERY_VALUE) {
    return <MainApp />
  }

  return <WelcomeScreen />
}

export default App
