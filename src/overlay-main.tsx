import React from 'react'
import { createRoot } from 'react-dom/client'
import ChatApp from './chat/ChatApp.tsx'
import './index.css'

const rootEl = document.getElementById('root')
if (rootEl) createRoot(rootEl).render(<React.StrictMode><ChatApp /></React.StrictMode>)