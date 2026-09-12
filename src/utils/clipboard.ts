/**
 * Copy text to the clipboard. Uses a defensive require because the native
 * clipboard module can be missing in older dev-client builds - a failure
 * must return false rather than throw.
 */
export async function copyToClipboard(value: string): Promise<boolean> {
  try {
    const C = require('expo-clipboard');
    const ok = await C.setStringAsync?.(value);
    return ok !== false;
  } catch {
    return false;
  }
}
