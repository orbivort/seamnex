import { useEffect, useState } from 'react';

/**
 * Delays a rapidly changing value (a search box) so it can be used as a query key
 * without issuing one request per keystroke.
 */
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
