/**
 * Returns true if the text contains any Hebrew characters.
 * Used to conditionally apply RTL text style.
 */
export function isHebrew(text: string): boolean {
  return /[֐-׿יִ-ﭏ]/.test(text);
}

/**
 * Normalise a Hebrew subtitle string:
 *  - Prepend RTL mark so mixed punctuation resolves correctly
 *  - Strip leading/trailing whitespace
 */
export function normaliseHebrewText(text: string): string {
  const RTL_MARK = '‏';
  return `${RTL_MARK}${text.trim()}`;
}

/**
 * Returns the React Native writingDirection / textAlign for subtitle display.
 */
export const hebrewTextStyle = {
  writingDirection: 'rtl' as const,
  textAlign: 'right' as const,
} as const;
