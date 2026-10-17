import React from 'react'
import { createRoot } from 'react-dom/client'
import AgentApp from './agent/AgentApp.tsx'
import './index.css'

const rootEl = document.getElementById('root')
if (rootEl) createRoot(rootEl).render(<React.StrictMode><AgentApp /></React.StrictMode>)
