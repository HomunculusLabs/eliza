/**
 * Media utilities for Eliza.
 *
 * Provides MIME type detection, media parsing, fetching, and format utilities.
 */

export {
  type FetchLike,
  type FetchMediaOptions,
  type FetchMediaResult,
  fetchRemoteMedia,
  MediaFetchError,
  type MediaFetchErrorCode,
  readResponseWithLimit,
} from "./fetch.js";
export {
  type CachedImageDescription,
  describeImageCached,
  getCachedImageDescription,
  imageDescriptionCacheKey,
  normalizeImageDescription,
  setCachedImageDescription,
} from "./image-description-cache.js";
export {
  trustedLocalMediaUrl,
  VISION_IMAGE_FETCH_TIMEOUT_MS,
  VISION_IMAGE_MAX_BYTES,
} from "./local-store.js";
export {
  detectMime,
  extensionForMime,
  getFileExtension,
  imageMimeFromFormat,
  isAudioFileName,
  isGifMedia,
  isVoiceCompatibleAudio,
  type MediaKind,
  mediaKindFromMime,
} from "./mime.js";
export {
  MEDIA_WRITE_PORT_SERVICE,
  type MediaWritePort,
  MediaWritePortUnavailableError,
  type MediaWriteResult,
  requireMediaWritePort,
} from "./port.js";
