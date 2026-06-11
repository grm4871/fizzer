import { useState, useImperativeHandle, forwardRef } from 'react';
import cardsMiddle from '../../../icons/cardsMiddle.svg';
import cardFirstPokeOut from '../../../icons/cardFirstPokeOut.svg';
import cardSecondPokeOut from '../../../icons/cardSecondPokeOut.svg';
import eyeball from '../../../icons/eyeball.svg';
import write from '../../../icons/write.svg';
import { LayoutMode } from '../../../types/routing';

// Mode icons - each mode has an associated icon
const ICONS: Record<LayoutMode, string> = { read: eyeball, write };

// Decks define which modes are available in different contexts.
// - Single-card decks are "locked" (gray, non-interactive)
// - Multi-card decks allow cycling (gold, interactive)
// - Card position in deck determines the visual poke-outs:
//   first card = poke left, last card = poke right, middle = both
const DECKS: Record<string, LayoutMode[]> = {
  'document-owner': ['read', 'write'],
  'new-document': ['write'],
  'non-netdoc': ['read'],
};

const GRAY_FILTER = 'brightness(0) saturate(100%) invert(33%) sepia(0%) saturate(0%) hue-rotate(0deg) brightness(100%) contrast(100%)';
const GOLD_FILTER = 'brightness(0) saturate(100%) invert(87%) sepia(10%) saturate(726%) hue-rotate(347deg) brightness(91%) contrast(88%)';

interface ModeCyclerProps {
  mode: LayoutMode;
  setMode: (mode: LayoutMode) => void;
  canWrite: boolean;
  isNetdoc: boolean;
  isCreatingNewNetdoc?: boolean;
  isOwner?: boolean;
  isSpace?: boolean;
  spaceCanWrite?: boolean;
}

export interface ModeCyclerHandle {
  cycle: () => void;
  cycleReverse: () => void;
}

function selectDeck(props: {
  isCreatingNewNetdoc: boolean;
  isNetdoc: boolean;
  isOwner: boolean;
  canWrite: boolean;
  isSpace: boolean;
  spaceCanWrite: boolean;
}): LayoutMode[] {
  if (props.isCreatingNewNetdoc) return DECKS['new-document'];
  if (props.isSpace) {
    const deck: LayoutMode[] = ['read'];
    if (props.spaceCanWrite) deck.push('write');
    return deck;
  }
  if (!props.isNetdoc) return DECKS['non-netdoc'];
  
  if (props.isOwner) {
    return DECKS['document-owner'];
  }

  const deck: LayoutMode[] = ['read'];
  if (props.canWrite) deck.push('write');
  return deck;
}

function renderCard(mode: LayoutMode, deck: LayoutMode[], filter: string) {
  const index = deck.indexOf(mode);
  const safeIndex = index === -1 ? 0 : index;
  const leftCount = deck.length - 1 - safeIndex;
  const rightCount = safeIndex;

  return (
    <div style={{ position: 'relative', width: '36px', height: '36px', userSelect: 'none' }}>
      <img src={cardsMiddle} alt="Layout" style={{ width: '36px', height: '36px', filter: filter === GRAY_FILTER ? filter : undefined }} draggable={false} />

      {/* Left poke-outs */}
      {leftCount >= 1 && (
        <img src={cardFirstPokeOut} alt="" style={{ position: 'absolute', top: 0, left: 0, width: '36px', height: '36px' }} draggable={false} />
      )}
      {leftCount >= 2 && (
        <img src={cardSecondPokeOut} alt="" style={{ position: 'absolute', top: 0, left: 0, width: '36px', height: '36px' }} draggable={false} />
      )}

      {/* Right poke-outs */}
      {rightCount >= 1 && (
        <img src={cardFirstPokeOut} alt="" style={{ position: 'absolute', top: 0, left: '1px', width: '36px', height: '36px', transform: 'scaleX(-1)' }} draggable={false} />
      )}
      {rightCount >= 2 && (
        <img src={cardSecondPokeOut} alt="" style={{ position: 'absolute', top: 0, left: '1px', width: '36px', height: '36px', transform: 'scaleX(-1)' }} draggable={false} />
      )}

      {/* Center icon */}
      <img src={ICONS[mode]} alt="" style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: '14px', height: '14px', filter }} draggable={false} />
    </div>
  );
}

const ModeCycler = forwardRef<ModeCyclerHandle, ModeCyclerProps>(({
  mode,
  setMode,
  canWrite,
  isNetdoc,
  isCreatingNewNetdoc = false,
  isOwner = false,
  isSpace = false,
  spaceCanWrite = false,
}, ref) => {
  const [direction, setDirection] = useState<'down' | 'up'>('down');

  const deck = selectDeck({ isCreatingNewNetdoc, isNetdoc, isOwner, canWrite, isSpace, spaceCanWrite });
  const isLocked = deck.length === 1;

  // Ensure mode is valid for this deck
  const currentIndex = deck.indexOf(mode);
  const safeMode = currentIndex === -1 ? deck[0] : mode;

  const cycle = (shift: boolean = false) => {
    const idx = deck.indexOf(safeMode);

    if (deck.length === 2) {
      // Simple toggle for 2-card decks
      setMode(deck[(idx + 1) % 2]);
      return;
    }

    // Shift+click jumps to the opposite end of the deck
    if (shift) {
      if (safeMode === deck[deck.length - 1]) {
        setMode(deck[0]);
        setDirection('up');
      } else {
        setMode(deck[deck.length - 1]);
        setDirection('down');
      }
      return;
    }

    let nextIndex: number;
    let newDirection = direction;

    if (direction === 'down') {
      if (idx === deck.length - 1) {
        nextIndex = idx - 1;
        newDirection = 'up';
      } else {
        nextIndex = idx + 1;
      }
    } else {
      if (idx === 0) {
        nextIndex = idx + 1;
        newDirection = 'down';
      } else {
        nextIndex = idx - 1;
      }
    }

    setMode(deck[nextIndex]);
    setDirection(newDirection);
  };

  useImperativeHandle(ref, () => ({
    cycle: () => cycle(false),
    cycleReverse: () => cycle(true),
  }));

  if (isLocked) {
    return (
      <div style={{ width: '42px', height: '42px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', padding: 0 }}>
        {renderCard(safeMode, deck, GRAY_FILTER)}
      </div>
    );
  }

  return (
    <button
      onClick={(e) => cycle(e.shiftKey)}
      style={{ width: '42px', height: '42px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 0, cursor: 'pointer', padding: 0 }}
      title={deck.length === 2 ? `Toggle between ${deck[0]} and ${deck[1]}` : 'Cycle layout (Shift+click to reverse)'}
    >
      {renderCard(safeMode, deck, GOLD_FILTER)}
    </button>
  );
});

export default ModeCycler;
