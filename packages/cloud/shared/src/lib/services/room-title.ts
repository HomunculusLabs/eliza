/**
 * Assigns deterministic conversation titles without a second model dispatch.
 * Title generation is best-effort metadata and must not create an unmetered
 * provider call after the user-visible response has already completed.
 */
import { memoriesRepository, roomsRepository } from "../../db/repositories";
import { logger } from "../utils/logger";
import { generateFallbackTitle } from "./room-title-fallback";

/**
 * Generate a deterministic title for a room based on the first user message.
 * Only generates if room currently has default title ("New Chat").
 *
 * @param roomId - The room ID to generate title for
 * @returns The generated title, or null if title generation was skipped
 */
export async function generateRoomTitle(roomId: string): Promise<string | null> {
  const room = await roomsRepository.findById(roomId);

  if (!room) {
    logger.warn(`[RoomTitle] Room not found: ${roomId}`);
    return null;
  }

  if (room.name && room.name !== "New Chat") {
    logger.info(`[RoomTitle] Room already has title: ${room.name}`);
    return null;
  }

  const messages = await memoriesRepository.findMessages(roomId, { limit: 6 });

  if (messages.length < 1) {
    return null;
  }

  const userMessage = messages.reverse().find((msg) => {
    const content = msg.content;
    const source = typeof content === "object" ? content?.source : undefined;
    return source === "user";
  });

  if (!userMessage) {
    return null;
  }

  const content = userMessage.content;
  const text = typeof content === "string" ? content : content?.text || "";

  if (!text || text.length < 3) {
    return null;
  }

  const title = generateFallbackTitle(text);

  await roomsRepository.update(roomId, { name: title });

  logger.info(`[RoomTitle] Set title for room ${roomId}: "${title}"`);

  return title;
}
