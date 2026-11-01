export interface ModuleFlags {
  predictive: boolean;
  rhythm: boolean;
  plasticity: boolean;
  morphology: boolean;
  circadian: boolean;
  calibrated: boolean;
}
export const ModuleFlags = {};

/** Set from docs/research/ABLATION_STUDY.md. A module that showed no benefit starts off. */
export const DEFAULT_FLAGS: ModuleFlags = {
  predictive: false,
  rhythm: true,
  plasticity: true,
  morphology: true,
  circadian: false,
  calibrated: false
};

export const ALL_MODULES_ON: ModuleFlags = {
  predictive: true, rhythm: true, plasticity: true, morphology: true, circadian: true, calibrated: true
};

export const ALL_MODULES_OFF: ModuleFlags = {
  predictive: false, rhythm: false, plasticity: false, morphology: false, circadian: false, calibrated: false
};

const STORAGE_KEY = 'neuraltune:flags';

export interface FlagStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}
export const FlagStore = {};

export function loadFlags(store: FlagStore): ModuleFlags {
  try {
    return { ...DEFAULT_FLAGS, ...JSON.parse(store.get(STORAGE_KEY) ?? '{}') };
  } catch {
    return { ...DEFAULT_FLAGS };
  }
}

export function saveFlags(store: FlagStore, flags: ModuleFlags): void {
  store.set(STORAGE_KEY, JSON.stringify(flags));
}
