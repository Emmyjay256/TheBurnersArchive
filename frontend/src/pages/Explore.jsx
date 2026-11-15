import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Search, X, Maximize, Minimize, Globe, LayoutGrid } from 'lucide-react';
import Mascot from '../components/Mascot';

export default function CountryFootprints() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [countries, setCountries] = useState([]);
  const [selected, setSelected] = useState(null);
  const [isZoomed, setIsZoomed] = useState(false);

  useEffect(() => {
    fetch('/country_maps/country_ranking.csv')
      .then((r) => r.text())
      .then((text) => {
        if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
          console.error('Fetched HTML instead of CSV.');
          return;
        }

        const lines = text.trim().split('\n').slice(1);
        const parsed = [];

        for (const line of lines) {
          if (!line.trim()) continue;
          let inBracket = false;
          let current = '';
          let cols = [];
          for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '[') inBracket = true;
            if (char === ']') inBracket = false;
            if (char === ',' && !inBracket) {
              cols.push(current.trim());
              current = '';
            } else {
              current += char;
            }
          }
          cols.push(current.trim());

          const iso = cols[0] ? cols[0].replace(/^"|"$/g, '').trim() : '';
          const name = cols[1] ? cols[1].replace(/^"|"$/g, '').trim() : '';
          const detections = cols[3] ? +cols[3] : 0;
          const in_image = cols[8] ? +cols[8] : detections;

          if (iso && name) {
            parsed.push({
              iso,
              name,
              detections,
              places: in_image
            });
          }
        }

        setCountries(parsed);
      })
      .catch((err) => console.error('Could not load ranking CSV', err));
  }, []);

  useEffect(() => {
    if (!selected) setIsZoomed(false);
  }, [selected]);

  const term = query.toLowerCase().trim();
  const filtered = term
    ? countries.filter((c) => c.name.toLowerCase().includes(term))
    : countries;

  return (
    <div className="absolute inset-0 z-10 overflow-y-auto bg-[var(--bg)]">
      <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
        <header className="card rounded-3xl p-5 md:p-7 flex flex-col md:flex-row md:items-center gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <button onClick={() => navigate('/')} className="ghost grid h-10 w-10 place-items-center rounded-full shrink-0">
              <ArrowLeft size={20} />
            </button>
            <div className="min-w-0">
              <h1 className="text-2xl font-bold tracking-tight md:text-3xl">Country Footprints</h1>
              <p className="muted text-sm mt-1">Every place a fire was detected since 2001, mapped by country.</p>
            </div>
          </div>

          {/* View switch — mirror of the one on the Globe screen */}
          <div className="glass inline-flex rounded-full p-1 shrink-0 md:ml-auto" role="tablist" aria-label="View">
            <button
              role="tab"
              aria-selected={false}
              title="Interactive fire map"
              onClick={() => navigate('/')}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold"
            >
              <Globe size={14} /> Globe
            </button>
            <button
              role="tab"
              aria-selected
              title="Browse fire maps by country"
              className="on inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold"
            >
              <LayoutGrid size={14} /> Countries
            </button>
          </div>
        </header>

        <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
          <div className="glass flex items-center gap-2 rounded-full px-4 py-2 w-full md:max-w-md">
            <Search size={18} className="muted shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search for a country..."
              className="bg-transparent text-sm outline-none w-full"
            />
          </div>
          <p className="muted text-sm">Showing {filtered.length} countries</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {filtered.map((c, index) => (
            <div
              key={c.iso + '-' + index}
              onClick={() => setSelected(c)}
              className="card p-2 rounded-2xl flex flex-col cursor-pointer transition-transform hover:scale-[1.02]"
            >
              <img
                src={`/country_maps/maps/${c.iso}.webp`}
                alt={`Fire map of ${c.name}`}
                className="rounded-xl w-full bg-[var(--card2)] aspect-square object-cover"
                loading="lazy"
                onError={(e) => { e.target.style.display = 'none'; }}
              />
              <div className="p-2 flex-1 flex flex-col justify-between">
                <h3 className="font-semibold text-sm truncate" title={c.name}>{c.name}</h3>
                <div className="mt-2 flex items-center justify-between text-xs muted">
                  <span>{c.detections ? `${c.detections.toLocaleString()} cell-days` : ''}</span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {filtered.length === 0 && (
          <div className="card flex flex-col items-center justify-center p-10 text-center">
            <Mascot size={100} mood="think" className="mb-4" />
            <h2 className="text-lg font-semibold">No countries found</h2>
            <p className="muted text-sm mt-2">Try a different search term.</p>
          </div>
        )}
      </div>

      {/* Full view Modal */}
      {selected && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm cursor-zoom-out"
          onClick={() => setSelected(null)}
        >
          <div
            className="relative flex flex-col items-center justify-center w-full max-h-[95vh] cursor-default"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={`flex justify-center w-full overflow-auto rounded-2xl shadow-2xl bg-white ${isZoomed ? 'max-h-[70vh]' : 'max-h-[60vh]'}`}>
              <img
                src={`/country_maps/maps/${selected.iso}.webp`}
                alt={`Fire map of ${selected.name}`}
                onClick={() => setIsZoomed(!isZoomed)}
                className={`transition-all duration-200 ${isZoomed ? 'max-w-none w-auto h-auto cursor-zoom-out scale-150 origin-center' : 'max-w-full max-h-[60vh] object-contain cursor-zoom-in'}`}
              />
            </div>

            <div className="mt-4 flex flex-col items-center gap-3 w-full px-4 text-center">
              <div>
                <h2 className="text-2xl font-bold text-white">{selected.name}</h2>
                <p className="text-gray-300 text-sm mt-1">
                  {selected.detections ? `${selected.detections.toLocaleString()} fire cell-days` : ''}
                </p>
              </div>

              <div className="flex gap-3 mt-2">
                <button
                  onClick={() => setIsZoomed(!isZoomed)}
                  className="flex items-center gap-2 rounded-full bg-white/10 hover:bg-white/20 px-5 py-2 text-sm text-white transition-colors"
                >
                  {isZoomed ? <Minimize size={16} /> : <Maximize size={16} />}
                  {isZoomed ? 'Fit to screen' : 'Zoom in'}
                </button>
                <button
                  onClick={() => setSelected(null)}
                  className="flex items-center gap-2 rounded-full bg-white/10 hover:bg-white/20 px-5 py-2 text-sm text-white transition-colors"
                >
                  <X size={16} />
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}