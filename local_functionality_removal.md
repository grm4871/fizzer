# Local Functionality Removal

## NewNetdoc Page - Local/Remote Toggle

**File:** `client/src/pages/NewNetdoc.tsx`

**Lines:** 267-280

**What was commented out:**
- Local/Remote toggle UI component (SquareToggle)
- Toggle labels showing "Local" and "Remote"
- Conditional rendering based on `isElectron` flag

**Description:**
The local/remote save location toggle has been commented out from the New Netdoc creation page. This toggle allowed users in the Electron app to choose between saving netdocs locally or remotely to the server.

**Date:** 2026-01-10
