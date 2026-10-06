import { useAppStore } from '@/state/store';

/** Centered overlay shown over the canvas when idle, initializing, or errored. */
export function StatusOverlay({ onStart }: { onStart: () => void }) {
  const status = useAppStore((s) => s.status);
  const detail = useAppStore((s) => s.statusDetail);
  const error = useAppStore((s) => s.error);

  if (status === 'running') return null;

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/50 px-6 text-center backdrop-blur-sm">
      {status === 'initializing' && (
        <>
          <Spinner />
          <p className="text-sm text-white/80">{detail ?? 'Starting…'}</p>
        </>
      )}

      {status === 'error' && error && (
        <>
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-rose-500/20 text-xl">
            ⚠️
          </div>
          <div className="max-w-sm">
            <p className="font-semibold text-rose-200">Camera problem</p>
            <p className="mt-1 text-sm text-white/70">{error.message}</p>
          </div>
          <button
            onClick={onStart}
            className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400"
          >
            Try again
          </button>
        </>
      )}

      {(status === 'idle' || status === 'stopped') && (
        <>
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-500/20 text-2xl">
            👕
          </div>
          <div className="max-w-sm">
            <p className="text-base font-semibold text-white">Live Mirror</p>
            <p className="mt-1 text-sm text-white/60">
              Turn on your camera to see the garment on you in real time. Video stays on
              your device.
            </p>
          </div>
          <button
            data-testid="start-camera"
            onClick={onStart}
            className="rounded-lg bg-indigo-500 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-400"
          >
            Start camera
          </button>
        </>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-indigo-400" />
  );
}
