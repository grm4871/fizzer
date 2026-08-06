# First beta contract

This document records what a new, invited person can rely on in the current
Cascade beta. It is intentionally a product boundary, not a roadmap.

## Friend journey

1. The first account can bootstrap a new installation. Afterwards,
   registration requires a valid chat invite unless the operator explicitly
   sets `CASCADE_ALLOW_OPEN_REGISTRATION`.
2. A chat owner creates a copyable `/invite/<token>` link. A new person can
   create an account on that link, then Cascade adds the chat to a vault owned
   by that person.
3. The invite shares that chat, not the owner's vault. The recipient cannot
   browse the source vault or change the owner's execution directory. A
   recipient can post to the linked chat as themselves.

The current chat link is a seven-day, multi-use JWT. It is appropriate only
for a small, trusted beta group; it has no per-recipient revocation or
single-use redemption record. Account invites and channel joins must be split
before a broader-access launch (tracked as H4 in
[`unhardened-surfaces.md`](unhardened-surfaces.md)).

## Desktop execution boundary

The browser is a workspace for notes and chat. Agent processes run only in a
signed-in Cascade desktop app on the agent owner's machine, using that
machine's locally authenticated CLI/provider credentials. The server records
and relays run events; it does not hold provider credentials or execute an
LLM.

A browser with no desktop runner shows **Get desktop**, which opens
`/download`. That route intentionally keeps the installer chooser accessible
to a signed-in user; `/` continues to redirect returning users to the web app.
An invitee may participate in notes and chat before installing the desktop
app, but cannot start an agent run until their own desktop runner is online.
For a shared chat, a guest ping runs on the registered agent owner's desktop,
not the guest's computer; guest-supplied model, working-directory, and
unattended-approval choices are ignored.

## Managed path decision

Managed, server-executed agents are **not part of this beta**. The app is
bring-your-own-agent: no server provider credentials, checkout, pooled model
access, or managed execution path is available.

`server/managedAgents.ts` and its owner-only entitlement endpoints are a
non-executing billing-control-plane prototype. They reserve and ledger bounded
amounts but are not connected to a provider or the run route; changing an
entitlement cannot start an agent or incur provider spend. Do not market or
enable it as a beta capability. A managed launch needs a separate approved
provider, pricing, settlement/reconciliation, abuse controls, and a
user-visible billing contract.

## Evidence that protects this contract

- `npm run test:account` covers bootstrap closure, invite-based friend
  registration, linked-chat isolation, and participant permissions.
- `npm run test:desktop-runner` covers desktop-only delegation, ownership,
  reconnect/reclaim, and visible failure when no desktop runner is connected.
- `npm run verify:account-ui` checks the browser-only handoff link in the
  built renderer.

The release matrix's agent and API/persistence rows apply to any change to
these flows. Installer publication itself is a release operation: `/download`
can present the chooser even when a platform artifact has not been uploaded,
and the landing page then reports that the platform build is unavailable.
