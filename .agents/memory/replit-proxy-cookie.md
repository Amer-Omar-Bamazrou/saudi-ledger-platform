---
name: Replit proxy cookie fix
description: Session auth in Replit preview iframe — cookies don't work, use Bearer token in localStorage
---

## Rule
Do NOT use session cookies for auth in Replit-hosted apps. Use a Bearer token stored in localStorage instead.

## Why
The Replit preview is rendered inside an iframe at `replit.com`. The app runs on `*.replit.dev`. These are different eTLD+1, so Chrome treats the embedded frame as a **cross-site context**. Chrome 120+ blocks third-party cookies from cross-site iframes by default — the `Set-Cookie` header is issued but the browser never stores or sends the cookie. No amount of SameSite/Secure tuning fixes this because the block is at the third-party cookie policy level, not the cookie attribute level.

## Solution — Bearer token via localStorage
1. **Login route** returns `{ user, token: req.sessionID }` after `session.save()` completes.
2. **Client** stores the token: `localStorage.setItem('ksa_ledger_token', token)`.
3. **Every API call** sends `Authorization: Bearer <token>` header.
4. **Server middleware** (registered after express-session) checks the Authorization header; if the cookie-based session didn't populate `req.session.userId`, it calls `req.sessionStore.get(sid, ...)` to load the session from PostgreSQL and manually populates `req.session`.
5. `requireAuth` then sees `req.session.userId` and passes normally.

## Key implementation detail
The `token: req.sessionID` must be included inside the `req.session.save(callback)` callback — not before — otherwise the session ID is returned before the row exists in `user_sessions`.

## What NOT to do
- `SameSite=None; Secure` — cookie still blocked by third-party cookie policy in the iframe
- `trust proxy` + `X-Forwarded-Proto` — the Replit proxy does NOT forward this header; `secure: true` silently skips Set-Cookie
- Intercepting `res.setHeader` to inject `;Secure` — cookie IS set correctly but browser ignores it (third-party block)
