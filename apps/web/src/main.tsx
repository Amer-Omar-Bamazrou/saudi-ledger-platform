import { createRoot } from 'react-dom/client';
import { setApiErrorHandler } from '@workspace/api-client-react';

import App from './App';
import { handleApiErrorResponse } from './lib/api';

import './index.css';

// Apply the app-wide API error policy (e.g. the M11.2 verification gate → status
// page) to the GENERATED React Query client too, not just `apiFetch`. Most
// business pages — including the dashboard — fetch through the generated client,
// so without this a gated organization would sit on a broken page instead of
// being routed to /verification.
setApiErrorHandler((error) => handleApiErrorResponse(error.status, error.data));

createRoot(document.getElementById('root')!).render(<App />);
