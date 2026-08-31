// Coordinates cloud service room title behavior behind route handlers.
import { assertModelOutputComplete } from "@elizaos/core";
import { generateText } from "ai";
import { memoriesRepository, roomsRepository } from "../../db/repositories";
import { getLanguageModel } from "../providers/language-model";
import { logger } from "../utils/logger";
import { generateFallbackTitle } from "./room-title-fallback";

/**
 * Generate an AI-powered title for a room based on the first user message.
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

  // Generate AI title
  let title: string;

  try {
    const prompt = `Create a brief 3-5 word title summarizing this message topic. Output ONLY the title, no quotes or explanation.

Message: ${text}

Title:`;

    logger.info(`[RoomTitle] Generating AI title for room ${roomId}`);

    const result = await generateText({
      model: getLanguageModel("openai/gpt-5-mini"),
      prompt,
    });
    assertModelOutputComplete({
      finishReason: result.finishReason,
      provider: "openai",
      model: "gpt-5-mini",
    });

    // Normalizes the generated title
    title = result.text
      .trim()
      .replace(/^["']|["']$/g, "") // Remove quotes
      .replace(/^Title:\s*/i, "") // Remove "Title:" prefix if present
      .replace(/[.!?]$/, ""); // Remove trailing punctuation

    logger.info(`[RoomTitle] AI generated: "${title}"`);

    // Validate title is reasonable
    if (!title || title.length < 3 || title.length > 50 || title.includes("\n")) {
      logger.warn(`[RoomTitle] Invalid AI title, using fallback`);
      title = generateFallbackTitle(text);
    }
  } catch (error) {
    logger.error(`[RoomTitle] AI generation failed:`, error);
    title = generateFallbackTitle(text);
  }

  await roomsRepository.update(roomId, { name: title });

  logger.info(`[RoomTitle] Set title for room ${roomId}: "${title}"`);

  return title;
}

