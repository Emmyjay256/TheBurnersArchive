import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { IconExplore, IconCalendar, IconInsights, IconSettings } from './components/NavIcons';
import Tour from './components/Tour';
import AlertBanner from './components/AlertBanner';
import { useFireWatch } from './hooks/useFireWatch';
import { useFormat } from './lib/format';
import './theme.css';
import { SettingsProvider, useSettings } from './SettingsContext';
import Settings from './pages/Settings';
import { MapProvider, useMap } from './MapContext';
import Globe from './components/Globe';
import Explore from './pages/Explore';
import BurningCalendar from './pages/BurningCalendar';
import Insights from './pages/Insights';
import { useServerWake } from './hooks/useServerWake';
import { log } from './debug';
import Mascot from './components/Mascot';
import Insights from './pages/Insights';
import AdvancedInsights from './pages/AdvancedInsights';

const TABS = [
  { to: '/', label: 'Explore', Icon: IconExplore, tour: 'nav-explore' },
  { to: '/calendar', label: 'Calendar', Icon: IconCalendar, tour: 'nav-calendar' },
  { to: '/insights', label: 'Insights', Icon: IconInsights, tour: 'nav-insights' },
  { to: '/settings', label: 'Settings', Icon: IconSettings, tour: 'nav-settings' },
];

const LOADING_DURATION = 2000;

function LoadingScreen() {
  return (
    <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center" style={{ background: 'var(--bg)', color: 'var(--fg)' }}>
      <div className="grid grid-cols-[96px_1fr_120px] items-center gap-2">
        <div className="flex justify-center">
          <Mascot size={96} mood="sit" />
        </div>

        <h1
          className="whitespace-nowrap text-center text-3xl font-extrabold tracking-tight"
          style={{
            color: 'var(--fg)',
            textShadow: '0 0 10px var(--fg-soft, rgba(0,0,0,0.12)), 0 0 20px rgba(255, 165, 0, 0.5)',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          The Burner's Archive
        </h1>

        <div className="flex justify-start pl-4">
          <Mascot size={96} mood="lounge" />
        </div>
      </div>
    </div>
  );
}

function Shell() {
  const { pathname } = useLocation();
  const awake = useServerWake();
  const { setSelected, place, showOnMap } = useMap();
  const fmt = useFormat();
  const watch = useFireWatch();
  const { tour, closeTour } = useSettings();
  const navigate = useNavigate();
  const [tailwindOk, setTailwindOk] = useState(true);
  const [loading, setLoading] = useState(true);

  // Trigger loading screen ONLY on first mount (app start)
  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), LOADING_DURATION);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => { log('route', 'now on', pathname); if (pathname !== '/') setSelected(null); }, [pathname, setSelected]);
  useEffect(() => { if (tour && pathname !== '/') navigate('/'); }, [tour]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { log('server', awake ? 'data server is awake' : 'waiting for data server…'); }, [awake]);
  useEffect(() => {
    const probe = document.createElement('div');
    probe.className = 'hidden';
    document.body.appendChild(probe);
    const ok = getComputedStyle(probe).display === 'none';
    probe.remove();
    setTailwindOk(ok);
    log('ui', 'Tailwind active:', ok);
  }, []);

  if (loading) return <LoadingScreen />;

  return (
    // Phone: content on top, tab bar at the bottom. Desktop: rail on the left, content on the right.
    <div className="page fixed inset-0 flex flex-col-reverse md:flex-row">
      <nav className="card flex shrink-0 justify-around border-x-0 border-b-0 py-2 md:w-16 md:flex-col md:items-center md:justify-center md:gap-4 md:border-y-0 md:border-l-0">
        {TABS.map(({ to, label, Icon, tour: t }) => (
          <NavLink key={to} to={to} end={to === '/'} aria-label={label} title={label} data-tour={t}
            className={({ isActive }) => `grid h-11 w-11 place-items-center rounded-xl ${isActive ? '' : 'muted'}`}>
            {({ isActive }) => <Icon active={isActive} />}
          </NavLink>
        ))}
      </nav>

      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {watch.alert && (
          <AlertBanner alert={watch.alert} count={watch.count} placeName={place?.name || 'your area'} dist={fmt.dist}
            onView={() => { showOnMap(navigate, { place, date: null, selected: { ...watch.alert, source: 'map' } }); }} onDismiss={() => watch.dismiss(watch.all)} />
        )}

        <div className="relative min-h-0 flex-1">
          <div className="absolute inset-0" style={{ visibility: pathname === '/' ? 'visible' : 'hidden', pointerEvents: pathname === '/' ? 'auto' : 'none' }}>
            <Globe active={pathname === '/'} serverReady={awake} />
          </div>

          {!awake && pathname === '/' && (
            <div role="status" className="glass absolute left-1/2 top-4 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-sm">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-t-transparent" style={{ borderColor: 'var(--fg)', borderTopColor: 'transparent' }} />
              Waking the data server, fire layers will appear shortly
            </div>
          )}

          <Routes>
            <Route path="/" element={<Explore />} />
            <Route path="/calendar" element={<BurningCalendar />} />
            <Route path="/insights" element={<Insights />} />
            <Route path="/insights/advanced" element={<AdvancedInsights />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </div>
      </main>

      {!tailwindOk && (
        <div className="btn" style={{ position: 'fixed', left: 0, right: 0, top: 0, zIndex: 3000, padding: 8, fontSize: 13 }}>
          Tailwind CSS is not loaded, so styling and layout are broken. See the setup steps in the chat.
        </div>
      )}
      {tour && <Tour onClose={closeTour} />}
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <SettingsProvider><MapProvider><Shell /></MapProvider></SettingsProvider>
    </BrowserRouter>
  );
}
