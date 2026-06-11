import express from 'express';
import crudRouter from './spaces/crud.js';
import subscriptionsRouter from './spaces/subscriptions.js';
import permsRouter from './spaces/perms.js';

const router = express.Router();

// Mount order matters — subscriptions/list must come before /:id
router.use('/', subscriptionsRouter);
router.use('/', permsRouter);
router.use('/', crudRouter);

export default router;
