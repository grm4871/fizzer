import React from 'react';

interface UniversalEmbedProps {
    url: string;
    title?: string;
}

/**
 * Helper to get the embed URL for a given service URL
 * Returns null if the service is not supported or URL is invalid
 */
export const getEmbedUrl = (url: string): string | null => {
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.toLowerCase();
        const pathname = urlObj.pathname;
        const searchParams = urlObj.searchParams;

        // YouTube
        if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
            let videoId = '';
            if (hostname.includes('youtu.be')) {
                videoId = pathname.slice(1);
            } else if (pathname.includes('/watch')) {
                videoId = searchParams.get('v') || '';
            } else if (pathname.includes('/embed/')) {
                videoId = pathname.split('/embed/')[1];
            } else if (pathname.includes('/shorts/')) {
                videoId = pathname.split('/shorts/')[1];
            }

            if (videoId) {
                return `https://www.youtube.com/embed/${videoId}`;
            }
        }

        // Spotify
        if (hostname.includes('spotify.com')) {
            // Convert https://open.spotify.com/track/ID to https://open.spotify.com/embed/track/ID
            if (pathname.startsWith('/track/') || pathname.startsWith('/album/') || pathname.startsWith('/playlist/') || pathname.startsWith('/artist/') || pathname.startsWith('/episode/')) {
                return `https://open.spotify.com/embed${pathname}`;
            }
        }

        // Apple Music
        if (hostname.includes('music.apple.com')) {
            // Convert https://music.apple.com/us/album/song/ID to https://embed.music.apple.com/us/album/song/ID
            return url.replace('music.apple.com', 'embed.music.apple.com');
        }

        // SoundCloud
        if (hostname.includes('soundcloud.com')) {
            return `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&color=%23ff5500&auto_play=false&hide_related=false&show_comments=true&show_user=true&show_reposts=false&show_teaser=true&visual=true`;
        }

        /*
        // Vimeo
        if (hostname.includes('vimeo.com')) {
            const videoId = pathname.split('/').pop();
            if (videoId && /^\d+$/.test(videoId)) {
                return `https://player.vimeo.com/video/${videoId}`;
            }
        }

        // Twitch
        if (hostname.includes('twitch.tv')) {
            const parent = window.location.hostname;
            if (pathname.includes('/videos/')) {
                const videoId = pathname.split('/videos/')[1];
                return `https://player.twitch.tv/?video=${videoId}&parent=${parent}`;
            } else if (pathname !== '/') {
                const channel = pathname.slice(1);
                return `https://player.twitch.tv/?channel=${channel}&parent=${parent}`;
            }
        }

        // TikTok
        if (hostname.includes('tiktok.com') && pathname.includes('/video/')) {
            const videoId = pathname.split('/video/')[1];
            return `https://www.tiktok.com/embed/v2/${videoId}`;
        }

        // Twitter / X
        // Note: Twitter embeds usually require a script tag or API, but we can try a simple iframe approach 
        // or rely on a third-party embedder if standard iframe isn't supported directly.
        // For now, we'll skip direct Twitter iframe as it's complex without the script.
        // But user asked for it. Let's use a generic oEmbed wrapper or similar if possible?
        // Actually, Twitter doesn't support direct iframes easily without their widget.js.
        // Let's stick to the ones that support direct iframes for now, or use a service like twitframe.com
        if (hostname.includes('twitter.com') || hostname.includes('x.com')) {
            // Extract tweet ID
            const match = pathname.match(/\/status\/(\d+)/);
            if (match && match[1]) {
                return `https://platform.twitter.com/embed/Tweet.html?id=${match[1]}`;
            }
        }

        // Reddit
        // Reddit allows embedding via 'embed' in the path? No, usually scripts.
        // But we can try to use the embed URL if we can construct it.
        // https://www.reddit.com/r/subreddit/comments/id/title/ -> https://www.reddit.com/r/subreddit/comments/id/title/?embed=true
        // Actually Reddit embeds are also script based usually.
        // Let's try appending ?embed=true but it might not work in a simple iframe without X-Frame-Options issues.
        // We will skip Reddit for now if it requires scripts, unless we find a pure iframe way.

        // Dailymotion
        if (hostname.includes('dailymotion.com')) {
            if (pathname.includes('/video/')) {
                const videoId = pathname.split('/video/')[1];
                return `https://www.dailymotion.com/embed/video/${videoId}`;
            }
        }

        // Instagram
        if (hostname.includes('instagram.com')) {
            // /p/ID, /reel/ID, /tv/ID
            if (pathname.includes('/p/') || pathname.includes('/reel/') || pathname.includes('/tv/')) {
                // Remove trailing slash if present
                const cleanPath = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
                return `https://www.instagram.com${cleanPath}/embed`;
            }
        }

        // Mastodon (generic check for /@user/id)
        // This is tricky as there are many instances. We might check for specific structure.
        // For now, let's skip generic Mastodon unless we have a specific list of instances or a reliable pattern.

        // Figma
        if (hostname.includes('figma.com')) {
            return `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(url)}`;
        }

        // CodePen
        if (hostname.includes('codepen.io')) {
            // /user/pen/slug
            if (pathname.includes('/pen/')) {
                // Transform to /user/embed/slug
                // Actually simplest is replacing /pen/ with /embed/
                return url.replace('/pen/', '/embed/');
            }
        }

        // JSFiddle
        if (hostname.includes('jsfiddle.net')) {
            // /user/slug/
            if (!pathname.includes('/embedded/')) {
                const cleanPath = pathname.endsWith('/') ? pathname : pathname + '/';
                return `https://jsfiddle.net${cleanPath}embedded/`;
            }
            return url;
        }

        // Replit
        if (hostname.includes('replit.com') && pathname.startsWith('/@')) {
            return `${url}?embed=true`;
        }

        // Giphy
        if (hostname.includes('giphy.com')) {
            // /gifs/slug-id or /gifs/id
            const parts = pathname.split('-');
            const id = parts[parts.length - 1];
            if (id) {
                return `https://giphy.com/embed/${id}`;
            }
        }

        // Imgur
        if (hostname.includes('imgur.com')) {
            // /a/id or /gallery/id
            if (pathname.startsWith('/a/') || pathname.startsWith('/gallery/')) {
                const id = pathname.split('/').pop();
                return `https://imgur.com/a/${id}/embed`;
            }
        }

        // Google Forms
        if (hostname.includes('docs.google.com') && pathname.includes('/forms/')) {
            if (pathname.endsWith('/viewform')) {
                return `${url}?embedded=true`;
            }
            return `${url}/viewform?embedded=true`;
        }

        // Typeform
        if (hostname.includes('typeform.com') && pathname.includes('/to/')) {
            // Typeform usually requires script, but we can try generic iframe
            return url;
        }

        // Calendly
        if (hostname.includes('calendly.com')) {
            return url;
        }

        // Airtable
        if (hostname.includes('airtable.com')) {
            if (pathname.startsWith('/embed/')) return url;
            // Standard share URLs often redirect to embed or can be embedded
            return `https://airtable.com/embed/${pathname.split('/').pop()}`;
        }
        // Loom
        if (hostname.includes('loom.com') && pathname.startsWith('/share/')) {
            const videoId = pathname.split('/share/')[1];
            return `https://www.loom.com/embed/${videoId}`;
        }
        */

    } catch (e) {
        return null;
    }
    return null;
};

export default function UniversalEmbed({ url, title }: UniversalEmbedProps) {
    const embedUrl = getEmbedUrl(url);

    if (!embedUrl) return null;

    // Determine aspect ratio based on service
    let aspectRatio = '56.25%'; // 16:9 default
    let height = 'auto';
    let maxWidth = '600px';

    if (embedUrl.includes('spotify.com')) {
        aspectRatio = '0';
        height = '152px'; // Standard Spotify embed height
        if (embedUrl.includes('/episode/')) height = '232px'; // Taller for episodes
    } else if (embedUrl.includes('soundcloud.com')) {
        aspectRatio = '0';
        height = '166px';
    } else if (embedUrl.includes('music.apple.com')) {
        aspectRatio = '0';
        height = '150px'; // Standard Apple Music height
        if (embedUrl.includes('/album/')) height = '450px'; // Taller for albums
    } else if (embedUrl.includes('youtube.com/embed/')) {
        // Fixed height for YouTube as requested
        height = '208px';
        aspectRatio = '0';
        maxWidth = '370px'; // 208 * 16/9 ≈ 370
    }

    return (
        <div
            className="universal-embed"
            style={{
                marginTop: '0.5em',
                marginBottom: '0.5em',
                width: maxWidth,
                maxWidth: '100%',
                position: 'relative',
                paddingBottom: aspectRatio,
                height: aspectRatio === '0' ? height : 0,
                overflow: 'hidden',
                background: '#000',
                borderRadius: '4px',
                border: '1px solid #333'
            }}
        >
            <iframe
                src={embedUrl}
                title={title || 'Embedded content'}
                frameBorder="0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
                style={{
                    position: aspectRatio === '0' ? 'relative' : 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: aspectRatio === '0' ? '100%' : '100%',
                }}
            />
        </div>
    );
}
