import { useEffect, useRef, useState } from 'react';
import { Music2, Pause, Play, SkipBack, SkipForward, X } from 'lucide-react';
import {
  YOUTUBE_EMBED_CONTROL_EVENT,
  YOUTUBE_EMBED_STATE_EVENT,
  type YouTubeEmbedControlDetail,
  type YouTubeEmbedStateDetail,
} from '../../mediaLinks';
import { isMp3Link } from './mediaHelpers';
import type { MediaTrack } from './types';

/**
 * Media event ordering is intentional: capture note-link clicks first, then
 * let the selected track effect load/play audio. YouTube state events replace
 * the local track and pause HTML audio before updating the play indicator.
 */
export function SidebarAudioPlayer() {
  const [audioTracks, setAudioTracks] = useState<MediaTrack[]>([]);
  const [audioTrackIndex, setAudioTrackIndex] = useState(0);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const autoplayAudioRef = useRef(false);

  useEffect(() => {
    const mediaTrackFor = (anchor: HTMLAnchorElement): MediaTrack | null => {
      const label = (anchor.textContent || '').trim();
      if (!isMp3Link(label, anchor.href)) return null;
      return { kind: 'audio', name: (label || 'Audio').replace(/\.mp3$/i, ''), url: anchor.href };
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest('a') : null;
      if (!(target instanceof HTMLAnchorElement) || !mediaTrackFor(target)) return;
      event.preventDefault();
      event.stopPropagation();
      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a'));
      const seen = new Set<string>();
      const tracks = links.flatMap((anchor) => {
        const track = mediaTrackFor(anchor);
        if (!track || !anchor.href || seen.has(anchor.href)) return [];
        seen.add(anchor.href);
        return [track];
      });
      const index = Math.max(0, tracks.findIndex((track) => track.url === target.href));
      audioRef.current?.pause();
      autoplayAudioRef.current = true;
      setAudioTrackIndex(index);
      setAudioTracks(tracks);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  useEffect(() => {
    const track = audioTracks[audioTrackIndex];
    if (!track || track.kind === 'youtube') return;
    const audio = audioRef.current;
    if (!audio) return;
    audio.load();
    if (autoplayAudioRef.current) void audio.play().catch(() => setAudioPlaying(false));
  }, [audioTrackIndex, audioTracks]);

  useEffect(() => {
    const onEmbedState = (event: Event) => {
      const detail = (event as CustomEvent<YouTubeEmbedStateDetail>).detail;
      if (!detail?.videoId) return;
      if (detail.state === 1) {
        audioRef.current?.pause();
        setAudioTrackIndex(0);
        setAudioTracks([{ kind: 'youtube', name: detail.title || 'YouTube video', url: detail.url, videoId: detail.videoId }]);
      }
      setAudioPlaying(detail.state === 1);
    };
    window.addEventListener(YOUTUBE_EMBED_STATE_EVENT, onEmbedState);
    return () => window.removeEventListener(YOUTUBE_EMBED_STATE_EVENT, onEmbedState);
  }, []);

  const changeAudioTrack = (offset: number, autoplay = audioPlaying) => {
    if (audioTracks.length === 0) return;
    autoplayAudioRef.current = autoplay;
    setAudioTrackIndex((current) => (current + offset + audioTracks.length) % audioTracks.length);
  };

  const toggleAudioPlayback = () => {
    const track = audioTracks[audioTrackIndex];
    if (track?.kind === 'youtube') {
      const func = audioPlaying ? 'pauseVideo' : 'playVideo';
      window.dispatchEvent(new CustomEvent<YouTubeEmbedControlDetail>(YOUTUBE_EMBED_CONTROL_EVENT, { detail: { videoId: track.videoId, func } }));
      return;
    }
    const audio = audioRef.current;
    if (!audio || audioTracks.length === 0) return;
    if (audio.paused) void audio.play().catch(() => setAudioPlaying(false));
    else audio.pause();
  };

  if (audioTracks.length === 0) return null;
  const track = audioTracks[audioTrackIndex];
  return (
    <div className="sidebar-audio-player">
      <audio ref={audioRef} src={track?.kind === 'audio' ? track.url : undefined} onPlay={() => setAudioPlaying(true)} onPause={() => setAudioPlaying(false)} onEnded={() => changeAudioTrack(1, true)} />
      <div className="sidebar-audio-track" title={track?.name}><Music2 size={14} /><span>{track?.name}</span></div>
      <div className="sidebar-audio-controls">
        <button className="btn-icon" disabled={audioTracks.length === 0} onClick={() => changeAudioTrack(-1)} title="Previous track"><SkipBack size={15} fill="currentColor" /></button>
        <button className="btn-icon sidebar-audio-play" onClick={toggleAudioPlayback} title={audioPlaying ? 'Pause' : 'Play'}>{audioPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button>
        <button className="btn-icon" disabled={audioTracks.length === 0} onClick={() => changeAudioTrack(1)} title="Next track"><SkipForward size={15} fill="currentColor" /></button>
        <button className="btn-icon" onClick={() => { audioRef.current?.pause(); setAudioPlaying(false); setAudioTracks([]); setAudioTrackIndex(0); }} title="Close player" aria-label="Close player"><X size={15} /></button>
      </div>
    </div>
  );
}
