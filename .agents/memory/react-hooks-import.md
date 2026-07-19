---
name: React hooks import
description: All React hooks (useEffect, useState, etc.) must be explicitly imported from 'react'
---

## Rule
Always add used hooks to the React import line at the top of every component file.

## Why
This project's frontend does not use a global React namespace import. `useEffect` used without import causes a runtime "Can't find variable: useEffect" error that crashes the entire React tree, not just the component.

## How to apply
```ts
import { useEffect, useState } from 'react';
```
