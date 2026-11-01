export interface PerformanceMetricSnapshot {
  avgQueueEvaluationMs: number;
  maxQueueEvaluationMs: number;
  totalEvaluations: number;
  avgScoringMs: number;
  totalScoredTracks: number;
  jsHeapUsedMB?: number;
  activeListenersCount: number;
}

export const PerformanceMetricSnapshot = {};

export class PerformanceMonitor {
  private queueEvalTimes: number[] = [];
  private scoringTimes: number[] = [];
  private registeredListeners = new Set<() => void>();

  measure<T>(category: 'queue' | 'scoring', fn: () => T): T {
    const start = performance.now();
    try {
      return fn();
    } finally {
      const elapsed = performance.now() - start;
      if (category === 'queue') {
        this.queueEvalTimes.push(elapsed);
        if (this.queueEvalTimes.length > 200) this.queueEvalTimes.shift();
      } else {
        this.scoringTimes.push(elapsed);
        if (this.scoringTimes.length > 200) this.scoringTimes.shift();
      }
    }
  }

  async measureAsync<T>(category: 'queue' | 'scoring', fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      const elapsed = performance.now() - start;
      if (category === 'queue') {
        this.queueEvalTimes.push(elapsed);
        if (this.queueEvalTimes.length > 200) this.queueEvalTimes.shift();
      } else {
        this.scoringTimes.push(elapsed);
        if (this.scoringTimes.length > 200) this.scoringTimes.shift();
      }
    }
  }

  trackCleanup(cleanupFn: () => void): () => void {
    this.registeredListeners.add(cleanupFn);
    return () => {
      this.registeredListeners.delete(cleanupFn);
      cleanupFn();
    };
  }

  cleanupAll(): void {
    for (const cleanup of this.registeredListeners) {
      try {
        cleanup();
      } catch (err) {
        console.error('[NeuralTune] Cleanup error', err);
      }
    }
    this.registeredListeners.clear();
  }

  getSnapshot(): PerformanceMetricSnapshot {
    const avgQueue = this.queueEvalTimes.length > 0
      ? this.queueEvalTimes.reduce((a, b) => a + b, 0) / this.queueEvalTimes.length
      : 0;

    const maxQueue = this.queueEvalTimes.length > 0
      ? Math.max(...this.queueEvalTimes)
      : 0;

    const avgScoring = this.scoringTimes.length > 0
      ? this.scoringTimes.reduce((a, b) => a + b, 0) / this.scoringTimes.length
      : 0;

    let jsHeapUsedMB: number | undefined;
    const perfWithMemory = performance as unknown as { memory?: { usedJSHeapSize: number } };
    if (perfWithMemory && perfWithMemory.memory) {
      jsHeapUsedMB = Math.round((perfWithMemory.memory.usedJSHeapSize / (1024 * 1024)) * 10) / 10;
    }

    return {
      avgQueueEvaluationMs: Math.round(avgQueue * 100) / 100,
      maxQueueEvaluationMs: Math.round(maxQueue * 100) / 100,
      totalEvaluations: this.queueEvalTimes.length,
      avgScoringMs: Math.round(avgScoring * 100) / 100,
      totalScoredTracks: this.scoringTimes.length,
      jsHeapUsedMB,
      activeListenersCount: this.registeredListeners.size
    };
  }
}
