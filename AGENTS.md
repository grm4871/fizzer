# Agent Instructions

- For frontend or Electron renderer changes, do not rely only on TypeScript/build success. Before calling the work done, run the app and verify that the changed screen has no browser-console JavaScript errors or React runtime errors.
- Prefer checking runtime errors with DevTools, Playwright, or another browser automation path that can capture `console.error`, uncaught exceptions, and failed module loads.
- If runtime verification is not possible, state that explicitly in the final response and include the exact build/type checks that were run instead.
