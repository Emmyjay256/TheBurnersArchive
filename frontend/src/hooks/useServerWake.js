import { useEffect, useState } from 'react';
import { API } from '../config';
import { log } from '../debug';

// Render's free tier sleeps. Ping until it answers, without blocking the whole UI.
export function useServerWake() {
  const [awake, setAwake] = useState(false);
  useEffect(() => {
    let cancelled = false, timer;
    const ping = async () => {
      try {
        const r = await fetch(`${API}/api/health`);
        if (r.ok && !cancelled) {
          setAwake(true);
          fetch(`${API}/api/data/status`).then((x) => (x.ok ? x.json() : Promise.reject(x.status)))
            .then((j) => log('server', 'api', j.apiVersion, '| FIRMS key set:', j.firmsKeySet, '| processed files:', j.files.map((f) => f.file).join(', ') || 'NONE'))
            .catch((c) => log('server', `WARNING: backend has no /api/data/status (HTTP ${c}). It is running OLD code: deploy backend/routes/fireData.js`));
          return;
        }
      } catch { /* server still waking */ }
      if (!cancelled) timer = setTimeout(ping, 3000);
    };
    ping();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);
  return awake;
}