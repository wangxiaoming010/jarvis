import React from 'react';
import ReactDOM from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import App from './App';
import { isTauri } from '@tauri-apps/api/core';
if (isTauri()) document.documentElement.classList.add('is-tauri');
import './styles.css';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </React.StrictMode>,
);
