import WelcomeScreen from './WelcomeScreen'
import './App.css'

const MAIN_WINDOW_QUERY_VALUE = 'app'

function App(): JSX.Element {
  const windowType = new URLSearchParams(window.location.search).get('window')

  if (windowType === MAIN_WINDOW_QUERY_VALUE) {
    return <main className="main-app-blank" />
  }

  return <WelcomeScreen />
}

export default App
