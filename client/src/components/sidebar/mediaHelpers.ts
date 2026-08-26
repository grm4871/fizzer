/** Identify note links that should be handled by the sidebar audio player. */
export function isMp3Link(label: string, href: string): boolean {
  const normalizedLabel = label.trim().toLowerCase();
  const normalizedHref = href.toLowerCase();
  return normalizedLabel.endsWith('.mp3')
    || normalizedHref.includes('audio/mpeg')
    || normalizedHref.split(/[?#]/)[0].endsWith('.mp3');
}
