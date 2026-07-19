---
name: Replit proxy cookie fix
description: How to make session cookies work in the Replit preview iframe (SameSite + Secure issue)
---

## Rule
Use `sameSite: "none"` and `secure: false` in express-session cookie config, PLUS a `res.setHeader` intercept middleware that injects `; Secure` onto every Set-Cookie header before it leaves the server.

## Why
Two compounding problems:
1. **Cross-site iframe**: The Replit preview is rendered inside an iframe at `replit.com`. The app domain is `*.replit.dev`. These are different eTLD+1, so Chrome treats all requests from the iframe as "cross-site". `SameSite=Lax` cookies are not sent in cross-site contexts → every request after login returns 401.
2. **No X-Forwarded-Proto**: The Replit TLS proxy does NOT forward `X-Forwarded-Proto: https` to backend services. `express-session` with `secure: true` + `trust proxy` requires that header to set the `Secure` flag — without it, the `Set-Cookie` header is silently skipped. But Chrome requires `Secure` whenever `SameSite=None` is used.

**Solution**: Set `sameSite: "none"` (cross-site allowed) and `secure: false` (express-session always writes the header), then a middleware intercepts the raw `Set-Cookie` response header and appends `; Secure` so Chrome accepts the `SameSite=None` cookie.

## How to apply
In `app.ts`, add this middleware BEFORE the session middleware:

```typescript
app.use((_req, res, next) => {
  const origSetHeader = res.setHeader.bind(res);
  (res as any).setHeader = (name: string, value: unknown) => {
    if (name.toLowerCase() === "set-cookie") {
      const arr = (Array.isArray(value) ? value : [String(value)]) as string[];
      value = arr.map((c) =>
        c.toLowerCase().includes("secure") ? c : c + "; Secure"
      );
    }
    return origSetHeader(name, value as any);
  };
  next();
});
```

Then configure session:
```typescript
cookie: {
  sameSite: "none",  // cross-site iframe
  secure: false,     // let express-session always write; Secure injected by middleware above
  httpOnly: true,
  maxAge: 8 * 60 * 60 * 1000,
}
```

## Verified cookie output
`Set-Cookie: ksa_ledger_sid=...; Path=/; Expires=...; HttpOnly; SameSite=None; Secure`
