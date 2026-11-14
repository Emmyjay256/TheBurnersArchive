"""Download FIRMS standard-processing archives for each region, resumable (one cached file per 5-day chunk).
Usage:  export FIRMS_MAP_KEY=...                      (Windows PowerShell: $env:FIRMS_MAP_KEY="...")
        python backend/pipeline/download.py north_america
        python backend/pipeline/download.py uganda_test --from 2004 --to 2018        # a fast test run
The number of requests depends on the YEARS you ask for, not on the size of the area."""
import argparse, datetime as dt, io, os, sys, time
import pandas as pd, requests
from config import *

BASE = 'https://firms.modaps.eosdis.nasa.gov/api'
spent = []  # (timestamp, cost) rolling window

def throttle(cost):
    while True:
        now = time.time()
        spent[:] = [(t, c) for t, c in spent if now - t < 600]
        if sum(c for _, c in spent) + cost <= BUDGET: break
        time.sleep(10)
    spent.append((time.time(), cost))

def fetch(url):
    for _ in range(6):
        throttle(CHUNK_DAYS)
        try:
            r = requests.get(url, timeout=180); t = r.text.strip()
        except requests.RequestException as e:
            print('   network problem:', e, '| retrying in 20 s'); time.sleep(20); continue
        if r.status_code == 200 and (t.startswith('latitude') or t == ''): return t
        if 'invalid' in t.lower(): sys.exit(f'FIRMS rejected the request: {t[:120]}')
        print('   unexpected reply:', t[:100].replace('\n', ' '), '| waiting 10 min'); time.sleep(600)
    raise RuntimeError('giving up on ' + url)

def availability():
    try:
        t = requests.get(f'{BASE}/data_availability/csv/{MAP_KEY}/ALL', timeout=60).text
        df = pd.read_csv(io.StringIO(t)); df.columns = [c.lower() for c in df.columns]
        return {r.data_id: (r.min_date, r.max_date) for r in df.itertuples()}
    except Exception as e:
        print('availability lookup failed, using defaults:', e); return {}

def main(regions, y0=None, y1=None):
    if not MAP_KEY: sys.exit('Set FIRMS_MAP_KEY first.')
    av, plan = availability(), []
    for reg in regions:
        for src, default_start in SOURCES.items():
            start, end = av.get(src, (default_start, None))
            start = dt.date.fromisoformat(str(start)[:10])
            end = dt.date.fromisoformat(str(end)[:10]) if end else dt.date.today() - dt.timedelta(days=90)
            if y0: start = max(start, dt.date(y0, 1, 1))
            if y1: end = min(end, dt.date(y1, 12, 31))
            folder = os.path.join(RAW, reg, src); os.makedirs(folder, exist_ok=True)
            d, todo = start, []
            while d <= end:
                path = os.path.join(folder, f'{d}.csv')
                if not os.path.exists(path): todo.append((d, path, REGIONS[reg]['bbox'], src))
                d += dt.timedelta(days=CHUNK_DAYS)
            print(f'{reg} {src}: {start} to {end}, {len(todo)} chunks still to download')
            plan += todo
    per_10min = BUDGET // CHUNK_DAYS
    print(f'\n{len(plan)} requests in total. NASA allows about {per_10min} per 10 minutes here, so at least {len(plan) / per_10min * 10:.0f} minutes. Safe to stop (Ctrl+C) and resume later.\n')
    t0 = time.time()
    for i, (d, path, (w, s, e, north), src) in enumerate(plan, 1):
        text = fetch(f'{BASE}/area/csv/{MAP_KEY}/{src}/{w},{s},{e},{north}/{CHUNK_DAYS}/{d}')
        with open(path + '.part', 'w') as f: f.write(text)
        os.replace(path + '.part', path)
        if i % 25 == 0 or i == len(plan):
            eta = (time.time() - t0) / i * (len(plan) - i) / 60
            print(f'  {i}/{len(plan)} done ({src} up to {d}) | about {eta:.0f} min left')
    print('Download complete.')

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('regions', nargs='*', default=list(REGIONS))
    ap.add_argument('--from', dest='y0', type=int, help='first year to download'); ap.add_argument('--to', dest='y1', type=int, help='last year to download')
    a = ap.parse_args(); main(a.regions, a.y0, a.y1)