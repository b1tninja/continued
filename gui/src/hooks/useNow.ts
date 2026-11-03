import { useEffect, useState } from "react";

/**
 * The current time, refreshed every `intervalMs`, so a component that shows
 * whether a cache is still warm keeps saying the right thing while idle.
 */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
