---
name: Route error propagation
description: Errors thrown with a statusCode property must be handled by handleRouteError, not plain catch blocks
---

## Rule
Use `handleRouteError(err, req, res)` from `lib/routeError.ts` in every route catch block, not the inline `req.log.error({ err }); res.status(500).json(...)` pattern.

## Why
Period lock violations (423) and immutability guards (409) are thrown as `Object.assign(new Error(...), { statusCode: 423 })`. The original inline catch block ignored the statusCode property, turning all application errors into generic 500s. handleRouteError checks for statusCode and propagates it.

## How to apply
Import `handleRouteError` and replace:
```ts
} catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
```
with:
```ts
} catch (err) { handleRouteError(err, req, res); }
```
