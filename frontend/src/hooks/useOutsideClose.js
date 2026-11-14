import { useEffect } from 'react';

// Close a panel when the user presses anywhere outside it. Mark a panel's own toggle button with data-keepopen
// so pressing it toggles the panel instead of closing and instantly reopening it.
export function useOutsideClose(ref, onClose, active = true) {
  useEffect(() => {
    if (!active) return undefined;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target) && !e.target.closest?.('[data-keepopen]')) onClose(); };
    document.addEventListener('pointerdown', h);
    return () => document.removeEventListener('pointerdown', h);
  }, [ref, onClose, active]);
}