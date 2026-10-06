import { useEffect, useRef } from 'react';
import { LiveMirror } from '@/core/pipeline/LiveMirror';
import type { RenderSettings } from '@/core/render/Renderer';
import { useAppStore } from '@/state/store';
import { Controls } from './Controls';
import { StatsOverlay } from './StatsOverlay';
import { StatusOverlay } from './StatusOverlay';
import { GarmentPicker } from './GarmentPicker';
import { DEFAULT_GARMENT } from '@/core/garment/catalog';
import type { GarmentDescriptor } from '@/core/types';

export function TryOnScreen() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mirrorRef = useRef<LiveMirror | null>(null);

  const setStatus = useAppStore((s) => s.setStatus);
  const setError = useAppStore((s) => s.setError);
  const setMetrics = useAppStore((s) => s.setMetrics);
  const setSettings = useAppStore((s) => s.setSettings);
  const setGarmentId = useAppStore((s) => s.setGarmentId);

  function ensureMirror(): LiveMirror | null {
    if (mirrorRef.current) return mirrorRef.current;
    const canvas = canvasRef.current;
    if (!canvas) return null;
    mirrorRef.current = new LiveMirror(
      canvas,
      { metricsHz: 3 },
      {
        onStatus: (status, detail) => {
          document.documentElement.dataset.mirrorStatus = status;
          setStatus(status, detail);
        },
        onMetrics: (snapshot) => {
          (window as unknown as { __metrics?: unknown }).__metrics = snapshot;
          setMetrics(snapshot);
        },
        onError: (message, kind) => setError({ message, ...(kind ? { kind } : {}) }),
      },
    );
    return mirrorRef.current;
  }

  const handleStart = () => {
    const mirror = ensureMirror();
    void mirror?.start();
  };

  const handleStop = () => {
    mirrorRef.current?.stop();
  };

  const handleToggle = (key: keyof RenderSettings, value: boolean) => {
    setSettings({ [key]: value });
    mirrorRef.current?.setRenderSettings({ [key]: value });
  };

  const handleSelectGarment = (g: GarmentDescriptor) => {
    setGarmentId(g.id);
    void ensureMirror()?.setGarment(g);
  };

  useEffect(() => {
    return () => {
      mirrorRef.current?.dispose();
      mirrorRef.current = null;
    };
  }, []);

  return (
    <div className="mx-auto flex min-h-full max-w-4xl flex-col gap-5 px-4 py-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">TryOne — Live Mirror</h1>
          <p className="text-xs text-white/50">
            Phase 1 · {DEFAULT_GARMENT.name} · real-time geometric try-on
          </p>
        </div>
      </header>

      <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl">
        <canvas ref={canvasRef} className="h-full w-full object-cover" />
        <StatsOverlay />
        <StatusOverlay onStart={handleStart} />
      </div>

      <GarmentPicker onSelect={handleSelectGarment} />

      <Controls onStart={handleStart} onStop={handleStop} onToggle={handleToggle} />

      <p className="text-xs leading-relaxed text-white/40">
        Stand back so your head, hips, and arms are visible. The torso tracks your
        shoulders and hips, and each sleeve follows your arm. Toggles control occlusion
        and light matching; Debug draws the tracked landmarks.
      </p>
    </div>
  );
}
