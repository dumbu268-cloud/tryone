import { create } from 'zustand';
import type { MirrorStatus } from '@/core/pipeline/LiveMirror';
import type { MetricsSnapshot } from '@/core/perf/Metrics';
import { DEFAULT_RENDER_SETTINGS, type RenderSettings } from '@/core/render/Renderer';
import { DEFAULT_GARMENT } from '@/core/garment/catalog';

export interface AppError {
  message: string;
  kind?: string;
}

interface AppState {
  status: MirrorStatus;
  statusDetail: string | null;
  error: AppError | null;
  metrics: MetricsSnapshot | null;
  settings: RenderSettings;
  garmentId: string;
  prepInfo: PrepInfo | null;
  hint: string | null;

  setStatus: (status: MirrorStatus, detail?: string) => void;
  setError: (error: AppError | null) => void;
  setMetrics: (metrics: MetricsSnapshot) => void;
  setSettings: (partial: Partial<RenderSettings>) => void;
  setGarmentId: (id: string) => void;
  setPrepInfo: (info: PrepInfo | null) => void;
  setHint: (hint: string | null) => void;
}

export interface PrepInfo {
  name: string;
  detectedType: string;
  sleeveLength: string;
  supported: boolean;
  reason?: string;
}

export const useAppStore = create<AppState>((set) => ({
  status: 'idle',
  statusDetail: null,
  error: null,
  metrics: null,
  settings: { ...DEFAULT_RENDER_SETTINGS },
  garmentId: DEFAULT_GARMENT.id,
  prepInfo: null,
  hint: null,

  setStatus: (status, detail) =>
    set({ status, statusDetail: detail ?? null, ...(status !== 'error' ? { error: null } : {}) }),
  setError: (error) => set({ error }),
  setMetrics: (metrics) => set({ metrics }),
  setSettings: (partial) => set((s) => ({ settings: { ...s.settings, ...partial } })),
  setGarmentId: (id) => set({ garmentId: id }),
  setPrepInfo: (info) => set({ prepInfo: info }),
  setHint: (hint) => set({ hint }),
}));
