import { createRoot } from 'react-dom/client';
import { setApiErrorHandler } from '@workspace/api-client-react';

import App from './App';
import { handleApiErrorResponse } from './lib/api';

// Self-hosted type (2026-09 design pass). No request leaves for a font CDN:
// each file carries a unicode-range, so a page downloads only the scripts it
// shows. IBM Plex Sans Arabic is the working face for BOTH scripts (it ships
// Latin); Readex Pro is headings only.
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import '@fontsource/ibm-plex-sans-arabic/700.css';
import '@fontsource/readex-pro/500.css';
import '@fontsource/readex-pro/600.css';
import '@fontsource/readex-pro/700.css';
import './index.css';

// Apply the app-wide API error policy (e.g. the M11.2 verification gate → status
// page) to the GENERATED React Query client too, not just `apiFetch`. Most
// business pages — including the dashboard — fetch through the generated client,
// so without this a gated organization would sit on a broken page instead of
// being routed to /verification.
setApiErrorHandler((error) => handleApiErrorResponse(error.status, error.data));

createRoot(document.getElementById('root')!).render(<App />);
