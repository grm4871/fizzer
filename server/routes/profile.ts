import express, { Request, Response } from 'express';
const router = express.Router();

import notifsRouter from './profile/notifs.js';

import {
    prisma,
    createProfile,
    getProfileByUsername,
    getProfileById,
    updateProfile
} from './../data-utils.js';

import { v4 as uuidv4 } from 'uuid';

// Define UserSettings interface
interface UserSettings {
  adultMode: boolean;
  misspellIndicator: boolean;
  openLinkNewTab?: boolean;
  confirmDiscardEdits?: boolean;
  keypadIcons?: boolean;
  editorMode?: 'normal' | 'vi' | 'monospace';
  malwareMode?: boolean;
}

// Default settings (all fields with defaults)
const DEFAULT_SETTINGS: UserSettings = {
  adultMode: false,
  misspellIndicator: false,
  openLinkNewTab: false,
  confirmDiscardEdits: false,
  keypadIcons: false,
  editorMode: 'normal',
  malwareMode: false
};

// Merge DB settings with defaults (DB values override defaults)
function mergeWithDefaults(dbSettings: any): UserSettings {
  return { ...DEFAULT_SETTINGS, ...(dbSettings || {}) };
}

// Validation function
function validateSettings(settings: any): UserSettings {
  if (typeof settings !== 'object' || settings === null) {
    throw new Error('Settings must be an object');
  }

  const cleanSettings: any = {};

  if (settings.adultMode !== undefined) {
    if (typeof settings.adultMode !== 'boolean') {
      throw new Error('Invalid adultMode value');
    }
    cleanSettings.adultMode = settings.adultMode;
  }

  if (settings.misspellIndicator !== undefined) {
    if (typeof settings.misspellIndicator !== 'boolean') {
      throw new Error('Invalid misspellIndicator value');
    }
    cleanSettings.misspellIndicator = settings.misspellIndicator;
  }

  if (settings.confirmDiscardEdits !== undefined) {
    if (typeof settings.confirmDiscardEdits !== 'boolean') {
      throw new Error('Invalid confirmDiscardEdits value');
    }
    cleanSettings.confirmDiscardEdits = settings.confirmDiscardEdits;
  }

  if (settings.openLinkNewTab !== undefined) {
    if (typeof settings.openLinkNewTab !== 'boolean') {
      throw new Error('Invalid openLinkNewTab value');
    }
    cleanSettings.openLinkNewTab = settings.openLinkNewTab;
  }

  if (settings.keypadIcons !== undefined) {
    if (typeof settings.keypadIcons !== 'boolean') {
      throw new Error('Invalid keypadIcons value');
    }
    cleanSettings.keypadIcons = settings.keypadIcons;
  }

  if (settings.editorMode !== undefined) {
    if (settings.editorMode !== 'normal' && settings.editorMode !== 'vi' && settings.editorMode !== 'monospace') {
      throw new Error('Invalid editorMode value');
    }
    cleanSettings.editorMode = settings.editorMode;
  }

  if (settings.malwareMode !== undefined) {
    if (typeof settings.malwareMode !== 'boolean') {
      throw new Error('Invalid malwareMode value');
    }
    cleanSettings.malwareMode = settings.malwareMode;
  }

  return cleanSettings as UserSettings;
}

/**
 * Get a user profile by username
 *
 * Endpoint: GET /api/profile/:username
 * Responses:
 *  - 200: { profile }
 *  - 404: profile not found
 */
router.get('/:username', async (req: Request, res: Response) => {
  try {
    const { username } = req.params;

    const profile = await getProfileByUsername(username);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    res.json({
      profile: {
        ...profile,
        settings: mergeWithDefaults(profile.settings),
        joinedAt: profile.joinedAt?.toISOString()
      }
    });
  } catch (e) {
    console.error('Profile fetch error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Get a user profile by ID
 *
 * Endpoint: GET /api/profile/id/:id
 * Responses:
 *  - 200: { profile }
 *  - 404: profile not found
 */
router.get('/id/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const profile = await getProfileById(id);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    res.json({
      profile: {
        ...profile,
        settings: mergeWithDefaults(profile.settings),
        joinedAt: profile.joinedAt?.toISOString()
      }
    });
  } catch (e) {
    console.error('Profile ID fetch error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Dismiss the folder dialogue banner
 * Sets folder_dialogue from 1 to 2 so it won't show again
 */
router.post('/folder-dialogue', async (req: Request, res: Response) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    await prisma.profile.update({ where: { id: userId }, data: { folder_dialogue: 2 } });

    res.json({ success: true });
  } catch (e) {
    console.error('Folder dialogue dismiss error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Login to an existing user profile
 *
 * Endpoint: POST /api/profile/
 * Body: { id?: string, username?: string, displayName: string, color?: string, settings?: object }
 * Behavior:
 *  - Authenticates an existing profile by id or username
 *  - Returns 404 if profile doesn't exist
 *  - Does NOT create new profiles
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { id, username, displayName, color, settings } = req.body;

    // If all fields are provided, this is an update request (for backward compatibility)
    if (id && displayName) {
      try {
        let validatedSettings = undefined;
        if (settings) {
          validatedSettings = validateSettings(settings);
        }

        const profile = await updateProfile({ id, username, displayName, color, settings: validatedSettings });
        return res.json({
          ...profile,
          settings: mergeWithDefaults(profile.settings),
          joinedAt: profile.joinedAt?.toISOString()
        });
      } catch (updateErr) {
        console.error('Profile update error:', updateErr);
        return res.status(500).json({ error: 'Failed to update profile' });
      }
    }

    // Otherwise, it's a lookup request
    if (!id && !username) {
      return res.status(400).json({ error: 'Must provide id or username' });
    }

    // Look up existing profile
    let profile;
    if (id) {
      profile = await getProfileById(id);
    } else if (username) {
      profile = await getProfileByUsername(username);
    }

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    res.json({
      ...profile,
      settings: mergeWithDefaults(profile.settings),
      joinedAt: profile.joinedAt?.toISOString()
    });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// Mount notification preferences routes
router.use('/', notifsRouter);

const profileRouter = router;
export default profileRouter;