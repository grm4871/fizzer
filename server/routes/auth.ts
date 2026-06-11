import express, { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from './../data-utils.js';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../middleware/auth.js';

const router = express.Router();

const SALT_ROUNDS = 10;
const CURRENT_TOS_VERSION = '1.0';

/**
 * Register a new user account
 *
 * Endpoint: POST /api/auth/register
 * Body: { username: string, displayName: string, password: string, tosAccepted: boolean }
 * Responses:
 *  - 200: { id, username, displayName }
 *  - 400: Missing required fields
 *  - 409: Username already taken
 *  - 500: Server error
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { username, displayName, password, tosAccepted } = req.body;

    if (!username || !displayName || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!tosAccepted) {
      return res.status(400).json({ error: 'You must accept the Terms of Service to register' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check if username already exists (case-insensitive)
    const existingUser = await prisma.profile.findFirst({
      where: { username: { equals: username.trim(), mode: 'insensitive' } }
    });

    if (existingUser) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    // Get client IP for rate limiting
    // Order of preference:
    // 1. req.ip (Express handles trust proxy logic for X-Forwarded-For)
    // 2. X-Real-IP (Standard Nginx proxy header)
    // 3. X-Forwarded-For manual check (fallback)
    // 4. Socket remote address
    let clientIp = req.ip;
    
    // Normalize localhost IP (IPv6 loopback) to IPv4
    if (clientIp === '::1' || clientIp === '::ffff:127.0.0.1') {
        clientIp = '127.0.0.1';
    }

    // Fallbacks if req.ip is missing or internal (unlikely with trust proxy enabled)
    if (!clientIp || clientIp === '127.0.0.1') {
         const xRealIp = req.headers['x-real-ip'] as string;
         const xForwardedFor = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim();
         
         if (xRealIp) {
            clientIp = xRealIp;
         } else if (xForwardedFor) {
            clientIp = xForwardedFor;
         } else {
            clientIp = req.socket.remoteAddress || undefined; // Use undefined instead of null to match Prisma type
         }
    }

    // Check IP registration limit (max 5 accounts per IP)
    if (clientIp) {
      const ipRegistrations = await prisma.tos_acceptance.count({
        where: { ip_address: clientIp }
      });
      if (ipRegistrations >= 5) {
        console.log(`[Auth] IP ${clientIp} blocked - already has ${ipRegistrations} registrations`);
        return res.status(429).json({ error: 'Too many accounts created from this IP address' });
      }
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    // Create new profile using atomic SQL function (creates spaces + gallery)
    const rows = await prisma.$queryRaw<{ create_profile: string }[]>`
      SELECT create_profile(${username.trim()}, ${displayName.trim()}, ${hashedPassword}) as create_profile
    `;
    const newUserId = rows[0].create_profile;

    // Fetch the created profile
    const result = await prisma.profile.findUnique({
      where: { id: newUserId },
      select: {
        id: true,
        username: true,
        displayName: true,
        color: true,
        settings: true,
        joinedAt: true
      }
    }) as any;

    if (!result) {
      throw new Error('Profile creation failed');
    }

    // Record TOS acceptance with IP address for rate limiting
    await prisma.tos_acceptance.create({
      data: {
        profile_id: result.id,
        tos_version: CURRENT_TOS_VERSION,
        ip_address: clientIp
      }
    });

    console.log(`[Auth] User ${result.username} registered, TOS accepted from IP: ${clientIp || 'unknown'}`);

    // Spaces + gallery were created atomically by create_profile() SQL function

    // Generate token
    const token = jwt.sign(
      { id: result.id, username: result.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      id: result.id,
      username: result.username,
      displayName: result.displayName,
      color: result.color,
      settings: result.settings,
      joinedAt: result.joinedAt?.toISOString(),
      isAdmin: false, // New accounts are never admin
      token
    });
  } catch (e: any) {
    console.error('[Auth Register]', e);
    if (e.code === 'P2002') {
      return res.status(409).json({ error: 'Username already taken' });
    }
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Login with username and password
 *
 * Endpoint: POST /api/auth/login
 * Body: { username: string, password: string }
 * Responses:
 *  - 200: { id, username, displayName }
 *  - 400: Missing required fields
 *  - 401: Invalid username or password
 *  - 500: Server error
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Missing username or password' });
    }

    // Find user by username (case-insensitive)
    const profile = await prisma.profile.findFirst({
      where: { username: { equals: username.trim(), mode: 'insensitive' } }
    });

    if (!profile) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Compare password
    const passwordMatch = await bcrypt.compare(password, profile.password);

    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

// Generate token
    const token = jwt.sign(
      { id: profile.id, username: profile.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      id: profile.id,
      username: profile.username,
      displayName: profile.displayName,
      color: profile.color,
      settings: profile.settings || {},
      joinedAt: profile.joinedAt?.toISOString(),
      isAdmin: (profile as any).is_admin,
      token
    });
  } catch (e: any) {
    console.error('[Auth Login]', e);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Change password for authenticated user
 *
 * Endpoint: POST /api/auth/change-password
 * Headers: Authorization Bearer token
 * Body: { currentPassword: string, newPassword: string }
 * Responses:
 *  - 200: { success: true }
 *  - 400: Missing required fields or invalid password
 *  - 401: Current password incorrect
 *  - 500: Server error
 */
router.post('/change-password', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    let decoded: any;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required!' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters!' });
    }

    // Get user from database
    const profile = await prisma.profile.findUnique({
      where: { id: decoded.id }
    });

    if (!profile) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    const passwordMatch = await bcrypt.compare(currentPassword, profile.password);
    if (!passwordMatch) {
      return res.status(400).json({ error: 'Incorrect current password!' });
    }

    // Check if new password is same as current
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'New password must be different from current password!' });
    }

    // Hash and update new password
    const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await prisma.profile.update({
      where: { id: decoded.id },
      data: { password: hashedPassword }
    });

    console.log(`[Auth] User ${profile.username} changed their password`);
    res.json({ success: true });
  } catch (e: any) {
    console.error('[Auth Change Password]', e);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Admin: Reset password for any user
 *
 * Endpoint: POST /api/auth/admin/reset-password
 * Headers: Authorization Bearer token (must be admin)
 * Body: { targetUserId: string, newPassword: string }
 * Responses:
 *  - 200: { success: true }
 *  - 400: Missing required fields
 *  - 401: Not authenticated
 *  - 403: Not an admin
 *  - 404: Target user not found
 *  - 500: Server error
 */
router.post('/admin/reset-password', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    let decoded: any;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Check if requesting user is admin
    const adminProfile = await prisma.profile.findUnique({
      where: { id: decoded.id }
    });

    if (!adminProfile || !(adminProfile as any).is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { targetUserId, newPassword } = req.body;

    if (!targetUserId || !newPassword) {
      return res.status(400).json({ error: 'Target user ID and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters!' });
    }

    // Find target user
    const targetProfile = await prisma.profile.findUnique({
      where: { id: targetUserId }
    });

    if (!targetProfile) {
      return res.status(404).json({ error: 'Target user not found' });
    }

    // Hash and update password
    const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await prisma.profile.update({
      where: { id: targetUserId },
      data: { password: hashedPassword }
    });

    console.log(`[Auth] Admin ${adminProfile.username} reset password for user ${targetProfile.username}`);
    res.json({ success: true });
  } catch (e: any) {
    console.error('[Auth Admin Reset Password]', e);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Admin: Set/unset admin status for a user
 *
 * Endpoint: POST /api/auth/admin/set-admin
 * Headers: Authorization Bearer token (must be admin)
 * Body: { targetUserId: string, isAdmin: boolean }
 */
router.post('/admin/set-admin', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    let decoded: any;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Check if requesting user is admin
    const adminProfile = await prisma.profile.findUnique({
      where: { id: decoded.id }
    });

    if (!adminProfile || !(adminProfile as any).is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { targetUserId, isAdmin } = req.body;

    if (!targetUserId || typeof isAdmin !== 'boolean') {
      return res.status(400).json({ error: 'Target user ID and isAdmin boolean are required' });
    }

    // Can't remove your own admin status
    if (targetUserId === decoded.id && !isAdmin) {
      return res.status(400).json({ error: 'Cannot remove your own admin status' });
    }

    // Find target user
    const targetProfile = await prisma.profile.findUnique({
      where: { id: targetUserId }
    });

    if (!targetProfile) {
      return res.status(404).json({ error: 'Target user not found' });
    }

    // Update admin status
    await prisma.profile.update({
      where: { id: targetUserId },
      data: { is_admin: isAdmin } as any
    });

    console.log(`[Auth] Admin ${adminProfile.username} ${isAdmin ? 'granted' : 'revoked'} admin for ${targetProfile.username}`);
    res.json({ success: true });
  } catch (e: any) {
    console.error('[Auth Admin Set Admin]', e);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Admin: Delete a netdoc by ID
 *
 * Endpoint: POST /api/auth/admin/delete-netdoc
 * Headers: Authorization Bearer token (must be admin)
 * Body: { netdocId: string }
 */
router.post('/admin/delete-netdoc', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    let decoded: any;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Check if requesting user is admin
    const adminProfile = await prisma.profile.findUnique({
      where: { id: decoded.id }
    });

    if (!adminProfile || !(adminProfile as any).is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { netdocId } = req.body;

    if (!netdocId) {
      return res.status(400).json({ error: 'Netdoc ID is required' });
    }

    // Find target genus + netdoc
    const genus = await prisma.genus.findUnique({
      where: { id: netdocId },
      include: {
        netdoc: { select: { is_jacket: true } },
        profile: { select: { username: true } }
      }
    });

    if (!genus) {
      return res.status(404).json({ error: 'Netdoc not found' });
    }

    // Prevent deleting jacket netdocs (must delete the space instead)
    if (genus.netdoc?.is_jacket) {
      return res.status(400).json({ error: 'Cannot delete a jacket netdoc. Delete the space instead.' });
    }

    // Delete the genus (cascades to netdoc via FK)
    await prisma.genus.delete({ where: { id: netdocId } });

    console.log(`[Auth] Admin ${adminProfile.username} deleted netdoc ${netdocId} (${genus.name}) by ${genus.profile?.username}`);
    res.json({ success: true, deletedName: genus.name });
  } catch (e: any) {
    console.error('[Auth Admin Delete Netdoc]', e);
    res.status(500).json({ error: 'server_error' });
  }
});

const authRouter = router;
export default authRouter;
