/**
 * Media widgets and upload helpers for Markdown images/audio/video.
 * Asset URLs use authenticated fetch for note-local paths; image resizing writes
 * the Obsidian-style width back to the source line.
 */
import { EditorView, WidgetType } from '@codemirror/view';
import { acquireInteractionLock, bindDragGesture, releaseInteractionLock } from '../ui/interactionLocks';

export const NOTE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const NOTE_AUDIO_MAX_BYTES = 8 * 1024 * 1024;

export function imageFileFromDataTransfer(dataTransfer: DataTransfer | null): File | null {
  if (!dataTransfer) return null;
  const fromFiles = Array.from(dataTransfer.files || []).find((file) => file.type.startsWith('image/'));
  if (fromFiles) return fromFiles;
  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.split(',')[1] || '');
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read image'));
    reader.readAsDataURL(file);
  });
}

export function resolveAssetUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const apiBase = import.meta.env.VITE_API_URL || '';
  return `${apiBase}${url.startsWith('/') ? url : `/${url}`}`;
}

/** Obsidian-style image size in alt: `![caption|320]` or `![caption|320x240]`. */
const IMAGE_ALT_SIZE_RE = /^(.*?)\|(\d{1,5})(?:x(\d{1,5}))?\s*$/;
export const IMAGE_LINE_RE = /^(\s*)!\[([^\]]*)\]\(([^)]+)\)\s*$/;
const IMAGE_MIN_WIDTH_PX = 80;

export function parseImageAlt(raw: string): { alt: string; width: number | null } {
  const m = raw.match(IMAGE_ALT_SIZE_RE);
  if (!m) return { alt: raw, width: null };
  const width = Math.max(1, parseInt(m[2], 10));
  return { alt: m[1], width };
}

export function formatImageMarkdown(indent: string, alt: string, url: string, width: number | null): string {
  const cleanAlt = alt.replace(/\|/g, ' ').trim();
  const altPart = width != null && width > 0 ? `${cleanAlt}|${Math.round(width)}` : cleanAlt;
  return `${indent}![${altPart}](${url})`;
}

export function clampImageWidth(px: number, maxWidth: number): number {
  const max = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : 2400;
  return Math.min(max, Math.max(IMAGE_MIN_WIDTH_PX, Math.round(px)));
}

export function applyImageWidth(img: HTMLImageElement, width: number | null) {
  if (width != null && width > 0) {
    img.style.width = `${width}px`;
    img.style.maxWidth = '100%';
    img.style.height = 'auto';
  } else {
    img.style.width = '';
    img.style.maxWidth = '100%';
    img.style.height = 'auto';
  }
}

export function rewriteImageLineWidth(view: EditorView, wrap: HTMLElement, width: number | null): boolean {
  let pos: number;
  try {
    pos = view.posAtDOM(wrap);
  } catch {
    return false;
  }
  const line = view.state.doc.lineAt(pos);
  const match = line.text.match(IMAGE_LINE_RE);
  if (!match) return false;
  const [, indent, rawAlt, url] = match;
  const { alt } = parseImageAlt(rawAlt);
  const next = formatImageMarkdown(indent, alt, url, width);
  if (next === line.text) return true;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: next },
  });
  return true;
}

/* ─── Image Widget ───────────────────────────────────────── */
export function isVideoMarkdownTarget(alt: string, url: string): boolean {
  const lowerAlt = alt.toLowerCase();
  const lowerUrl = url.toLowerCase();
  return lowerAlt.endsWith('.mp4')
    || lowerUrl.includes('video/mp4')
    || /\.mp4(\?|$)/.test(lowerUrl)
    || lowerUrl.endsWith('.mp4');
}

export class VideoWidget extends WidgetType {
  constructor(
    private alt: string,
    private url: string,
  ) {
    super();
  }

  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-video-wrap';
    const video = document.createElement('video');
    video.className = 'cm-md-video is-loading';
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    const label = document.createElement('div');
    label.className = 'cm-md-video-label';
    label.textContent = this.alt || 'video.mp4';

    const resolved = resolveAssetUrl(this.url);
    const finish = (src: string) => {
      video.src = src;
      video.onloadeddata = () => video.classList.remove('is-loading');
      video.onerror = () => {
        video.classList.remove('is-loading');
        video.classList.add('is-error');
      };
    };

    if (/^https?:\/\//i.test(resolved) && !resolved.includes('/api/notes/')) {
      finish(resolved);
    } else {
      fetch(resolved, {
        credentials: 'include',
      })
        .then((res) => {
          if (!res.ok) throw new Error('load failed');
          return res.blob();
        })
        .then((blob) => finish(URL.createObjectURL(blob)))
        .catch(() => {
          video.classList.remove('is-loading');
          video.classList.add('is-error');
        });
    }

    wrap.appendChild(video);
    wrap.appendChild(label);
    return wrap;
  }

  eq(other: VideoWidget) {
    return this.alt === other.alt && this.url === other.url;
  }

  ignoreEvent() {
    return true;
  }
}

export class ImageWidget extends WidgetType {
  constructor(
    private alt: string,
    private url: string,
    private width: number | null = null,
  ) {
    super();
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement('span');
    wrap.className = 'cm-md-image-wrap';
    wrap.setAttribute('data-image-url', this.url);

    const img = document.createElement('img');
    img.className = 'cm-md-image is-loading';
    img.alt = this.alt || 'image';
    img.draggable = false;
    applyImageWidth(img, this.width);

    const handle = document.createElement('span');
    handle.className = 'cm-md-image-resize';
    handle.setAttribute('role', 'slider');
    handle.setAttribute('aria-label', 'Drag to resize image');
    handle.setAttribute('aria-orientation', 'horizontal');
    handle.tabIndex = -1;

    const sizeLabel = document.createElement('span');
    sizeLabel.className = 'cm-md-image-size';
    sizeLabel.setAttribute('aria-hidden', 'true');
    if (this.width != null) sizeLabel.textContent = `${this.width}px`;

    const maxWidthFor = () => {
      const scroller = view.scrollDOM;
      const contentPad = 52; // .cm-content horizontal padding
      const available = (scroller?.clientWidth ?? 800) - contentPad;
      return Math.max(IMAGE_MIN_WIDTH_PX, available);
    };

    handle.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const startX = event.clientX;
      const startW = img.getBoundingClientRect().width || this.width || IMAGE_MIN_WIDTH_PX;
      const maxW = maxWidthFor();
      wrap.classList.add('is-resizing');
      acquireInteractionLock({ cursor: 'nwse-resize' });
      let lastX = startX;

      bindDragGesture({
        onMove: (ev) => {
          lastX = ev.clientX;
          const next = clampImageWidth(startW + (ev.clientX - startX), maxW);
          applyImageWidth(img, next);
          sizeLabel.textContent = `${next}px`;
        },
        onEnd: () => {
          wrap.classList.remove('is-resizing');
          releaseInteractionLock();
          const next = clampImageWidth(startW + (lastX - startX), maxW);
          applyImageWidth(img, next);
          sizeLabel.textContent = `${next}px`;
          rewriteImageLineWidth(view, wrap, next);
        },
      });
    });

    // Double-click handle resets to natural size.
    handle.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      applyImageWidth(img, null);
      sizeLabel.textContent = '';
      rewriteImageLineWidth(view, wrap, null);
    });

    const resolved = resolveAssetUrl(this.url);
    if (/^https?:\/\//i.test(resolved) && !resolved.includes('/api/notes/')) {
      img.src = resolved;
      img.onload = () => img.classList.remove('is-loading');
      img.onerror = () => {
        img.classList.remove('is-loading');
        img.classList.add('is-error');
        img.alt = 'Failed to load image';
      };
      wrap.appendChild(img);
      wrap.appendChild(handle);
      wrap.appendChild(sizeLabel);
      return wrap;
    }

    fetch(resolved, {
      credentials: 'include',
    })
      .then((res) => {
        if (!res.ok) throw new Error('load failed');
        return res.blob();
      })
      .then((blob) => {
        img.src = URL.createObjectURL(blob);
        img.onload = () => img.classList.remove('is-loading');
      })
      .catch(() => {
        img.classList.remove('is-loading');
        img.classList.add('is-error');
        img.alt = 'Failed to load image';
      });

    wrap.appendChild(img);
    wrap.appendChild(handle);
    wrap.appendChild(sizeLabel);
    return wrap;
  }

  eq(other: ImageWidget) {
    return this.alt === other.alt && this.url === other.url && this.width === other.width;
  }

  ignoreEvent(event: Event) {
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('.cm-md-image-resize')) return true;
    // Allow editor selection on the image body (click-through to edit source line).
    return false;
  }
}
