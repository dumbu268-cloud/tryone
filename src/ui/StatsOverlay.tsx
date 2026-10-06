import { useAppStore } from '@/state/store';

export function StatsOverlay() {
  const metrics = useAppStore((s) => s.metrics);
  const status = useAppStore((s) => s.status);
  if (status !== 'running' || !metrics) return null;

  const fpsColor =
    metrics.fps >= 25 ? 'text-emerald-400' : metrics.fps >= 15 ? 'text-amber-400' : 'text-rose-400';

  return (
    <div className="pointer-events-none absolute left-3 top-3 rounded-lg bg-black/55 px-3 py-2 font-mono text-[11px] leading-tight text-white/90 backdrop-blur-sm">
      <div className="flex items-baseline gap-2">
        <span className={`text-sm font-semibold ${fpsColor}`}>{metrics.fps.toFixed(0)}</span>
        <span className="text-white/60">fps</span>
      </div>
      <Row label="frame" value={`${metrics.frameMs.toFixed(1)} ms`} />
      <Row label="infer" value={`${metrics.inferenceMs.toFixed(1)} ms`} />
      <Row label="render" value={`${metrics.renderMs.toFixed(1)} ms`} />
      {metrics.memoryMB !== null && <Row label="heap" value={`${metrics.memoryMB} MB`} />}
      <Row label="gpu" value={metrics.delegate} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-white/50">{label}</span>
      <span>{value}</span>
    </div>
  );
}
