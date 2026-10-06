import { useAppStore } from '@/state/store';
import { CATALOG } from '@/core/garment/catalog';
import type { GarmentDescriptor } from '@/core/types';

export function GarmentPicker({ onSelect }: { onSelect: (g: GarmentDescriptor) => void }) {
  const garmentId = useAppStore((s) => s.garmentId);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-white/40">Garment</span>
      {CATALOG.map((g) => {
        const active = g.id === garmentId;
        const [r, gr, b] = g.colorHints?.dominant ?? [120, 120, 120];
        return (
          <button
            key={g.id}
            data-testid={`garment-${g.id}`}
            onClick={() => onSelect(g)}
            className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition ${
              active ? 'bg-white/15 text-white ring-1 ring-white/30' : 'bg-white/5 text-white/60 hover:bg-white/10'
            }`}
          >
            <span
              className="h-3.5 w-3.5 rounded-full ring-1 ring-black/20"
              style={{ backgroundColor: `rgb(${r},${gr},${b})` }}
            />
            {g.name}
          </button>
        );
      })}
    </div>
  );
}
