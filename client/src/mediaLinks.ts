export function youtubeVideoId(href: string) {
  try {
    const url = new URL(href, 'http://localhost');
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let id = '';
    if (host === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0] || '';
    else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      if (url.pathname === '/watch') id = url.searchParams.get('v') || '';
      else id = url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?#]+)/)?.[1] || '';
    }
    return /^[A-Za-z0-9_-]{6,15}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
