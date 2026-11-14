import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// No <StrictMode>: in development it mounts components twice, which would start WebViewer twice.
createRoot(document.getElementById('root')!).render(<App />)
