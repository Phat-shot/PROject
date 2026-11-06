import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './lib/auth';
import { DialogProvider, ToastProvider } from './components/ui';
import './styles.css';

// Data-Router (createBrowserRouter), damit useBlocker ungespeicherte Eingaben vor einem Seitenwechsel schützen kann;
// die Routen selbst bleiben als <Routes> in App.tsx.
const router = createBrowserRouter([{
  path: '*',
  element: (
    <AuthProvider>
      <ToastProvider>
        <DialogProvider>
          <App />
        </DialogProvider>
      </ToastProvider>
    </AuthProvider>
  )
}]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
