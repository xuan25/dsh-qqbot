/**
 * Check if the given text is a NO_REPLY signal.
 * @param text The text to check.
 * @returns True if the text is a NO_REPLY signal, false otherwise.
 */
export function isNoReplyReply(text: string): boolean {
  return text.trim() === 'NO_REPLY';
}