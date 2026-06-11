import { createPermsRouter, getSpacePermsMode, setSpacePermsMode, verifySpaceMonarch, getSpacePermissions, grantSpacePermission, revokeSpacePermission, revokeAllSpacePermissions } from '../utils/permissions.js';

const router = createPermsRouter({
  idParam: 'id',
  socketPrefix: 'space',
  socketEntityKey: 'spaceId',
  emitSocketEvents: false,
  getPermsMode: getSpacePermsMode,
  setPermsMode: setSpacePermsMode,
  verifyOwner: verifySpaceMonarch,
  getPermissions: getSpacePermissions,
  grantPermission: grantSpacePermission,
  revokePermission: revokeSpacePermission,
  revokeAllPermissions: revokeAllSpacePermissions,
  serializeGrantResult: (p) => ({ ...p, id: String(p.id) }),
});

export default router;
