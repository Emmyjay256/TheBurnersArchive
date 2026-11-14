"""Harmonize MODIS (Aqua) and VIIRS fire detections into ONE record on VIIRS's scale (VIIRS is treated as the truth).

Unit: fire cell-days = distinct (0.02 degree cell, day) pairs with a quality detection.

Disk-backed pipeline: CSVs are streamed into a temp binary file (13 bytes per row), then
memory-mapped and processed in 40,000-place chunks. Peak RAM ~1.5 GB, independent of input size.

Usage:
    python backend/pipeline/harmonize.py world
"""
import glob, json, os, sys, tempfile
import numpy as np, pandas as pd
from config import *

EPOCH, S = pd.Timestamp('2000-01-01'), 32768
RULES = {
    'consec2': lambda b: (b[:, 1:] & b[:, :-1]).any(axis=1) if b.shape[1] > 1 else np.zeros(len(b), bool),
    'any2': lambda b: b.sum(axis=1) >= 2,
    'any3': lambda b: b.sum(axis=1) >= 3,
    'any4': lambda b: b.sum(axis=1) >= 4,
    'early2': lambda b: (b.sum(axis=1) >= 2) & b[:, :5].any(axis=1),
    'none': lambda b: np.zeros(len(b), bool),
}
RULE_TEXT = {'consec2': 'VIIRS burning 2 years in a row', 'any2': 'VIIRS burning in 2 different years',
             'any3': 'in 3 different years', 'any4': 'in 4 different years',
             'early2': '2 different years, one of them among the earliest', 'none': 'no gap filling'}

RAW_OVERRIDE = {
    'world': {
        'MODIS_SP':       r'C:\Users\Emma\Documents\ras\data\Processed data\MODIS',
        'VIIRS_SNPP_SP':  r'C:\Users\Emma\Documents\ras\data\Processed data\VIIRS S-NPP',
        'VIIRS_JPSS1_SP': r'C:\Users\Emma\Documents\ras\data\Processed data\VIIRS NOAA-20',
    }
}

def _raw_root(region, sensor):
    return RAW_OVERRIDE.get(region, {}).get(sensor) or os.path.join(RAW, region, sensor)


# ---------------------------------------------------------------------------
# Pass 1: stream CSVs -> 13-byte-per-row temp binary (ci, cj, days_since_epoch, sat_idx)
# ---------------------------------------------------------------------------
REC_DTYPE = np.dtype([('ci', '<i4'), ('cj', '<i4'), ('d', '<i4'), ('s', 'u1')])
SAT_A, SAT_T, SAT_N = 0, 1, 2

def _stream_to_disk(region, sensor):
    modis = sensor.startswith('MODIS')
    cols = {'latitude', 'longitude', 'acq_date', 'confidence', 'type', 'satellite'}
    root = _raw_root(region, sensor)
    print(f'[{region}] streaming {sensor} from {root}')

    fd, path = tempfile.mkstemp(prefix='hrm_', suffix='.bin', dir=os.path.dirname(RAW) or '.')
    total = 0
    first_date = last_date = None

    with os.fdopen(fd, 'wb') as fout:
        for f in sorted(glob.glob(os.path.join(root, '**', '*.csv'), recursive=True)):
            if os.path.getsize(f) == 0: continue
            for ch in pd.read_csv(f, chunksize=500_000, usecols=lambda c: c in cols,
                                  dtype={'confidence': str, 'satellite': str}):
                conf = ch['confidence'].astype(str).str.lower()
                ok = (pd.to_numeric(conf, errors='coerce') >= MODIS_CONF_MIN) if modis \
                     else conf.str[:1].isin(['n', 'h'])
                if 'type' in ch:
                    ok &= (pd.to_numeric(ch['type'], errors='coerce').fillna(0) == 0)
                ch = ch[ok]
                if ch.empty: continue

                ci = np.floor(ch.latitude.values / MATCH_CELL).astype(np.int32)
                cj = np.floor(ch.longitude.values / MATCH_CELL).astype(np.int32)
                dates = pd.to_datetime(ch.acq_date.values)
                days = ((dates - EPOCH).days.values).astype(np.int32)
                if 'satellite' in ch:
                    sat = ch['satellite'].astype(str).str[:1].str.upper()
                    sats = sat.map({'A': SAT_A, 'T': SAT_T, 'N': SAT_N}).fillna(SAT_N).astype(np.uint8).values
                else:
                    sats = np.full(len(ch), SAT_A if modis else SAT_N, dtype=np.uint8)

                # dedupe within chunk
                key = (ci.astype(np.int64) * 100000 + cj.astype(np.int64)) * 100000 + days.astype(np.int64)
                _, idx = np.unique(key, return_index=True)
                ci, cj, days, sats = ci[idx], cj[idx], days[idx], sats[idx]

                rec = np.empty(len(ci), dtype=REC_DTYPE)
                rec['ci'] = ci; rec['cj'] = cj; rec['d'] = days; rec['s'] = sats
                fout.write(rec.tobytes())
                total += len(ci)

                d0, d1 = dates.min(), dates.max()
                first_date = d0 if first_date is None else min(first_date, d0)
                last_date = d1 if last_date is None else max(last_date, d1)
                del ci, cj, days, sats, rec, key, idx, dates

    if total == 0:
        os.unlink(path)
        sys.exit(f'No usable rows in {root}. Check RAW_OVERRIDE and the folder contents.')

    print(f'[{region}] {sensor}: {total:,} rows -> {path} ({os.path.getsize(path)/1e9:.1f} GB)')
    arr = np.memmap(path, dtype=REC_DTYPE, mode='r', shape=(total,))
    return arr, (first_date, last_date), path


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------
def metrics(truth, pred):
    big = truth >= MIN_M
    return dict(bias_pct=round(float((pred.sum() / max(truth.sum(), 1) - 1) * 100), 2),
                mape_pct=round(float((abs(pred - truth) / np.maximum(truth, 1))[big].mean() * 100), 1) if big.any() else None,
                r2=round(float(1 - ((truth - pred) ** 2).sum() / max(((truth - truth.mean()) ** 2).sum(), 1e-9)), 3))


CHUNK = 40_000


def run(region):
    print(f'[{region}] loading…')
    Marr, mspan, mpath = _stream_to_disk(region, 'MODIS_SP')
    Varr, vspan, vpath = _stream_to_disk(region, 'VIIRS_SNPP_SP')

    # ---- detect satellites and spans from memmap without loading ----
    M_sats = np.unique(Marr['s'])
    if SAT_A not in M_sats:
        sys.exit('No Aqua rows found. Aqua is needed so MODIS and VIIRS share an afternoon overpass.')

    span = {}
    for s_idx, name in ((SAT_A, 'A'), (SAT_T, 'T')):
        mask = Marr['s'] == s_idx
        if mask.any():
            d = Marr['d'][mask]
            span[name] = (EPOCH + pd.Timedelta(days=int(d.min())),
                          EPOCH + pd.Timedelta(days=int(d.max())))
    vmin, vmax = vspan
    amin, amax = span['A']
    mmin = min(d0 for d0, _ in span.values())
    start = vmin.to_period('M') + (1 if vmin.day > 1 else 0)
    end = min(vmax, amax).to_period('M') - 1
    aq_start = amin.to_period('M') + (1 if amin.day > 1 else 0)
    allp = pd.period_range(min(mmin, vmin).to_period('M'), end, freq='M')
    Tn = len(allp); yrs = list(range(start.year, end.year + 1)); Y = len(yrs)
    kmap_all = np.array([p.month - 1 for p in allp]); p0 = allp[0].ordinal

    def colof(days, sats):
        # month index per row, from days-since-epoch
        dts = pd.to_datetime('2000-01-01') + pd.to_timedelta(days, unit='D')
        return (dts.year.values.astype(np.int64) - 1970) * 12 + dts.month.values - 1 - p0

    # materialize the calendar columns once (a few hundred MB for the whole world)
    cV = colof(Varr['d'], Varr['s'])
    cA_all = Marr['s'] == SAT_A
    cT_all = Marr['s'] == SAT_T
    cA = np.full(len(Marr), -1, dtype=np.int64); cA[cA_all] = colof(Marr['d'][cA_all], None)
    cT = np.full(len(Marr), -1, dtype=np.int64); cT[cT_all] = colof(Marr['d'][cT_all], None)
    inrange = lambda c: (c >= 0) & (c < Tn)
    tot_V = np.bincount(cV[inrange(cV)], minlength=Tn).astype(np.float64)
    tot_A = np.bincount(cA[inrange(cA)], minlength=Tn).astype(np.float64)
    tot_T = np.bincount(cT[inrange(cT)], minlength=Tn).astype(np.float64)

    # ---- place keys (li, lj at LOC_CELL resolution) ----
    def place_keys(arr):
        step = int(round(LOC_CELL / MATCH_CELL))
        li = (arr['ci'] // step).astype(np.int64) + 2000
        lj = (arr['cj'] // step).astype(np.int64) + 4000
        return li * 10000 + lj
    kV = place_keys(Varr); kA = place_keys(Marr); kT = kV  # same function
    lkeys = np.unique(np.concatenate([kV, kA[cA_all]]))
    L = len(lkeys)
    pl_V = np.searchsorted(lkeys, kV).astype(np.int64)
    pl_A = np.full(len(Marr), -1, dtype=np.int64); pl_A[cA_all] = np.searchsorted(lkeys, kA[cA_all])
    pl_T = np.full(len(Marr), -1, dtype=np.int64); pl_T[cT_all] = np.searchsorted(lkeys, kA[cT_all])
    print(f'[{region}] {L:,} places, {Y} overlap years ({start} to {end})')

    # ---- agreement: which VIIRS fire-days did Aqua also see (same cell or neighbour, same day)? ----
    so, eo = start.ordinal - p0, end.ordinal - p0
    Vo_mask = (cV >= so) & (cV <= eo)
    Ao_mask = (cA >= so) & (cA <= eo)
    # Build dilatable key from (place, day) so same-day same-cell or neighbour match
    def daykey(ci, cj, days):
        # pack (day, ci, cj) into int64: day*8192*32768 + (ci+4096)*32768 + (cj+16384)
        return ((days.astype(np.int64) * 8192 + (ci.astype(np.int64) + 4096)) * S +
                (cj.astype(np.int64) + 16384))
    kA_day = daykey(Marr['ci'][cA_all], Marr['cj'][cA_all], Marr['d'][cA_all])
    kV_day = daykey(Varr['ci'], Varr['cj'], Varr['d'])

    mflag = np.zeros(Vo_mask.sum(), dtype=bool)
    Vo_idx = np.where(Vo_mask)[0]
    for y in yrs:
        vm = (Varr['d'][Vo_idx] >= (start.ordinal - p0))  # dummy, replaced below
    # year-wise dilation (needs year column)
    Vo_days = Varr['d'][Vo_idx]
    Vo_years = (EPOCH + pd.to_timedelta(Vo_days, unit='D')).year.values
    Ao_years_all = (EPOCH + pd.to_timedelta(Marr['d'][cA_all], unit='D')).year.values
    for y in yrs:
        vm_in = Vo_years == y
        ak = kA_day[Ao_years_all == y]
        if vm_in.any() and len(ak):
            dil = np.unique(np.concatenate([ak + di * S + dj for di in (-1, 0, 1) for dj in (-1, 0, 1)]))
            mflag[vm_in] = np.isin(kV_day[Vo_idx][vm_in], dil)
        del ak
    del kA_day, Ao_years_all

    def dense(idx, size):
        out = np.zeros(size, np.uint16); u, c = np.unique(idx, return_counts=True); out[u] = c; return out
    Vo_months = ((EPOCH + pd.to_timedelta(Vo_days, unit='D')).month.values - 1)
    idx = (pl_V[Vo_idx] * 12 + Vo_months) * Y + (Vo_years - start.year)
    NV = dense(idx, L * 12 * Y).reshape(L, 12, Y)
    NM = dense(idx[mflag], L * 12 * Y).reshape(L, 12, Y)
    Ao_idx = np.where(Ao_mask)[0]
    Ao_years = (EPOCH + pd.to_timedelta(Marr['d'][Ao_idx], unit='D')).year.values
    MA = dense(pl_A[Ao_idx] * Y + (Ao_years - start.year), L * Y).reshape(L, Y)
    VALID = np.array([[start <= pd.Period(year=y, month=k + 1, freq='M') <= end for y in yrs] for k in range(12)])
    del Vo_idx, Ao_idx, idx, mflag, Vo_days, Vo_months, Vo_years, Ao_years

    # ---- prepare chunked views ----
    def prep_arr(arr, c, pl):
        ok = inrange(c); l, cc = pl[ok], c[ok]
        o = np.argsort(l, kind='stable'); return l[o], cc[o]
    sA = prep_arr(Marr, cA, pl_A)
    sT = prep_arr(Marr, cT, pl_T)
    sV = prep_arr(Varr, cV, pl_V)
    del cV, cA, cT, pl_V, pl_A, pl_T

    def chunk_obs(src, l0, l1):
        i0, i1 = np.searchsorted(src[0], [l0, l1])
        return np.bincount((src[0][i0:i1] - l0) * Tn + src[1][i0:i1], minlength=(l1 - l0) * Tn).reshape(l1 - l0, Tn).astype(np.float32)

    blocks = [(i, min(i + CHUNK, L)) for i in range(0, L, CHUNK)]
    NVr, NMr = NV.sum(0, dtype=np.float64), NM.sum(0, dtype=np.float64)

    def priors(w):
        nv, nm = NVr @ w, NMr @ w
        return nm / np.maximum(nv, 1), nm.sum() / max(nv.sum(), 1)

    def rates_chunk(nv, nm, areg, aall):
        al = (nm.sum(1) + KAPPA * aall) / (nv.sum(1) + KAPPA)
        return np.clip(al[:, None] * (areg / max(aall, 1e-9))[None, :], A_FLOOR, 1.0)

    def params(l0, l1, yix, pri):
        w = np.zeros(Y); w[yix] = 1
        nv, nm = NV[l0:l1] @ w, NM[l0:l1] @ w
        blind = (NV[l0:l1][:, :, yix].sum(1) >= MIN_ACTIVE) & (MA[l0:l1][:, yix] == 0)
        clim = nv / np.maximum(VALID[:, yix].sum(1), 1)
        return dict(a=rates_chunk(nv, nm, *pri), blind=blind,
                    none_seen=MA[l0:l1][:, yix].sum(1) == 0, clim=clim,
                    base=clim * blind.mean(axis=1)[:, None])

    tagof = lambda P, r: RULES[r](P['blind']) & P['none_seen']

    # ---- backtest ----
    bt, chosen, gcols = {}, 'any2', []
    gap = min(3, Y // 3)
    if Y >= 6:
        gcols = [t for t, p in enumerate(allp) if start <= p <= end and p.year - start.year < gap]
        kg, fit_ix = kmap_all[gcols], np.arange(gap, Y)
        wbt = np.zeros(Y); wbt[fit_ix] = 1; pri_bt = priors(wbt)
        acc = {r: np.zeros(len(gcols)) for r in RULES}
        unc, truth = np.zeros(len(gcols)), np.zeros(len(gcols))
        for l0, l1 in blocks:
            og, vg = chunk_obs(sA, l0, l1)[:, gcols], chunk_obs(sV, l0, l1)[:, gcols]
            P = params(l0, l1, fit_ix, pri_bt); ht, base = og / P['a'][:, kg], P['base'][:, kg]
            for r in RULES: acc[r] += (ht + base * tagof(P, r)[:, None]).sum(0)
            unc += og.sum(0); truth += vg.sum(0)
        bt['uncorrected'] = metrics(truth, unc)
        bt['regional ratio only'] = metrics(truth, unc / np.maximum(pri_bt[0][kg], A_FLOOR))
        for r in RULES: bt[r] = metrics(truth, acc[r])
        cand = {r: bt[r] for r in RULES}
        good = {r: m for r, m in cand.items() if abs(m['bias_pct']) <= 15 and m['mape_pct'] is not None}
        chosen = min(good, key=lambda r: good[r]['mape_pct']) if good else min(cand, key=lambda r: abs(cand[r]['bias_pct']))
        print(f'[{region}] backtest -> rule: {chosen}',
              {r: (m['bias_pct'], m['mape_pct']) for r, m in bt.items()})
    else:
        print(f'[{region}] Y<6, no backtest, using {chosen}')

    # ---- rebuild ----
    pri_all = priors(np.ones(Y))
    cols_pre = [t for t, p in enumerate(allp) if p < start]; kpre = kmap_all[cols_pre]; Tp = len(cols_pre)
    cols_post = [t for t, p in enumerate(allp) if p >= start]
    f = np.ones(12)
    for k in range(12):
        ts = [t for t, p in enumerate(allp) if aq_start <= p <= end and p.month - 1 == k]
        if ts and tot_T[ts].sum() > 0: f[k] = tot_A[ts].sum() / tot_T[ts].sum()
    is_aq = np.array([allp[t] >= aq_start for t in cols_pre])
    rng = np.random.default_rng(0)
    boots = [(w, *priors(w)) for w in (np.bincount(rng.integers(0, Y, Y), minlength=Y).astype(np.float32) for _ in range(BOOT))]
    last_full = end.year if end.month == 12 else end.year - 1
    y_start = max(2001, allp[0].year)
    ycols = np.array([[allp.get_loc(pd.Period(year=y, month=m, freq='M')) for m in range(1, 13)]
                      for y in range(y_start, last_full + 1)]); nY = len(ycols)

    li, lj = lkeys // 10000 - 2000, lkeys % 10000 - 4000
    step = int(round(OUT_CELL / LOC_CELL))
    ck = ((li // step) + 500) * 10000 + ((lj // step) + 4000)
    ukeys, cinv = np.unique(ck, return_inverse=True)
    Hall = np.zeros((len(ukeys), Tn), np.float32)
    tot_rule = np.zeros((len(RULES), Tp)); Hpre_t = np.zeros(Tp); fill_t = np.zeros(Tp); boot_t = np.zeros((BOOT, Tp))
    tag_n = 0; prone = []

    for l0, l1 in blocks:
        n = l1 - l0
        oA, oT, vv = chunk_obs(sA, l0, l1), chunk_obs(sT, l0, l1), chunk_obs(sV, l0, l1)
        obs = np.where(is_aq[None, :], oA[:, cols_pre], oT[:, cols_pre] * f[kpre][None, :])
        P = params(l0, l1, np.arange(Y), pri_all); ht, base = obs / P['a'][:, kpre], P['base'][:, kpre]
        for i, r in enumerate(RULES): tot_rule[i] += (ht + base * tagof(P, r)[:, None]).sum(0)
        tag = tagof(P, chosen); fill = base * tag[:, None]; Hpre = ht + fill
        Hpre_t += Hpre.sum(0); fill_t += fill.sum(0); tag_n += int(tag.sum()); fixed = fill.sum(0)
        nvf, nmf = NV[l0:l1].astype(np.float32), NM[l0:l1].astype(np.float32)
        for b, (w, areg, aall) in enumerate(boots):
            boot_t[b] += (obs / rates_chunk(nvf @ w, nmf @ w, areg, aall)[:, kpre]).sum(0) + fixed
        it = np.where(tag)[0]
        if len(it):
            prone.append(np.column_stack([P['base'].sum(1)[it], l0 + it,
                                         P['blind'][it].sum(1), P['clim'].sum(1)[it]]))
        Hm = np.zeros((n, Tn), np.float32); Hm[:, cols_pre] = Hpre; Hm[:, cols_post] = vv[:, cols_post]
        np.add.at(Hall, cinv[l0:l1], Hm)

    Hc = Hall[:, ycols.ravel()].reshape(len(ukeys), nY, 12)
    blo, bhi = np.percentile(boot_t, [2.5, 97.5], axis=0)
    lo_pre, hi_pre = np.minimum(blo, tot_rule.min(0)), np.maximum(bhi, tot_rule.max(0))

    # ---- series ----
    nn = lambda x: None if x is None or pd.isna(x) else round(float(x), 1)
    series = []
    for t, p in enumerate(allp):
        pre = p < start; j = cols_pre.index(t) if pre else None
        series.append(dict(month=str(p),
                           modis=nn(tot_A[t] if p >= aq_start else tot_T[t] * f[p.month - 1]),
                           viirs=None if pre else nn(tot_V[t]),
                           harmonized=nn(Hpre_t[j] if pre else tot_V[t]),
                           lo=nn(lo_pre[j] if pre else tot_V[t]),
                           hi=nn(hi_pre[j] if pre else tot_V[t]),
                           filled=nn(fill_t[j] if pre else 0),
                           source='MODIS + gap fill' if pre else 'VIIRS'))

    Am = np.zeros((12, Y))
    for t, p in enumerate(allp):
        if start <= p <= end: Am[p.month - 1, p.year - start.year] = tot_A[t]
    def band_fn(num, den):
        pt = num.sum(1) / np.maximum(den.sum(1), 1)
        dr = [(num @ w) / np.maximum(den @ w, 1) for w in (np.bincount(rng.integers(0, Y, Y), minlength=Y) for _ in range(BOOT))]
        lo, hi = np.percentile(dr, [2.5, 97.5], axis=0); return pt, lo, hi
    rpt, rlo, rhi = band_fn(NVr, Am)
    dpt, dlo, dhi = band_fn(NMr, NVr)
    mean, p10, p90 = Hc.mean(1), np.quantile(Hc, .1, axis=1), np.quantile(Hc, .9, axis=1)
    cells = [dict(lat=round(((u // 10000) - 500 + .5) * OUT_CELL, 3),
                  lon=round(((u % 10000) - 4000 + .5) * OUT_CELL, 3),
                  mean=[round(float(x), 1) for x in mean[i]],
                  p10=[round(float(x), 1) for x in p10[i]],
                  p90=[round(float(x), 1) for x in p90[i]])
             for i, u in enumerate(ukeys) if mean[i].sum() > 0]
    pr = np.concatenate(prone) if prone else np.zeros((0, 4))
    pr = pr[np.argsort(-pr[:, 0])][:1500]
    prone_out = [dict(lat=round((li[int(r[1])] + .5) * LOC_CELL, 3),
                      lon=round((lj[int(r[1])] + .5) * LOC_CELL, 3),
                      years=int(r[2]), usual=round(float(r[3]), 1)) for r in pr]

    val = dict(bt.get(chosen, {}), held_out_months=len(gcols),
               raw_viirs_bias_pct=round(float((NVr.sum() / max(Am.sum(), 1) - 1) * 100), 1))
    meta = dict(region=region, bbox=REGIONS[region]['bbox'], note=REGIONS[region]['note'],
                baseline='VIIRS-equivalent',
                unit='fire cell-days per month, VIIRS-equivalent (0.02 degree cells)',
                filters=f'MODIS Aqua confidence >= {MODIS_CONF_MIN}; VIIRS nominal/high; vegetation-fire type only',
                overlap=[str(start), str(end)], pooled_ratio=round(float(NVr.sum() / max(Am.sum(), 1)), 3),
                ratios={k + 1: dict(ratio=round(float(rpt[k]), 3), lo=round(float(rlo[k]), 3), hi=round(float(rhi[k]), 3)) for k in range(12)},
                detection_rate={k + 1: dict(rate=round(float(dpt[k]), 3), lo=round(float(dlo[k]), 3), hi=round(float(dhi[k]), 3)) for k in range(12)},
                validation=val, chosen_rule=chosen, rule_text=RULE_TEXT,
                backtest=[dict(rule=r, **m) for r, m in bt.items()],
                fireprone_places=tag_n,
                fill_share_pre2012=round(float(fill_t.sum() / max(Hpre_t.sum(), 1) * 100), 1),
                cell_deg=OUT_CELL, climatology_years=[y_start, last_full],
                terra_to_aqua=[round(float(x), 3) for x in f])
    os.makedirs(OUT, exist_ok=True)
    for name, body in (('series', dict(meta=meta, series=series)),
                       ('cells', dict(meta=meta, cells=cells)),
                       ('prone', dict(meta=meta, places=prone_out))):
        json.dump(body, open(os.path.join(OUT, f'{region}_{name}.json'), 'w'))
    act = np.where(Hall.sum(1) > 0)[0]
    np.clip(np.round(Hall[act]), 0, 32767).astype('<i2').tofile(os.path.join(OUT, f'{region}_monthly.bin'))
    json.dump(dict(meta=meta, first=str(allp[0]), months=Tn, cell_deg=OUT_CELL,
                   cells=[[round(((ukeys[i] // 10000) - 500 + .5) * OUT_CELL, 3),
                           round(((ukeys[i] % 10000) - 4000 + .5) * OUT_CELL, 3)] for i in act]),
              open(os.path.join(OUT, f'{region}_monthly.json'), 'w'))
    print(f'[{region}] done | rule {chosen} | {tag_n} fire-prone places | '
          f'{meta["fill_share_pre2012"]}% estimated | {len(cells)} cells')

    # cleanup temp files
    for p in (mpath, vpath):
        try: os.unlink(p)
        except OSError: pass
    return series


if __name__ == '__main__':
    for reg in (sys.argv[1:] or list(REGIONS)):
        run(reg)