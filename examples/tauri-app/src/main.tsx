import { createRoot } from 'react-dom/client'

import App from './App'
import 'tauri-plugin-video-api/react/styles.css'
import './react-app.css'

createRoot(document.getElementById('app')!).render(<App />)
