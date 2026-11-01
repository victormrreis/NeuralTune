export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label}: sem resposta em ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

/** The client's APIs can stay pending forever: a stalled call must not hold a radio with it. */
export function withTimeout<T>(work: Promise<T>, ms: number, label: string = 'Operação'): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/** Last click wins: a run that was overtaken must not touch the player or the shown selection. */
export class LatestRunGate {
  private latest = 0;

  begin(): number {
    return ++this.latest;
  }

  isCurrent(run: number): boolean {
    return run === this.latest;
  }
}
