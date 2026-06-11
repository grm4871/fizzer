# pg_crdt PostgreSQL Extension Installation

## Container Persistence

Yes, if you delete the container, you'll lose the extension installation. However, you have a few options to preserve it:

### Option 1: Commit the Container to an Image (Recommended)

Save the current container state as a new image:

```bash
podman commit netaris-postgres netaris-postgres-with-crdt:latest
```

#### How to Use Your Saved Image

**When you need to recreate the container:**

```bash
# Stop and remove the old container
podman stop netaris-postgres
podman rm netaris-postgres

# Create a new one from your saved image
podman run -d --name netaris-postgres -p 5433:5432 \
  -e POSTGRES_USER=netaris \
  -e POSTGRES_PASSWORD=netaris_dev_password \
  -e POSTGRES_DB=netaris \
  netaris-postgres-with-crdt:latest
```

**Or update your Makefile to use this image:**

You could modify your Makefile to use `netaris-postgres-with-crdt:latest` instead of the base `postgres` image.

### Option 2: Keep the container running

Just don't delete it. You can stop/start it without losing data:

```bash
podman stop netaris-postgres
podman start netaris-postgres
```

### Option 3: Create a Dockerfile

Build a custom image from scratch that includes the extension. This is more reproducible but takes longer to set up initially.

---

## Installation Summary

The committed image approach (Option 1) is the easiest. The container has been backed up as `netaris-postgres-with-crdt:latest` - if you delete the container, just recreate it from this image and the extension will already be there!

### What Was Installed

1. Build dependencies (git, make, gcc, postgresql-server-dev-all)
2. Rust toolchain (rustc 1.91.1 + nightly)
3. automerge-c library (C bindings for Automerge CRDT library)
4. pg_crdt extension (compiled from https://github.com/supabase/pg_crdt)
5. Extension enabled in the `netaris` database

### Extension Details

- **Name:** `automerge`
- **Version:** 0.0.1
- **Schema:** `automerge`
- **Functions:** 35 CRDT functions available
- **Location:** `/usr/lib/postgresql/18/lib/automerge.so`

The extension is ready to use for working with CRDTs (Conflict-free Replicated Data Types) in PostgreSQL.
