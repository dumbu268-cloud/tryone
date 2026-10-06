import { useAppStore } from '@/state/store';

/** Bottom-centered framing coach shown over the canvas while running. */
export function HintOverlay() {
  const status = useAppStore((s) => s.status);
  const hint = useAppStore((s) => s.hint);
  if (status !== 'running' || !hint) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
      <div className="rounded-full bg-black/60 px-4 py-1.5 text-xs font-medium text-white/90 backdrop-blur-sm">
        {hint}
      </div>
    </div>
  );
}
