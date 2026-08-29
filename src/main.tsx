import React from 'react'
import { createRoot } from 'react-dom/client'
import SettingsApp from './SettingsApp.tsx'
import './index.css'

const rootEl = document.getElementById('root')
if (rootEl) createRoot(rootEl).render(<React.StrictMode><SettingsApp /></React.StrictMode>)