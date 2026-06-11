import { prisma } from './prisma-client.js';

// Profile helpers (used by routes/profile.ts)
/**
 * Create a new profile record
 * @param param0 - object containing { id, username, displayName, password?, color? }
 * @returns the created profile
 */
export async function createProfile({ id, username, displayName, password, color }: any) {
  const data: any = { id, username, displayName, password: password || '' };
  if (color !== undefined) {
    data.color = color;
  }
  return prisma.profile.create({ data });
}

/**
 * Get a profile by username
 * @param username - the username to look up
 * @returns profile or null
 */
export async function getProfileByUsername(username: string) {
  return prisma.profile.findUnique({ where: { username } });
}

/**
 * Get a profile by id
 * @param id - profile id (uuid)
 * @returns profile or null
 */
export async function getProfileById(id: string) {
  return prisma.profile.findUnique({ where: { id } });
}

/**
 * Update an existing profile record
 * @param param0 - { id, username, displayName, color?, settings? }
 * @returns updated profile
 */
export async function updateProfile({ id, username, displayName, color, settings }: any) {
  const data: any = { username, displayName };
  if (color !== undefined) {
    data.color = color;
  }
  if (settings !== undefined) {
    data.settings = settings;
  }
  return prisma.profile.update({ where: { id }, data });
}
