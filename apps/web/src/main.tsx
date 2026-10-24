import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles.css';
import { WorkspaceProvider } from './workspace';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><BrowserRouter><WorkspaceProvider><App /></WorkspaceProvider></BrowserRouter></React.StrictMode>,
);
