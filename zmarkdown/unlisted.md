# Plan: Add "Unlisted" Visibility to Netdocs

## Summary
Add an "unlisted" visibility option that hides netdocs from recommendations/feeds/search while still allowing access via direct link. This is separate from permissions (which control WHO can access).

## Files to Modify

### Database
- `init.sql` - Add `is_unlisted BOOLEAN NOT NULL DEFAULT FALSE` to netdoc table (line ~142)
- `zmigrations/` (new folder) - Create migration script to add column to existing databases

### Server
- `server/routes/netdocs.ts`
  - Accept `isUnlisted` in POST /api/netdoc (create)
  - Return `is_unlisted` in GET /api/netdoc/:id
  - Add PATCH /api/netdoc/:id/visibility endpoint (creator-only)
- `server/data/recommendations.ts`
  - Add `is_unlisted: false` filter to `getPublicNetdocs()` Prisma query

### Client
- `client/src/pages/NewNetdoc.tsx` - Add visibility section with unlisted checkbox
- `client/src/pages/PermissionsMenu.tsx` - Add visibility section with unlisted toggle

## Implementation Steps

### Step 1: Edit init.sql
In the netdoc table definition (~line 136-143), add the is_unlisted column:
```sql
CREATE TABLE IF NOT EXISTS netdoc (
    id TEXT COLLATE case_insensitive PRIMARY KEY CHECK ((id COLLATE "C") ~ '^[a-zA-Z0-9]+$'),
    name VARCHAR(500) NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    creator_id UUID NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
    is_unlisted BOOLEAN NOT NULL DEFAULT FALSE,  -- NEW
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Step 2: Create zmigrations folder and migration script
Create `zmigrations/001_add_is_unlisted.sql`:
```sql
-- Migration: Add is_unlisted column to netdoc table
-- Run this on existing databases to add the unlisted visibility feature

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'netdoc' AND column_name = 'is_unlisted'
    ) THEN
        ALTER TABLE netdoc ADD COLUMN is_unlisted BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
END $$;
```

### Step 3: Update recommendations.ts
In `getPublicNetdocs()` (~line 10-37), add filter for `is_unlisted: false`:
```typescript
export async function getPublicNetdocs(limit: number = 100): Promise<any[]> {
  const publicDocs = await prisma.netdoc.findMany({
    where: {
      netdoc_permission: {
        some: {
          permission_type: 'read',
          user_id: EVERYONE_UUID
        }
      },
      is_unlisted: false,  // NEW: exclude unlisted netdocs from feed
      NOT: [
        { name: { endsWith: "'s Homepage" } }
      ]
    },
    // ... rest unchanged
  });
  return publicDocs;
}
```

### Step 4: Update netdocs.ts - Create Endpoint
In POST /api/netdoc, accept `isUnlisted` from request body and include in INSERT query.

### Step 5: Update netdocs.ts - Get Endpoint
In GET /api/netdoc/:id, include `is_unlisted` in response JSON.

### Step 6: Update netdocs.ts - New Visibility Endpoint
Add PATCH /api/netdoc/:id/visibility:
```typescript
router.patch('/:id/visibility', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { isUnlisted } = req.body;
  const userId = req.user!.id;

  // Verify ownership
  const netdoc = await prisma.netdoc.findUnique({ where: { id } });
  if (!netdoc) return res.status(404).json({ error: 'Not found' });
  if (netdoc.creator_id !== userId) return res.status(403).json({ error: 'Not creator' });

  // Update
  const updated = await prisma.netdoc.update({
    where: { id },
    data: { is_unlisted: isUnlisted === true }
  });

  res.json({ success: true, is_unlisted: updated.is_unlisted });
});
```

### Step 7: Update NewNetdoc.tsx
Add state: `const [isUnlisted, setIsUnlisted] = useState(false);`

Add checkbox in visibility section (below permissions):
```tsx
<label>
  <input type="checkbox" checked={isUnlisted} onChange={e => setIsUnlisted(e.target.checked)} />
  Unlisted (hidden from feed and search, accessible via direct link)
</label>
```

Pass `isUnlisted` to POST /api/netdoc.

### Step 8: Update PermissionsMenu.tsx
- Load `is_unlisted` from GET /api/netdoc/:id response
- Add visibility section with checkbox toggle
- Save via PATCH /api/netdoc/:id/visibility on submit

## Critical Files
- `/Users/diego/mystuff/Coding/netaris/init.sql` - Add column to netdoc table
- `/Users/diego/mystuff/Coding/netaris/zmigrations/001_add_is_unlisted.sql` - Migration for existing DBs
- `/Users/diego/mystuff/Coding/netaris/server/data/recommendations.ts` - Filter in getPublicNetdocs()
- `/Users/diego/mystuff/Coding/netaris/server/routes/netdocs.ts` - API endpoints
- `/Users/diego/mystuff/Coding/netaris/client/src/pages/NewNetdoc.tsx` - Create UI
- `/Users/diego/mystuff/Coding/netaris/client/src/pages/PermissionsMenu.tsx` - Edit UI

## Verification
1. Run migration on existing database
2. Create new netdoc with "unlisted" checked - should not appear in recommendations
3. Toggle existing netdoc to unlisted - should disappear from feed
4. Direct link to unlisted netdoc should still work
5. Unlisted netdocs should still appear in creator's dashboard
