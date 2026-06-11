import express from 'express';
import crudRouter from './netdoc/crud.js';
import visibilityRouter from './netdoc/visibility.js';
import permsRouter from './netdoc/perms.js';

const router = express.Router();

// Normalize Crockford Base32 IDs: O→0, I/L→1
const normalizeCrockford = (id: string) => id.replace(/[oO]/g, '0').replace(/[iIlL]/g, '1');

// Middleware to 301 redirect if uid needs Crockford normalization
router.param('uid', (req, res, next, uid) => {
  const normalized = normalizeCrockford(uid);
  if (normalized !== uid) {
    // Replace the uid in the URL and redirect
    const newUrl = req.originalUrl.replace(uid, normalized);
    return res.redirect(301, newUrl);
  }
  next();
});

// Mount all netdoc sub-routers
router.use('/', crudRouter);
router.use('/', visibilityRouter);
router.use('/', permsRouter);

export default router;
