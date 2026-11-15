import { useState } from 'react';
import { Search } from 'lucide-react';
import { useMap } from '../MapContext';
import { useSettings } from '../SettingsContext';
import { radiusChoices } from '../lib/format';

// The two-way switch (your place or country / the whole world), the search box and the "what exactly am I looking at" line,
// shared by Insights and the Calendar.
export default function ScopeBar({ sc }) {
  const { radiusKm, setRadiusKm, polygon, draw } = useMap();
  const { s } = useSettings();
  const [q, setQ] = useState('');
  const submit = async (e) => { e.preventDefault(); if (await sc.search(q)) setQ(''); };
  const options = [
    ['local', sc.localLabel, sc.isLocal, !sc.hasArea && !sc.place],
    ['world', 'World', !sc.isLocal, false],
  ];

  return (
    <div className="mt-5 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="card2 flex gap-1 rounded-full p-1" role="tablist" aria-label="Scope">
          {options.map(([k, text, on, disabled]) => (
            <button key={k} role="tab" aria-selected={on} disabled={disabled} onClick={() => sc.setScope(k)}
              className={`max-w-[14rem] truncate rounded-full px-4 py-1.5 text-sm disabled:opacity-40 ${on ? 'on font-semibold' : 'muted'}`}>{text}</button>
          ))}
        </div>
        <form onSubmit={submit} className="flex min-w-[200px] flex-1 items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--card)] px-3 py-1.5">
          <Search size={16} className="text-[var(--muted)]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search any city or country…" aria-label="Search for a place" className="flex-1 bg-transparent text-sm outline-none" />
          <button type="submit" disabled={sc.searching} className="text-xs font-semibold text-[var(--accent)] disabled:opacity-50">{sc.searching ? '…' : 'Go'}</button>
        </form>
        {sc.scope === 'area' && (polygon ? (
          <button onClick={draw.clear} className="ghost rounded-full px-3 py-1 text-xs">Use place + radius</button>
        ) : (
          <div className="card2 flex gap-1 rounded-full p-1" role="group" aria-label="Radius">
            {radiusChoices(s.units).map((c) => (
              <button key={c.km} onClick={() => setRadiusKm(c.km)} aria-pressed={Math.abs(radiusKm - c.km) < 1}
                className={`rounded-full px-3 py-1 text-sm ${Math.abs(radiusKm - c.km) < 1 ? 'on font-semibold' : 'muted'}`}>{c.label}</button>
            ))}
          </div>
        ))}
      </div>
      {sc.searchMsg && <p className="text-sm" role="status">{sc.searchMsg}</p>}
      <p className="muted text-sm">Showing <b>{sc.label}</b>: {sc.detail}.</p>
    </div>
  );
}
