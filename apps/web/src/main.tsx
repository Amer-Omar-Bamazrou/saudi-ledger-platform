import { createRoot } from 'react-dom/client';
import { setApiErrorHandler } from '@workspace/api-client-react';

import App from './App';
import { handleApiErrorResponse } from './lib/api';
import { limiterUnavailableMessage, rateLimitMessage, rateLimitedSeconds } from './lib/rateLimit';

import './index.css';

// Apply the app-wide API error policy (e.g. the M11.2 verification gate → status
// page) to the GENERATED React Query client too, not just `apiFetch`. Most
// business pages — including the dashboard — fetch through the generated client,
// so without this a gated organization would sit on a broken page instead of
// being routed to /verification.
//
// The generated client's message is "HTTP 429 Too Many Requests: <English>";
// for the rate limit it is replaced, before the error is thrown, with the
// reader's own language — the same sentence `apiFetch`'s ApiError carries.
setApiErrorHandler((error) => {
  const wait = rateLimitedSeconds(error.status, error.data);
  if (wait !== null) error.message = rateLimitMessage(wait);
  const down = limiterUnavailableMessage(error.status, error.data);
  if (down !== null) error.message = down;
  handleApiErrorResponse(error.status, error.data);
});

createRoot(document.getElementById('root')!).render(<App />);
