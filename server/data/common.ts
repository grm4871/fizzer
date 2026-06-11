import { prisma } from './prisma-client.js';
import { findEarliestId } from '../routes/utils/b32id.js';

/**
 * Create a status message netdoc (system message with no creator)
 * Used for DM requests, topic changes, etc.
 * @param content - The status message content
 * @returns The created genus id
 */
export async function createStatusNetdoc(content: string): Promise<string | null> {
  const newId = await findEarliestId('genus');
  const genus = await prisma.genus.create({
    data: {
      id: newId,
      name: '',
      creator_id: null,
      netdoc: { create: { content, status_message: true } }
    }
  });
  return genus.id;
}

/**
 * Create a status message in a chat (system message with no sender)
 * Used for topic changes, ban/unban notices, etc.
 * @param chatId - The chat to post the status message in
 * @param content - The status message content
 * @returns The created chat_message id
 */
export async function createStatusMessage(chatId: string, content: string): Promise<bigint | null> {
  const msg = await prisma.chat_message.create({
    data: {
      chat_id: chatId,
      content,
      sender_id: null,
      status_message: true
    }
  });
  return msg.id;
}
