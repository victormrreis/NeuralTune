export class EventThrottler {
  /**
   * Debounces a function call so it only executes after delayMs of inactivity.
   */
  static debounce<T extends (...args: unknown[]) => void>(fn: T, delayMs: number): (...args: Parameters<T>) => void {
    let timer: NodeJS.Timeout | null = null;
    return (...args: Parameters<T>) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        fn(...args);
      }, delayMs);
    };
  }

  /**
   * Throttles a function call so it executes at most once every intervalMs.
   */
  static throttle<T extends (...args: unknown[]) => void>(fn: T, intervalMs: number): (...args: Parameters<T>) => void {
    let lastExec = 0;
    let timer: NodeJS.Timeout | null = null;

    return (...args: Parameters<T>) => {
      const now = Date.now();
      const remaining = intervalMs - (now - lastExec);

      if (remaining <= 0) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        lastExec = now;
        fn(...args);
      } else if (!timer) {
        timer = setTimeout(() => {
          lastExec = Date.now();
          timer = null;
          fn(...args);
        }, remaining);
      }
    };
  }
}
