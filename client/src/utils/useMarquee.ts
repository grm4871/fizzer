import { useRef, useEffect, useState, RefObject } from 'react';

interface UseMarqueeResult {
  containerRef: RefObject<HTMLDivElement>;
  measureRef: RefObject<HTMLDivElement>;
  shouldScroll: boolean;
  animationDuration: number;
  animationStyle: React.CSSProperties;
}

/**
 * Hook for marquee scrolling when content overflows container.
 * @param speed - Pixels per second (default 50)
 * @param gap - Gap between duplicated content in pixels (default 48)
 * @param deps - Dependencies to trigger re-measurement
 */
export function useMarquee(
  speed: number = 50,
  gap: number = 48,
  deps: any[] = []
): UseMarqueeResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [shouldScroll, setShouldScroll] = useState(false);
  const [animationDuration, setAnimationDuration] = useState(0);

  useEffect(() => {
    const checkOverflow = () => {
      if (containerRef.current && measureRef.current) {
        const containerWidth = containerRef.current.offsetWidth;
        const contentWidth = measureRef.current.offsetWidth;
        const overflows = contentWidth > containerWidth;
        setShouldScroll(overflows);
        if (overflows) {
          setAnimationDuration((contentWidth + gap) / speed);
        }
      }
    };

    const timer = setTimeout(checkOverflow, 50);
    window.addEventListener('resize', checkOverflow);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', checkOverflow);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const animationStyle: React.CSSProperties = shouldScroll
    ? {
        animation: `marqueeScroll ${animationDuration}s linear infinite`,
      }
    : {};

  return {
    containerRef,
    measureRef,
    shouldScroll,
    animationDuration,
    animationStyle,
  };
}

/** CSS keyframes - inject once in your app or component */
export const marqueeKeyframes = `
  @keyframes marqueeScroll {
    0% { transform: translateX(0); }
    100% { transform: translateX(calc(-50% - 24px)); }
  }
`;
