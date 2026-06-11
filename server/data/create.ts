import { prisma } from '../data-utils.js';

export interface CreateChatParams {
  name: string;
  creatorId: string;
  spaceId?: string | null;
}

export interface CreateNetdocParams {
  name: string;
  creatorId: string;
  content?: string;
  isDM?: boolean;
  isUnlisted?: boolean;
  spaceId?: string | null;
}

/**
 * Atomically create a new chat with all required setup:
 * - Creates genus + netdoc (companion chat auto-created by trigger)
 * - Marks chat as standalone
 * - Grants comment permission to creator
 * - Adds to space (profile space if not specified)
 */
export async function createChat(params: CreateChatParams): Promise<string> {
  const { name, creatorId, spaceId } = params;

  const result = await prisma.$queryRaw<{ create_chat: string }[]>`
    SELECT create_chat(${name}, ${creatorId}::uuid, ${spaceId}) as create_chat
  `;

  return result[0].create_chat;
}

/**
 * Atomically create a new netdoc with all required setup:
 * - Creates genus + netdoc
 * - Sets DM mode if needed
 * - Adds to space (profile space if not specified, skipped for DMs)
 * - Enables notifications for creator
 */
export async function createNetdoc(params: CreateNetdocParams): Promise<string> {
  const { name, creatorId, content = '', isDM = false, isUnlisted = false, spaceId } = params;

  const result = await prisma.$queryRaw<{ create_netdoc: string }[]>`
    SELECT create_netdoc(
      ${name},
      ${creatorId}::uuid,
      ${content},
      ${isDM},
      ${isUnlisted},
      ${spaceId}
    ) as create_netdoc
  `;

  return result[0].create_netdoc;
}
