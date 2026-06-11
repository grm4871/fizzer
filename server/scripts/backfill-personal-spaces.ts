/**
 * Backfill script to create personal spaces for existing users
 * Run with: npx ts-node server/scripts/backfill-personal-spaces.ts
 */

import { prisma } from '../data-utils.js';
import { createPersonalSpace } from '../routes/spaces/crud.js';

async function main() {
  console.log('Starting personal spaces backfill...');

  // Get all users
  const users = await prisma.profile.findMany({
    select: {
      id: true,
      username: true,
      displayName: true
    }
  });

  console.log(`Found ${users.length} users`);

  let created = 0;
  let skipped = 0;

  for (const user of users) {
    // Check if user already has personal spaces
    const existingSpaces = await prisma.spaces.findFirst({
      where: {
        monarch_id: user.id,
        is_profile: true
      }
    });

    if (existingSpaces) {
      console.log(`Skipping ${user.username} - already has personal space`);
      skipped++;
      continue;
    }

    try {
      const { profileSpaceId, savedSpaceId } = await createPersonalSpace(user.id, user.displayName);
      console.log(`Created spaces for ${user.username}: profile=${profileSpaceId}, saved=${savedSpaceId}`);
      created++;
    } catch (err) {
      console.error(`Failed to create spaces for ${user.username}:`, err);
    }
  }

  console.log(`\nDone! Created spaces for ${created} users, skipped ${skipped}`);
  await prisma.$disconnect();
}

main().catch(console.error);
