import { useRef } from 'react';
import { useAppStore } from '@/state/store';
import { CATALOG, SAMPLE_IMAGES, type SampleImage } from '@/core/garment/catalog';
import type { GarmentDescriptor } from '@/core/types';

interface GarmentPickerProps {
  onBuiltin: (g: GarmentDescriptor) => void;
  onSample: (s: SampleImage) => void;
  onUpload: (file: File) => void;
}

export function GarmentPicker({ onBuiltin, onSample, onUpload }: GarmentPickerProps) {
  const garmentId = useAppStore((s) => s.garmentId);
  const prepInfo = useAppStore((s) => s.prepInfo);
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-white/40">Built-in</span>
        {CATALOG.map((g) => (
          <Chip key={g.id} active={g.id === garmentId} onClick={() => onBuiltin(g)}>
            <Dot rgb={g.colorHints?.dominant} />
            {g.name}
          </Chip>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-white/40">Auto-prepared</span>
        {SAMPLE_IMAGES.map((s) => (
          <Chip key={s.id} active={s.id === garmentId} onClick={() => onSample(s)}>
            ✨ {s.name}
          </Chip>
        ))}
        <Chip active={garmentId === 'uploaded'} onClick={() => fileRef.current?.click()}>
          ⬆ Upload image
        </Chip>
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

      {prepInfo && (
        <p className={`text-xs ${prepInfo.supported ? 'text-emerald-300/80' : 'text-amber-300/90'}`}>
          {prepInfo.supported ? 'Prepared' : 'Fallback'}: {prepInfo.name} — detected{' '}
          <span className="font-medium">{prepInfo.detectedType}</span>, sleeves{' '}
          <span className="font-medium">{prepInfo.sleeveLength}</span>
          {prepInfo.reason ? ` · ${prepInfo.reason}` : ''}
        </p>
      )}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition ${
        active ? 'bg-white/15 text-white ring-1 ring-white/30' : 'bg-white/5 text-white/60 hover:bg-white/10'
      }`}
    >
      {children}
    </button>
  );
}

function Dot({ rgb }: { rgb?: [number, number, number] }) {
  const [r, g, b] = rgb ?? [120, 120, 120];
  return (
    <span
      className="h-3.5 w-3.5 rounded-full ring-1 ring-black/20"
      style={{ backgroundColor: `rgb(${r},${g},${b})` }}
    />
  );
}
