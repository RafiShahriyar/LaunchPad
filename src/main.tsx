import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider } from 'react-redux'
import { store } from './store/store'
import { startEventBridge } from './store/eventBridge'
import App from './App'
import './index.css'

// Subscribe to main-process events before React mounts, so a game that exits
// during startup is not missed.
startEventBridge(store)

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root not found in index.html')

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </React.StrictMode>
)
