import { useEffect, useRef } from 'react';
import { LiveMirror } from '@/core/pipeline/LiveMirror';
import type { RenderSettings } from '@/core/render/Renderer';
import { useAppStore } from '@/state/store';
import { Controls } from './Controls';
import { StatsOverlay } from './StatsOverlay';
import { StatusOverlay } from './StatusOverlay';
import { HintOverlay } from './HintOverlay';
import { GarmentPicker } from './GarmentPicker';
import { UrlGarmentInput, type ResolveStage, type UrlResolveOutcome } from './UrlGarmentInput';
import { DEFAULT_GARMENT, type SampleImage } from '@/core/garment/catalog';
import { ClassicGarmentPreparer } from '@/core/garment/prep/prepare';
import { HttpProductResolver } from '@/core/product/HttpProductResolver';
import { proxiedImageUrl } from '@/core/product/ProductResolver';
import type { GarmentDescriptor, GarmentPrepResult } from '@/core/types';

export function TryOnScreen() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mirrorRef = useRef<LiveMirror | null>(null);
  const preparerRef = useRef<ClassicGarmentPreparer | null>(null);
  const resolverRef = useRef<HttpProductResolver | null>(null);

  const setStatus = useAppStore((s) => s.setStatus);
  const setError = useAppStore((s) => s.setError);
  const setMetrics = useAppStore((s) => s.setMetrics);
  const setSettings = useAppStore((s) => s.setSettings);
  const setGarmentId = useAppStore((s) => s.setGarmentId);
  const setPrepInfo = useAppStore((s) => s.setPrepInfo);
  const setHint = useAppStore((s) => s.setHint);

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
        onHint: (hint) => setHint(hint),
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

  const handleBuiltin = (g: GarmentDescriptor) => {
    setGarmentId(g.id);
    setPrepInfo(null);
    void ensureMirror()?.setGarment(g);
  };

  function preparer(): ClassicGarmentPreparer {
    if (!preparerRef.current) preparerRef.current = new ClassicGarmentPreparer();
    return preparerRef.current;
  }

  async function wearPrepared(result: GarmentPrepResult, sourceName: string, id: string) {
    const d = result.diagnostics;
    setGarmentId(id);
    setPrepInfo({
      name: sourceName,
      detectedType: d.detectedType,
      sleeveLength: d.sleeveLength,
      supported: d.supported,
      ...(d.reason ? { reason: d.reason } : {}),
    });
    ensureMirror()?.setGarmentAsset(result.asset);
  }

  const handleSample = (s: SampleImage) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      void preparer()
        .prepare(img)
        .then((res) => wearPrepared(res, s.name, s.id))
        .catch((err) => setError({ message: `Garment prep failed: ${String(err)}` }));
    };
    img.onerror = () => setError({ message: `Could not load ${s.url}` });
    img.src = s.url;
  };

  const handleUpload = (file: File) => {
    void createImageBitmap(file)
      .then((bmp) => preparer().prepare(bmp))
      .then((res) => wearPrepared(res, file.name, 'uploaded'))
      .catch((err) => setError({ message: `Garment prep failed: ${String(err)}` }));
  };

  function resolver(): HttpProductResolver {
    if (!resolverRef.current) resolverRef.current = new HttpProductResolver();
    return resolverRef.current;
  }

  async function handleResolveUrl(
    url: string,
    onStage: (s: ResolveStage) => void,
  ): Promise<UrlResolveOutcome> {
    onStage('resolving');
    const resolution = await resolver().resolve(url);
    if (!resolution.ok || resolution.candidates.length === 0) {
      return { ok: false, reason: resolution.reason ?? 'No usable image found.' };
    }

    // Try the top candidates until one prepares as a supported garment.
    onStage('downloading');
    const tryN = Math.min(3, resolution.candidates.length);
    let best: GarmentPrepResult | null = null;
    let bestPreview = '';
    for (let i = 0; i < tryN; i++) {
      const candidate = resolution.candidates[i]!;
      const proxied = proxiedImageUrl(candidate.url);
      let img: HTMLImageElement;
      try {
        img = await loadImageEl(proxied);
      } catch {
        continue;
      }
      onStage('preparing');
      let prep: GarmentPrepResult;
      try {
        prep = await preparer().prepare(img);
      } catch {
        continue;
      }
      best = prep;
      bestPreview = proxied;
      if (prep.diagnostics.supported) break;
    }

    if (!best) {
      return { ok: false, reason: 'Could not load a usable image from that URL.' };
    }

    wearPrepared(best, resolution.title ?? url, 'url');
    return {
      ok: true,
      previewUrl: bestPreview,
      detectedType: best.diagnostics.detectedType,
      sleeveLength: best.diagnostics.sleeveLength,
      ...(best.diagnostics.reason ? { reason: best.diagnostics.reason } : {}),
    };
  }

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
        <HintOverlay />
        <StatusOverlay onStart={handleStart} />
      </div>

      <UrlGarmentInput onSubmit={handleResolveUrl} onUpload={handleUpload} />

      <GarmentPicker onBuiltin={handleBuiltin} onSample={handleSample} onUpload={handleUpload} />

      <Controls onStart={handleStart} onStop={handleStop} onToggle={handleToggle} />

      <p className="text-xs leading-relaxed text-white/40">
        Stand back so your head, shoulders, and arms are visible — each sleeve follows
        your arm. Paste a product/image URL, pick a built-in or auto-prepared sample, or{' '}
        <span className="text-white/60">upload a flat-lay clothing image</span> on a plain
        background and the pipeline will cut it out and fit it to you.
      </p>
    </div>
  );
}

function loadImageEl(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });
}
