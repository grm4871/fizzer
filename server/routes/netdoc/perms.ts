import { createPermsRouter } from '../utils/permissions.js';
import { prisma, grantNetdocPermission, revokeNetdocPermission, revokeAllNetdocPermissions, getNetdocPermissions, verifyNetdocCreator } from '../../data-utils.js';
import { getNetdocPermsMode, setNetdocPermsMode } from '../../data/permissions.js';

const router = createPermsRouter({
  idParam: 'uid',
  socketPrefix: 'netdoc',
  socketEntityKey: 'netdocId',
  getPermsMode: getNetdocPermsMode,
  setPermsMode: setNetdocPermsMode,
  verifyOwner: verifyNetdocCreator,
  getPermissions: getNetdocPermissions,
  grantPermission: grantNetdocPermission,
  revokePermission: revokeNetdocPermission,
  revokeAllPermissions: revokeAllNetdocPermissions,
  beforeGrant: async (entityId, _userId, body) => {
    const { targetUserId } = body;
    if (!targetUserId) return { hadExisting: false };
    const existing = await prisma.$queryRaw<any[]>`
      SELECT id FROM genus_permission WHERE genus_id = ${entityId} AND user_id = ${targetUserId}::uuid AND is_blacklist = FALSE LIMIT 1
    `;
    return { hadExisting: existing.length > 0 };
  },
  serializeGrantResult: (p) => ({ ...p, id: String(p.id) }),
});

export default router;
