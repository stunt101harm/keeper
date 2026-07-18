import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { store } from './store';
import type { KeeperStore } from './store';

/** Subscribe to the singleton store; re-renders (rAF-batched) on any change. */
export function useStore(): KeeperStore {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store;
}

/** Wall-clock now, ticking at `ms` — for age displays only, never for data. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** Observe an element's rendered width (responsive SVG charts). */
export function useMeasure<T extends HTMLElement>(): [React.MutableRefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w != null) setWidth(w);
    });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}
