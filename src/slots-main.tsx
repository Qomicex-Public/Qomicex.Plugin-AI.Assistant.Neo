import React from 'react'
import { createRoot } from 'react-dom/client'
import CapsuleSlot from './slots/CapsuleSlot.tsx'
import './index.css'

const rootEl = document.getElementById('root')
if (rootEl) createRoot(rootEl).render(<React.StrictMode><CapsuleSlot /></React.StrictMode>)
