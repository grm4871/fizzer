import { useEffect, useState, useRef } from 'react';
import type { RemoteUser } from '../hooks/useYjs';

interface CursorOverlayBaseProps {
  remoteUsers: RemoteUser[];
  text: string;
}

interface ContentEditableOverlayProps extends CursorOverlayBaseProps {
  containerRef: React.RefObject<HTMLDivElement>;
  mode?: 'contenteditable';
}

interface TextareaOverlayProps extends CursorOverlayBaseProps {
  containerRef: React.RefObject<HTMLTextAreaElement>;
  mode: 'textarea';
}

type CursorOverlayProps = ContentEditableOverlayProps | TextareaOverlayProps;

interface CursorPosition {
  top: number;
  left: number;
}

/**
 * Get pixel position from a text offset within a contenteditable div.
 * Walks the DOM tree to find the text node at the given offset,
 * creates a Range there, and uses getBoundingClientRect() to get position.
 */
function getCaretCoordinatesContentEditable(container: HTMLDivElement, index: number): CursorPosition | null {
  let remaining = index;

  function findTextNode(node: Node): { node: Node; offset: number } | null {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.textContent?.length || 0;
      if (remaining <= len) {
        return { node, offset: remaining };
      }
      remaining -= len;
      return null;
    }

    // Handle BR elements as newlines
    if (node.nodeName === 'BR') {
      if (remaining <= 0) {
        return { node: node.parentNode!, offset: Array.from(node.parentNode!.childNodes).indexOf(node as ChildNode) };
      }
      remaining -= 1;
      return null;
    }

    // Block elements (DIV, P, LI) that aren't the first child add a newline
    if (node.nodeName === 'DIV' && node.previousSibling) {
      if (remaining <= 0) {
        return { node, offset: 0 };
      }
      remaining -= 1;
    }

    // LI elements: account for data-prefix (bullet/number markers)
    if (node.nodeName === 'LI') {
      if ((node as Element).previousElementSibling) {
        if (remaining <= 0) {
          return { node, offset: 0 };
        }
        remaining -= 1;
      }
      const prefix = (node as Element).getAttribute('data-prefix');
      if (prefix) {
        if (remaining <= prefix.length) {
          return { node, offset: 0 };
        }
        remaining -= prefix.length;
      }
    }

    // Nested UL/OL inside LI: newline before
    if ((node.nodeName === 'UL' || node.nodeName === 'OL') && node.previousSibling && node.parentNode?.nodeName === 'LI') {
      if (remaining <= 0) {
        return { node, offset: 0 };
      }
      remaining -= 1;
    }

    let child = node.firstChild;
    while (child) {
      const result = findTextNode(child);
      if (result) return result;
      child = child.nextSibling;
    }

    // Top-level UL/OL trailing newline
    if ((node.nodeName === 'UL' || node.nodeName === 'OL') && node.parentNode?.nodeName !== 'LI' && node.nextSibling) {
      if (remaining <= 0) {
        return { node: node.parentNode!, offset: Array.from(node.parentNode!.childNodes).indexOf(node as ChildNode) + 1 };
      }
      remaining -= 1;
    }

    return null;
  }

  let child = container.firstChild;
  while (child) {
    const result = findTextNode(child);
    if (result) {
      try {
        const range = document.createRange();
        range.setStart(result.node, result.offset);
        range.collapse(true);
        const rect = range.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        return {
          top: rect.top - containerRect.top + container.scrollTop,
          left: rect.left - containerRect.left + container.scrollLeft
        };
      } catch {
        return null;
      }
    }
    child = child.nextSibling;
  }

  return null;
}

/**
 * Get pixel position from a text offset within a textarea using a mirror div.
 */
function getCaretCoordinatesTextarea(textarea: HTMLTextAreaElement, index: number): CursorPosition {
  const mirror = document.createElement('div');
  const style = window.getComputedStyle(textarea);

  const properties = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
    'letterSpacing', 'lineHeight', 'textTransform',
    'wordWrap', 'wordSpacing', 'whiteSpace', 'paddingLeft',
    'paddingRight', 'paddingTop', 'paddingBottom',
    'borderLeftWidth', 'borderRightWidth', 'borderTopWidth',
    'borderBottomWidth', 'boxSizing'
  ];

  mirror.style.position = 'absolute';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.visibility = 'hidden';
  mirror.style.overflow = 'hidden';
  mirror.style.width = `${textarea.clientWidth}px`;

  properties.forEach(prop => {
    (mirror.style as any)[prop] = style.getPropertyValue(prop.replace(/([A-Z])/g, '-$1').toLowerCase());
  });

  document.body.appendChild(mirror);

  const textBeforeCursor = textarea.value.substring(0, index);
  mirror.textContent = textBeforeCursor;

  const span = document.createElement('span');
  span.textContent = '|';
  mirror.appendChild(span);

  const rect = span.getBoundingClientRect();
  const mirrorRect = mirror.getBoundingClientRect();

  document.body.removeChild(mirror);

  return {
    top: rect.top - mirrorRect.top - textarea.scrollTop,
    left: rect.left - mirrorRect.left - textarea.scrollLeft
  };
}

export default function CursorOverlay(props: CursorOverlayProps) {
  const { containerRef, remoteUsers, text, mode } = props as any;
  const isTextarea = mode === 'textarea';
  const [cursorPositions, setCursorPositions] = useState<Map<number, CursorPosition>>(new Map());
  const rafRef = useRef<number>();
  const remoteUsersRef = useRef(remoteUsers);
  remoteUsersRef.current = remoteUsers;
  const textRef = useRef(text);
  textRef.current = text;

  // Stable position updater that reads from refs
  const scheduleUpdate = useRef(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) return;
      const positions = new Map<number, CursorPosition>();
      const currentText = textRef.current;
      const currentUsers = remoteUsersRef.current;

      currentUsers.forEach((user: RemoteUser) => {
        if (user.cursor && typeof user.cursor.index === 'number') {
          const index = Math.min(user.cursor.index, currentText.length);
          const pos = isTextarea
            ? getCaretCoordinatesTextarea(container as HTMLTextAreaElement, index)
            : getCaretCoordinatesContentEditable(container as HTMLDivElement, index);
          if (pos) {
            positions.set(user.clientId, pos);
          }
        }
      });

      setCursorPositions(positions);
    });
  });

  // Recalculate on remoteUsers/text changes (after DOM paint via RAF)
  useEffect(() => {
    scheduleUpdate.current();
  }, [remoteUsers, text]);

  // Recalculate on scroll, resize, and DOM mutations
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleEvent = () => scheduleUpdate.current();

    container.addEventListener('scroll', handleEvent);

    // Recalculate when container size changes (window resize, layout shift)
    const resizeObserver = new ResizeObserver(handleEvent);
    resizeObserver.observe(container);

    // Recalculate when DOM content changes (re-rendered HTML)
    const mutationObserver = new MutationObserver(handleEvent);
    mutationObserver.observe(container, { childList: true, subtree: true, characterData: true });

    return () => {
      container.removeEventListener('scroll', handleEvent);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [containerRef, isTextarea]);

  if (!containerRef.current) return null;

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: 'none',
        overflow: 'hidden'
      }}
    >
      {remoteUsers.map(user => {
        const pos = cursorPositions.get(user.clientId);
        if (!pos) return null;

        return (
          <div key={user.clientId} style={{ position: 'absolute', top: pos.top, left: pos.left }}>
            {/* Cursor line */}
            <div
              style={{
                width: '2px',
                height: '1.2em',
                backgroundColor: `#${user.color}`,
                position: 'absolute',
                top: 0,
                left: 0
              }}
            />
            {/* Name label */}
            <div
              style={{
                position: 'absolute',
                top: '-1.4em',
                left: 0,
                backgroundColor: `#${user.color}`,
                color: '#000',
                fontSize: '0.7em',
                padding: '1px 4px',
                borderRadius: '2px',
                whiteSpace: 'nowrap',
                fontWeight: 500
              }}
            >
              {user.name}
            </div>
          </div>
        );
      })}
    </div>
  );
}
