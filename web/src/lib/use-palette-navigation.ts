import { useCallback, useRef, useState, type KeyboardEvent } from 'react';

// Shared palette keyboard model: a clamped active index across a flat item
// list, reset whenever fresh results land. Enter activates through the
// caller, which owns what activation means (click a link, navigate).
export function usePaletteNavigation(onActivate: (index: number) => void) {
  const [active, setActive] = useState(0);
  const activeRef = useRef(active);
  activeRef.current = active;

  const reset = useCallback(() => setActive(0), []);

  const onKeyDown = (event: KeyboardEvent, itemCount: number) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((a) => Math.min(a + 1, Math.max(itemCount - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (itemCount > 0) onActivate(activeRef.current);
    }
  };

  return { active, setActive, reset, onKeyDown };
}
