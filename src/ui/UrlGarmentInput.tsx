import { useRef, useState } from 'react';

export type ResolveStage = 'resolving' | 'downloading' | 'preparing';

export interface UrlResolveOutcome {
  ok: boolean;
  previewUrl?: string;
  detectedType?: string;
  sleeveLength?: string;
  reason?: string;
}

interface Props {
  onSubmit: (url: string, onStage: (s: ResolveStage) => void) => Promise<UrlResolveOutcome>;
  onUpload: (file: File) => void;
}

const STAGE_LABEL: Record<ResolveStage, string> = {
  resolving: 'Resolving product page…',
  downloading: 'Downloading image…',
  preparing: 'Preparing garment…',
};

export function UrlGarmentInput({ onSubmit, onUpload }: Props) {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<'idle' | 'working' | 'ok' | 'error'>('idle');
  const [stage, setStage] = useState<ResolveStage>('resolving');
  const [outcome, setOutcome] = useState<UrlResolveOutcome | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function run() {
    if (!url.trim() || status === 'working') return;
    setStatus('working');
    setOutcome(null);
    const result = await onSubmit(url.trim(), setStage);
    setOutcome(result);
    setStatus(result.ok ? 'ok' : 'error');
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-white/40">From URL</span>
        <input
          data-testid="url-input"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
          placeholder="Paste a product page or image URL"
          className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-3 py-1.5 text-sm text-white placeholder:text-white/30 focus:border-indigo-400/60 focus:outline-none"
        />
        <button
          data-testid="url-fetch"
          onClick={run}
          disabled={status === 'working' || !url.trim()}
          className="rounded-md bg-indigo-500 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === 'working' ? 'Fetching…' : 'Fetch'}
        </button>
      </div>

      {status === 'working' && (
        <div className="flex items-center gap-2 text-xs text-white/60">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/20 border-t-indigo-400" />
          {STAGE_LABEL[stage]}
        </div>
      )}

      {status === 'ok' && outcome?.ok && (
        <div data-testid="url-success" className="flex items-center gap-3">
          {outcome.previewUrl && (
            <img
              src={outcome.previewUrl}
              alt="resolved garment"
              className="h-14 w-14 rounded-md border border-white/10 bg-black/30 object-contain"
            />
          )}
          <p className="text-xs text-emerald-300/90">
            Fitted · detected <span className="font-medium">{outcome.detectedType}</span>, sleeves{' '}
            <span className="font-medium">{outcome.sleeveLength}</span>
            {outcome.reason ? ` · ${outcome.reason}` : ''}
          </p>
        </div>
      )}

      {status === 'error' && (
        <div data-testid="url-error" className="flex flex-wrap items-center gap-3">
          <p className="text-xs text-rose-300/90">{outcome?.reason ?? 'Could not load that URL.'}</p>
          <button onClick={run} className="rounded-md bg-white/10 px-3 py-1 text-xs font-medium text-white hover:bg-white/20">
            Retry
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            className="rounded-md bg-white/10 px-3 py-1 text-xs font-medium text-white hover:bg-white/20"
          >
            Upload image instead
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUpload(f);
              e.target.value = '';
            }}
          />
        </div>
      )}
    </div>
  );
}
