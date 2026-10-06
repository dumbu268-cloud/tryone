import { useAppStore } from '@/state/store';
import type { RenderSettings } from '@/core/render/Renderer';

interface ControlsProps {
  onStart: () => void;
  onStop: () => void;
  onToggle: (key: keyof RenderSettings, value: boolean) => void;
}

export function Controls({ onStart, onStop, onToggle }: ControlsProps) {
  const status = useAppStore((s) => s.status);
  const settings = useAppStore((s) => s.settings);
  const running = status === 'running';
  const busy = status === 'initializing';

  return (
    <div className="flex flex-wrap items-center gap-3">
      {!running ? (
        <button
          onClick={onStart}
          disabled={busy}
          className="rounded-lg bg-indigo-500 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Starting…' : 'Start camera'}
        </button>
      ) : (
        <button
          onClick={onStop}
          className="rounded-lg bg-white/10 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-white/20"
        >
          Stop
        </button>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Toggle
          label="Silhouette"
          checked={settings.occludeSilhouette}
          disabled={!running}
          onChange={(v) => onToggle('occludeSilhouette', v)}
        />
        <Toggle
          label="Hair/neck"
          checked={settings.occludeHairFace}
          disabled={!running}
          onChange={(v) => onToggle('occludeHairFace', v)}
        />
        <Toggle
          label="Arms"
          checked={settings.occludeForearms}
          disabled={!running}
          onChange={(v) => onToggle('occludeForearms', v)}
        />
        <Toggle
          label="Light"
          checked={settings.harmonize}
          disabled={!running}
          onChange={(v) => onToggle('harmonize', v)}
        />
        <Toggle
          label="Debug"
          checked={settings.debug}
          disabled={!running}
          onChange={(v) => onToggle('debug', v)}
        />
      </div>
    </div>
  );
}

function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label
      className={`flex cursor-pointer select-none items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
        checked ? 'bg-indigo-500/20 text-indigo-200' : 'bg-white/5 text-white/60'
      } ${disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-white/10'}`}
    >
      <input
        type="checkbox"
        className="accent-indigo-400"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
