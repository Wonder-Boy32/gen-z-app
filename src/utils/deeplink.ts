// Deep-link parsing for anonymous-message links.
// Supported formats:
//   genz://anon/@username
//   genz://anon/username
//   https://genz.app/anon/@username
//   https://genz.app/anon/username
export function parseAnonLink(url: string): string | null {
  if (!url) return null;
  try {
    const m = url.match(/\/(?:anon|anonymous)\/(?:@)?([^/?#]+)/i);
    if (!m) return null;
    const name = decodeURIComponent(m[1]).trim();
    return name.length ? name : null;
  } catch {
    return null;
  }
}
