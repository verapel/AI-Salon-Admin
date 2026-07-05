import { Router } from 'express';
import {
  populateAuthFromDb,
  requireAuth,
  toAuthMeResponse,
} from '../middleware/auth.js';

const router = Router();

router.get('/me', requireAuth, async (req, res) => {
  try {
    await populateAuthFromDb(req.auth!);
    res.json(toAuthMeResponse(req.auth!));
  } catch (err) {
    console.error('[auth] GET /me error:', err);
    res.status(500).json({ error: 'Auth failed' });
  }
});

export default router;
