import React from 'react';
import { isGCSMediaUrl } from './utils';
import { AudioPlayer } from './AudioPlayer';

interface MediaEmbedProps {
  url: string;
  isInline?: boolean;
}

/**
 * Renders a single media embed (image, video, or audio)
 */
export const MediaEmbed: React.FC<MediaEmbedProps> = ({ url, isInline = false }) => {
  const { mediaType } = isGCSMediaUrl(url);

  if (mediaType === 'image') {
    return (
      <img
        src={url}
        alt="Embedded media"
        style={{
          maxWidth: '100%',
          width: isInline ? 'auto' : '100%',
          height: 'auto',
          maxHeight: isInline ? '400px' : undefined,
          display: 'block',
          marginTop: isInline ? '0.5em' : undefined,
          marginBottom: isInline ? '0.5em' : undefined
        }}
      />
    );
  }

  if (mediaType === 'video') {
    return (
      <video
        src={url}
        controls
        style={{
          maxWidth: '100%',
          width: isInline ? 'auto' : undefined,
          height: 'auto',
          maxHeight: isInline ? '400px' : undefined,
          display: 'block',
          marginTop: isInline ? '0.5em' : undefined,
          marginBottom: isInline ? '0.5em' : undefined
        }}
      />
    );
  }

  if (mediaType === 'audio') {
    return (
      <AudioPlayer
        url={url}
        style={{
          marginTop: isInline ? '0.5em' : undefined,
          marginBottom: isInline ? '0.5em' : undefined
        }}
      />
    );
  }

  return null;
};

interface MediaGalleryProps {
  urls: string[];
  isOwnPost?: boolean;
}

/**
 * Renders a gallery of media embeds (typically at the top of a post)
 */
export const MediaGallery: React.FC<MediaGalleryProps> = ({ urls, isOwnPost }) => {
  if (urls.length === 0) return null;

  return (
    <div style={{ 
      marginBottom: '0.5em', 
      display: 'flex', 
      flexDirection: 'column', // Force stack to prevent overflow
      alignItems: isOwnPost ? 'flex-end' : 'flex-start' 
    }}>
      {urls.map((url, index) => {
        const { mediaType } = isGCSMediaUrl(url);

        if (mediaType === 'image') {
          return (
            <img
              key={index}
              src={url}
              alt="Uploaded media"
              style={{
                maxWidth: '100%',
                width: '100%',
                height: 'auto',
                display: 'block',
                marginBottom: index < urls.length - 1 ? '0.5em' : '0'
              }}
            />
          );
        } else if (mediaType === 'video') {
          return (
            <video
              key={index}
              src={url}
              controls
              style={{
                maxWidth: '100%',
                height: 'auto',
                display: 'block',
                marginBottom: index < urls.length - 1 ? '0.5em' : '0'
              }}
            />
          );
        } else if (mediaType === 'audio') {
          return (
            <AudioPlayer
              key={index}
              url={url}
              style={{
                marginBottom: index < urls.length - 1 ? '0.5em' : '0'
              }}
            />
          );
        }
        return null;
      })}
    </div>
  );
};

export default MediaEmbed;
