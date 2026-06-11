# Staging to Master Merge Notes

## Branch Info
| Key | Value |
|-----|-------|
| Staging forked from | `f9c508882a9511d4498133f40e54034ca48212b3` (oembed) |
| Merging on top of | `7f83489d4ccd9ef50b96e1d65e0c7b5a3be1de0d` (temp dashboard button & ip fix) |
| Merge command | `git merge --squash -X theirs staging` |

## Commits on master since fork (3 commits)
| Commit | Message |
|--------|---------|
| `0e44a76` | add admin panel, password resets, password field fix |
| `4a7793a` | image oembed |
| `7f83489` | temp dashboard button & ip fix |

## Lossy Changes (staging wins, master changes lost)

| File | Lost | Gained |
|------|------|--------|
| `server/routes/fallback.ts` | `extractFirstImageUrl()` function, `og:image`/`twitter:image` meta tags, URL stripping from description, `og:url`, `og:site_name` | - |
| `client/src/pages/Login.tsx` | `PasswordInput` component (show/hide toggle) | Router-based initial mode from location state, simplified username hint |
| `client/src/sidebar/Sidebar.tsx` | Entire file deleted, dashboard button nav to '/' | Replaced with `LeftSidebar.tsx`, `RightSidebar.tsx`, `Explorer.tsx` architecture |
| `client/src/sidebar/SidebarFooter.tsx` | `HouseIcon`, `onDashboard` prop, 4-button layout | 3-button layout, keypad/dagwood layout options |
| `client/src/layouts/MainLayout.tsx` | Admin route detection, admin exclusion from tabbed routes | - |
| `client/src/layouts/components/MainLayoutContent.tsx` | `AdminPanel` import and routing | - |
| `client/src/pages/Dashboard.tsx` | Line clamp 2→100, `whiteSpace: pre-wrap`, `wordBreak: break-word` | - |
| `client/src/pages/Settings.tsx` | Password change UI and states, `PasswordInput` usage | - |
| `client/src/types/index.ts` | `isAdmin?: boolean` in ProfileData | - |
| `client/src/types/routing.ts` | `'admin'` route type | - |
| `server/app-routing.ts` | `app.set('trust proxy', 1)` | - |
| `prisma/schema.prisma` | `is_admin Boolean @default(false)` field | - |

## Safe Changes (master only, preserved)

| File | Notes |
|------|-------|
| `check_ips.ts` | New file |
| `client/src/components/ui/PasswordInput.tsx` | New component |
| `client/src/icons/HouseIcon.tsx` | New icon |
| `client/src/pages/AdminPanel.tsx` | New page |
| `nginx-prod-fixed.conf` | Config changes |
| `server/routes/auth.ts` | Admin routes, password change, IP fix |
| `server/routes/recommendations.ts` | 10000 char limit |

## Post-Merge TODO
- [ ] Re-add admin panel frontend routing if needed
- [ ] Re-add `is_admin` to prisma schema if needed
- [ ] Re-add `trust proxy` setting to app-routing.ts
- [ ] Re-add OG image extraction to fallback.ts if wanted
- [ ] Consider adding PasswordInput to Login.tsx
