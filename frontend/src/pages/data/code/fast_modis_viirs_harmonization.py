#!/usr/bin/env python3
"""Fast, schema-compatible global MODIS/VIIRS yearly harmonization for Colab.

Install in Colab: !pip -q install rtree numba
Mount Drive: from google.colab import drive; drive.mount('/content/drive')
Run: %run /content/drive/MyDrive/path/to/fast_modis_viirs_harmonization.py

Matches the supplied algorithm's data semantics:
- acquisition time = acq_date * 1440 + acq_time (reject acq_time >= 1440)
- north-aligned rectangles from scan/track, including boundary-only contacts
- time window 720 minutes, regardless of satellite; different streams only
- connected components with minimum global observation ID as group_id
- exactly the same final BIN schemas and output names

Speed improvements: 3D (longitude,latitude,time) bulk-loaded R-tree;
vectorized/precomputed rectangular bounds and areas; Numba compiled
intersection+union-find, compression, and group statistics; local input staging;
chunked data creation and progress reporting.

Note: Output record order and floating-point last bits may differ from an old run.
Candidate counts, group IDs, grouping, and schema should agree for identical inputs.
"""

import hashlib
import json
import math
import os
import shutil
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
try:
    from rtree import index
except ImportError as exc:
    raise SystemExit("Missing rtree. In Colab first run: !pip -q install rtree numba") from exc
try:
    from numba import njit
except ImportError as exc:
    raise SystemExit("Missing numba. In Colab first run: !pip -q install rtree numba") from exc


# ====================== CONFIGURATION ======================
YEAR = 2015
SOURCE_ROOT = "/content/drive/MyDrive/observations"
DRIVE_OUTPUT_ROOT = "/content/drive/MyDrive/harmonization/global"
WORK_ROOT = f"/content/harmonization_work/{YEAR}"
OUTPUT_ROOT = os.path.join(DRIVE_OUTPUT_ROOT, str(YEAR))

CHUNK_SIZE = 100_000
CANDIDATE_BATCH_SIZE = 200_000
RTREE_QUERY_BATCH_SIZE = 256   # Bulk R-tree query window; lower if hits are extremely dense.
USE_BULK_RTREE_QUERIES = True  # Uses Rtree >=1.4 intersection_v when available.
MAX_TIME_DIFFERENCE_MINUTES = 720
KM_PER_DEGREE = 111.32
EARTH_RADIUS_M = 6_371_008.8
FORCE_REPROCESS = False

# Local copies substantially improve random reads when originals are on Drive.
# If space is insufficient, original files are used (slower, with a warning).
STAGE_INPUTS_LOCALLY = True
VERIFY_UPLOAD_SHA256 = False  # Turn on for full byte-level verification; slower.
PROGRESS_INTERVAL_SECONDS = 5.0
DISPLAY_TIMEZONE = "Africa/Kampala"  # Stage ETA and completion clock.
REMOVE_LOCAL_WORK_AFTER_SUCCESS = False

SATELLITES = [
    "MODIS_Terra", "MODIS_Aqua", "VIIRS_SNPP", "VIIRS_NOAA20", "VIIRS_NOAA21"
]
SATELLITE_CODES = {name: i + 1 for i, name in enumerate(SATELLITES)}
SATELLITE_FOLDERS = {
    "MODIS_Terra": "MODIS", "MODIS_Aqua": "MODIS",
    "VIIRS_SNPP": "VIIRS_SNPP", "VIIRS_NOAA20": "VIIRS_NOAA20",
    "VIIRS_NOAA21": "VIIRS_NOAA21",
}

# ====================== ORIGINAL BIN SCHEMAS ======================
RECORD_DTYPE = np.dtype([
    ("latitude", "<f4"), ("longitude", "<f4"),
    ("brightness", "<f4"), ("scan", "<f4"), ("track", "<f4"),
    ("acq_date", "<u4"), ("acq_time", "<u2"), ("confidence", "u1"),
    ("bright_t31", "<f4"), ("frp", "<f4"),
    ("daynight", "u1"), ("type", "u1"),
], align=False)
FOOTPRINT_DTYPE = np.dtype([
    ("valid", "u1"), ("corners", "<f8", (4, 2)),
], align=False)
CANDIDATE_DTYPE = np.dtype([
    ("global_id_a", "<u8"), ("global_id_b", "<u8"),
    ("time_diff_minutes", "<u2"),
], align=False)
EDGE_DTYPE = np.dtype([
    ("global_id_a", "<u8"), ("global_id_b", "<u8"),
    ("time_diff_minutes", "<u2"),
    ("intersection_area_m2", "<f8"), ("union_area_m2", "<f8"),
    ("smaller_area_m2", "<f8"), ("iou", "<f4"),
    ("overlap_smaller", "<f4"),
], align=False)
MEMBER_DTYPE = np.dtype([
    ("group_id", "<u8"), ("global_id", "<u8"),
    ("observation_id", "<u8"), ("satellite_code", "u1"),
    ("local_position", "<u8"),
], align=False)
GROUP_DTYPE = np.dtype([
    ("group_id", "<u8"), ("member_count", "<u4"),
    ("satellite_mask", "u1"), ("earliest_minutes", "<u8"),
    ("latest_minutes", "<u8"),
], align=False)
assert (RECORD_DTYPE.itemsize, FOOTPRINT_DTYPE.itemsize,
        CANDIDATE_DTYPE.itemsize, EDGE_DTYPE.itemsize,
        MEMBER_DTYPE.itemsize, GROUP_DTYPE.itemsize) == (37, 65, 18, 50, 33, 29)


# ====================== REPORTING ======================
try:
    LOCAL_TZ = ZoneInfo(DISPLAY_TIMEZONE)
except Exception:
    LOCAL_TZ = timezone.utc

def clock_string(dt=None):
    if dt is None:
        dt = datetime.now(LOCAL_TZ)
    return dt.strftime("%Y-%m-%d %H:%M:%S %Z")

def duration_string(seconds):
    seconds = max(0, int(seconds))
    d, rem = divmod(seconds, 86400)
    h, rem = divmod(rem, 3600)
    m, s = divmod(rem, 60)
    return (f"{d}d " if d else "") + f"{h:02}:{m:02}:{s:02}"

def section(title):
    print("\n" + "=" * 76 + "\n" + title + "\n" + "=" * 76, flush=True)

class Progress:
    """Periodic progress, current rate, elapsed, stage ETA, projected end time."""
    def __init__(self, label, total, unit="items"):
        self.label, self.total, self.unit = label, int(total), unit
        self.start = time.monotonic()
        self.last = self.start - PROGRESS_INTERVAL_SECONDS
        self.done_count = 0
        print(f"\nSTART {label}: {self.total:,} {unit} @ {clock_string()}", flush=True)

    def update(self, value, detail="", force=False):
        value = min(int(value), self.total)
        self.done_count = value
        now = time.monotonic()
        if not force and now - self.last < PROGRESS_INTERVAL_SECONDS:
            return
        self.last = now
        elapsed = max(now - self.start, 0.000001)
        rate = value / elapsed
        ratio = value / self.total if self.total else 1.0
        remaining = (self.total - value) / rate if rate > 0 else None
        eta = (clock_string(datetime.now(LOCAL_TZ) + timedelta(seconds=remaining))
               if remaining is not None else "calculating")
        eta_duration = duration_string(remaining) if remaining is not None else "--"
        line = (f"{self.label}: {ratio:6.2%} | {value:,}/{self.total:,} {self.unit} "
                f"| {rate:,.1f}/s | elapsed {duration_string(elapsed)} "
                f"| left {eta_duration} | finish ~{eta}")
        if detail:
            line += f" | {detail}"
        print(line, flush=True)

    def finish(self, detail=""):
        self.update(self.total, detail=detail, force=True)
        print(f"DONE {self.label}: {duration_string(time.monotonic()-self.start)}", flush=True)


def path_in_work(name):
    return os.path.join(WORK_ROOT, name)

def verify_size(path, count, dtype):
    expected = int(count) * np.dtype(dtype).itemsize
    observed = os.path.getsize(path)
    if observed != expected:
        raise RuntimeError(f"Invalid size: {path}: expected {expected}, got {observed}")


def discover_streams():
    section("DISCOVERING AND VALIDATING INPUTS")
    streams = []
    offset = 1
    for sat in SATELLITES:
        original = os.path.join(SOURCE_ROOT, SATELLITE_FOLDERS[sat], f"{sat}_{YEAR}.bin")
        if not os.path.isfile(original):
            print(f"NOT AVAILABLE: {sat}", flush=True)
            continue
        size = os.path.getsize(original)
        if size == 0 or size % RECORD_DTYPE.itemsize:
            raise RuntimeError(f"Invalid source size: {original} ({size} bytes)")
        count = size // RECORD_DTYPE.itemsize
        streams.append(dict(satellite=sat, code=SATELLITE_CODES[sat],
                            path=original, work_path=original, count=count,
                            size_bytes=size, base_global_id=offset,
                            end_global_id=offset + count))
        offset += count
        print(f"FOUND: {sat:18s} {count:>15,} records ({size / 2**30:.3f} GiB)")
    if not streams:
        raise RuntimeError(f"No input streams found for {YEAR}")
    return streams, offset - 1


def stage_inputs(streams, total):
    if not STAGE_INPUTS_LOCALLY:
        print("Local input staging disabled. Reading original source paths.")
        return
    section("STAGING ORIGINAL BIN FILES TO FAST LOCAL STORAGE")
    free = shutil.disk_usage(WORK_ROOT).free
    input_bytes = sum(s["size_bytes"] for s in streams)
    # Working files (not candidate/edge outputs, whose sizes depend on matches).
    # Extra margin protects the system from running out of space during processing.
    expected_work = total * 210 + 512 * 1024**2
    if free < input_bytes + expected_work:
        print(f"WARNING: free {free / 2**30:.2f} GiB; estimated need "
              f"{(input_bytes+expected_work) / 2**30:.2f} GiB. "
              "Skipping local staging. Candidate/edge output may require more space.")
        return
    p = Progress("Local input copies", input_bytes, "bytes")
    copied = 0
    for s in streams:
        target = path_in_work(f"sources/{s['satellite']}_{YEAR}.bin")
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(s["path"], "rb") as src, open(target + ".partial", "wb") as dst:
            while True:
                block = src.read(16 * 1024**2)
                if not block:
                    break
                dst.write(block)
                copied += len(block)
                p.update(copied, detail=s["satellite"])
        verify_size(target + ".partial", s["count"], RECORD_DTYPE)
        os.replace(target + ".partial", target)
        s["work_path"] = target
        print(f"Staged: {s['satellite']}")
    p.finish()


# ====================== FOOTPRINT GENERATION ======================
def build_footprints(records):
    n = len(records)
    out = np.zeros(n, dtype=FOOTPRINT_DTYPE)
    out["corners"][:] = np.nan
    lat = records["latitude"].astype(np.float64)
    lon = records["longitude"].astype(np.float64)
    scan = records["scan"].astype(np.float64)
    track = records["track"].astype(np.float64)
    valid = (np.isfinite(lat) & np.isfinite(lon) &
             np.isfinite(scan) & np.isfinite(track) &
             (np.abs(lat) <= 90) & (np.abs(lon) <= 180) &
             (scan > 0) & (track > 0) & (np.abs(lat) < 89.9))
    positions = np.flatnonzero(valid)
    if not len(positions):
        return out
    lv, ov = lat[positions], lon[positions]
    half_lat = track[positions] / (2 * KM_PER_DEGREE)
    half_lon = scan[positions] / (2 * KM_PER_DEGREE * np.cos(np.radians(lv)))
    south, north = lv - half_lat, lv + half_lat
    west, east = ov - half_lon, ov + half_lon
    keep = ((south >= -90) & (north <= 90) & (west >= -180) & (east <= 180))
    positions = positions[keep]
    if not len(positions):
        return out
    south, north, west, east = south[keep], north[keep], west[keep], east[keep]
    corners = np.stack([
        np.column_stack((west, south)), np.column_stack((west, north)),
        np.column_stack((east, north)), np.column_stack((east, south)),
    ], axis=1)
    out["valid"][positions] = 1
    out["corners"][positions] = corners
    return out


def prepare_streams(streams, total):
    section("GENERATING IDS, FOOTPRINTS, AND FAST LOOKUP TABLES")
    # Index 0 is unused; global IDs 1..total remain exactly the original layout.
    bounds = np.memmap(path_in_work("bounds.bin"), dtype="<f8", mode="w+",
                       shape=(total + 1, 4))  # west,south,east,north
    areas = np.memmap(path_in_work("areas.bin"), dtype="<f8", mode="w+",
                      shape=(total + 1,))
    times = np.memmap(path_in_work("times.bin"), dtype="<i8", mode="w+",
                      shape=(total + 1,))
    bounds[:] = 0
    areas[:] = 0
    times[:] = -1
    p = Progress("Build observations", total, "observations")
    completed = 0
    total_indexable = 0
    for s in streams:
        sat = s["satellite"]
        sat_dir = path_in_work(sat)
        os.makedirs(sat_dir, exist_ok=True)
        fp_path = os.path.join(sat_dir, "footprints.bin")
        ids_path = os.path.join(sat_dir, "observation_ids.bin")
        count, base = s["count"], s["base_global_id"]
        records = np.memmap(s["work_path"], dtype=RECORD_DTYPE, mode="r", shape=(count,))
        valid_count = 0
        valid_times_count = 0
        with open(fp_path, "wb") as fd_fp, open(ids_path, "wb") as fd_ids:
            for start in range(0, count, CHUNK_SIZE):
                end = min(start + CHUNK_SIZE, count)
                batch = records[start:end]
                fp = build_footprints(batch)
                fp.tofile(fd_fp)
                np.arange(start, end, dtype="<u8").tofile(fd_ids)
                gid_start, gid_end = base + start, base + end
                t = (batch["acq_date"].astype(np.int64) * 1440 +
                     batch["acq_time"].astype(np.int64))
                t[batch["acq_time"] >= 1440] = -1
                times[gid_start:gid_end] = t
                isvalid = fp["valid"] == 1
                positions = np.flatnonzero(isvalid)
                valid_count += len(positions)
                valid_times_count += np.count_nonzero(t[positions] >= 0)
                if len(positions):
                    corners = fp["corners"][positions]
                    # Stored corners are west/south, west/north, east/north, east/south.
                    w = corners[:, :, 0].min(axis=1)
                    e = corners[:, :, 0].max(axis=1)
                    so = corners[:, :, 1].min(axis=1)
                    n = corners[:, :, 1].max(axis=1)
                    dest = gid_start + positions
                    bounds[dest, 0] = w
                    bounds[dest, 1] = so
                    bounds[dest, 2] = e
                    bounds[dest, 3] = n
                    areas[dest] = (EARTH_RADIUS_M ** 2 * np.radians(e - w) *
                                   (np.sin(np.radians(n)) - np.sin(np.radians(so))))
                completed += end - start
                p.update(completed, detail=f"{sat}, valid footprints {valid_count:,}")
        del records
        verify_size(fp_path, count, FOOTPRINT_DTYPE)
        verify_size(ids_path, count, "<u8")
        s.update(footprint_path=fp_path, id_path=ids_path,
                 valid_footprints=int(valid_count),
                 invalid_footprints=int(count - valid_count),
                 indexable=int(valid_times_count))
        total_indexable += valid_times_count
        print(f"Completed {sat}: {valid_count:,} valid footprints; "
              f"{valid_times_count:,} valid footprints with usable acquisition time")
    bounds.flush()
    areas.flush()
    times.flush()
    p.finish()
    return bounds, areas, times, total_indexable


# ====================== SPATIOTEMPORAL R-TREE ======================
def footprint_entries(streams, bounds, times, p):
    checked = 0
    for s in streams:
        base, count = s["base_global_id"], s["count"]
        fp = np.memmap(s["footprint_path"], dtype=FOOTPRINT_DTYPE,
                       mode="r", shape=(count,))
        for start in range(0, count, CHUNK_SIZE):
            end = min(start + CHUNK_SIZE, count)
            ts = times[base + start:base + end]
            valid = np.flatnonzero((fp["valid"][start:end] == 1) & (ts >= 0))
            for pos in valid:
                gid = base + start + int(pos)
                w, south, east, north = bounds[gid]
                stamp = float(ts[int(pos)])
                yield (int(gid), (float(w), float(south), stamp,
                                  float(east), float(north), stamp), None)
            checked += end - start
            p.update(checked, detail=s["satellite"])
        del fp


def build_spatiotemporal_index(streams, bounds, times, total):
    section("BUILDING DISK-BACKED 3D R-TREE (LONGITUDE, LATITUDE, TIME)")
    directory = path_in_work("spatial_index")
    os.makedirs(directory, exist_ok=True)
    idx_path = os.path.join(directory, f"global_{YEAR}_rtree")
    properties = index.Property()
    properties.dimension = 3
    properties.overwrite = True
    properties.leaf_capacity = 1000
    properties.index_capacity = 1000
    p = Progress("R-tree bulk load", total, "observations")
    idx = index.Index(idx_path, footprint_entries(streams, bounds, times, p),
                      properties=properties, interleaved=True)
    idx.close()
    p.finish()
    manifest = {
        "year": YEAR, "index_type": "3D R-tree", "coordinate_order":
        "longitude, latitude, source_encoded_acquisition_minutes",
        "total_observations": total,
        "indexable_observations": sum(s["indexable"] for s in streams),
        "streams": [{k: v for k, v in s.items() if k != "work_path"} for s in streams]
    }
    with open(os.path.join(directory, "index_manifest.json"), "w") as fd:
        json.dump(manifest, fd, indent=2)
    return idx_path


# ====================== CANDIDATE DISCOVERY ======================
def empty_candidate_files():
    path = path_in_work("candidate_pairs.bin")
    Path(path).touch()
    summary = {"spatial_queries": 0, "temporal_rejections": 0,
               "invalid_time_rejections": 0, "candidate_pairs": 0,
               "candidate_file_bytes": 0,
               "note": "3D R-tree filters time during index search."}
    with open(path_in_work("candidate_search_summary.json"), "w") as fd:
        json.dump(summary, fd, indent=2)
    return path, 0


def build_candidate_pairs(streams, index_path, bounds, times, total):
    section("FINDING CROSS-SATELLITE CANDIDATES WITH SPATIAL+TIME FILTER")
    # Reopen with dimension=3 explicitly; otherwise rtree defaults to 2D.
    reopen_properties = index.Property()
    reopen_properties.dimension = 3
    idx = index.Index(index_path, properties=reopen_properties, interleaved=True)
    use_bulk = USE_BULK_RTREE_QUERIES and callable(getattr(idx, "intersection_v", None))
    print("Candidate search engine:", "vectorized intersection_v" if use_bulk
          else "per-observation R-tree query (compatible fallback)")
    out_path = path_in_work("candidate_pairs.bin")
    p = Progress("3D R-tree queries", total, "observations")
    completed = 0
    count = 0
    scanned_results = 0
    temporal_rejections = 0
    invalid_sources = 0
    buffer = []

    def flush_rows(dst, left, right, diff):
        """Stream a vector batch directly to disk without Python tuple creation."""
        n = len(left)
        for start in range(0, n, CANDIDATE_BATCH_SIZE):
            end = min(start + CANDIDATE_BATCH_SIZE, n)
            rows = np.empty(end - start, dtype=CANDIDATE_DTYPE)
            rows["global_id_a"] = left[start:end]
            rows["global_id_b"] = right[start:end]
            rows["time_diff_minutes"] = diff[start:end]
            rows.tofile(dst)
        return n

    with open(out_path, "wb") as dst:
        for s in streams:
            count_s = s["count"]
            base = s["base_global_id"]
            later_start = s["end_global_id"]  # First ID of the next satellite.
            fp = np.memmap(s["footprint_path"], dtype=FOOTPRINT_DTYPE,
                           mode="r", shape=(count_s,))
            for start in range(0, count_s, CHUNK_SIZE):
                end = min(start + CHUNK_SIZE, count_s)
                valid_positions = np.flatnonzero(fp["valid"][start:end] == 1)
                ids_all = base + start + valid_positions.astype(np.int64)
                valid_time = times[ids_all] >= 0
                invalid_sources += int(np.count_nonzero(~valid_time))
                ids_valid = ids_all[valid_time]

                if use_bulk:
                    for j in range(0, len(ids_valid), RTREE_QUERY_BATCH_SIZE):
                        aids = ids_valid[j:j + RTREE_QUERY_BATCH_SIZE]
                        xyz = np.asarray(bounds[aids], dtype=np.float64)
                        ta = np.asarray(times[aids], dtype=np.int64)
                        mins = np.empty((len(aids), 3), dtype=np.float64)
                        maxs = np.empty_like(mins)
                        mins[:, 0] = xyz[:, 0]
                        mins[:, 1] = xyz[:, 1]
                        mins[:, 2] = ta - MAX_TIME_DIFFERENCE_MINUTES
                        maxs[:, 0] = xyz[:, 2]
                        maxs[:, 1] = xyz[:, 3]
                        maxs[:, 2] = ta + MAX_TIME_DIFFERENCE_MINUTES
                        hit_ids, hit_counts = idx.intersection_v(mins, maxs)
                        scanned_results += len(hit_ids)
                        if not len(hit_ids):
                            continue
                        # Rtree's grouped hit counts are aligned with the query order.
                        hit_ids = np.asarray(hit_ids, dtype=np.int64)
                        hit_counts = np.asarray(hit_counts, dtype=np.int64)
                        if len(hit_counts) != len(aids) or hit_counts.sum() != len(hit_ids):
                            raise RuntimeError("Unexpected intersection_v result lengths")
                        keep = hit_ids >= later_start
                        if not np.any(keep):
                            continue
                        source_ids = np.repeat(aids, hit_counts)[keep]
                        target_ids = hit_ids[keep]
                        dt = np.abs(np.asarray(times[source_ids], dtype=np.int64) -
                                    np.asarray(times[target_ids], dtype=np.int64))
                        exact_time = ((times[target_ids] >= 0) &
                                      (dt <= MAX_TIME_DIFFERENCE_MINUTES))
                        temporal_rejections += int(np.count_nonzero(~exact_time))
                        if np.any(exact_time):
                            count += flush_rows(dst, source_ids[exact_time],
                                                target_ids[exact_time], dt[exact_time])
                else:
                    # Fallback for installations without vectorized intersection_v.
                    for gid_a in ids_valid:
                        gid_a = int(gid_a)
                        ta = int(times[gid_a])
                        w, south, east, north = bounds[gid_a]
                        bbox = (float(w), float(south),
                                float(ta - MAX_TIME_DIFFERENCE_MINUTES),
                                float(east), float(north),
                                float(ta + MAX_TIME_DIFFERENCE_MINUTES))
                        for gid_b in idx.intersection(bbox):
                            scanned_results += 1
                            if gid_b < later_start:
                                continue
                            tb = int(times[gid_b])
                            difference = abs(ta - tb)
                            if tb < 0 or difference > MAX_TIME_DIFFERENCE_MINUTES:
                                temporal_rejections += 1
                                continue
                            buffer.append((gid_a, gid_b, difference))
                            if len(buffer) >= CANDIDATE_BATCH_SIZE:
                                np.asarray(buffer, dtype=CANDIDATE_DTYPE).tofile(dst)
                                count += len(buffer)
                                buffer.clear()
                completed += end - start
                p.update(completed, detail=f"{s['satellite']}; candidates {count+len(buffer):,}")
            del fp
            print(f"Candidate pass completed: {s['satellite']}", flush=True)
        if buffer:
            np.asarray(buffer, dtype=CANDIDATE_DTYPE).tofile(dst)
            count += len(buffer)
            buffer.clear()
    idx.close()
    p.finish(detail=f"candidates {count:,}")
    verify_size(out_path, count, CANDIDATE_DTYPE)
    summary = {"spatial_queries": scanned_results,
               "temporal_rejections": temporal_rejections,
               "invalid_time_rejections": invalid_sources,
               "candidate_pairs": count,
               "candidate_file_bytes": os.path.getsize(out_path),
               "note": "3D R-tree filters by time before returning spatial hits; "
                       "query/rejection counters are not comparable to 2D R-tree diagnostics."}
    with open(path_in_work("candidate_search_summary.json"), "w") as fd:
        json.dump(summary, fd, indent=2)
    print(f"Candidates written: {count:,}")
    return out_path, count


# ====================== COMPILED UNION-FIND AND EDGES ======================
@njit(cache=False)
def _find(parent, x):
    # Explicit uint64 avoids Numba's mixed signed/unsigned -> float promotion.
    x = np.uint64(x)
    root = x
    while parent[root] != root:
        root = parent[root]
    while parent[x] != x:
        nxt = parent[x]
        parent[x] = root
        x = nxt
    return root

@njit(cache=False)
def _union_min(parent, a, b):
    ra = _find(parent, a)
    rb = _find(parent, b)
    if ra != rb:
        if ra < rb:
            parent[rb] = ra
        else:
            parent[ra] = rb

@njit(cache=False)
def _eval_edges(batch, bounds, areas, parent, edge_out):
    n_out = 0
    rejected = 0
    for i in range(len(batch)):
        a = int(batch[i]["global_id_a"])
        b = int(batch[i]["global_id_b"])
        w = max(bounds[a, 0], bounds[b, 0])
        south = max(bounds[a, 1], bounds[b, 1])
        east = min(bounds[a, 2], bounds[b, 2])
        north = min(bounds[a, 3], bounds[b, 3])
        if east < w or north < south:
            rejected += 1
            continue
        # The original algorithm accepts boundary-only contacts: area = 0.
        if east <= w or north <= south:
            intersection = 0.0
        else:
            intersection = (EARTH_RADIUS_M ** 2 * math.radians(east - w) *
                            (math.sin(math.radians(north)) -
                             math.sin(math.radians(south))))
        union_area = areas[a] + areas[b] - intersection
        smaller_area = min(areas[a], areas[b])
        iou = intersection / union_area if union_area > 0.0 else 0.0
        overlap = intersection / smaller_area if smaller_area > 0.0 else 0.0
        edge_out[n_out]["global_id_a"] = batch[i]["global_id_a"]
        edge_out[n_out]["global_id_b"] = batch[i]["global_id_b"]
        edge_out[n_out]["time_diff_minutes"] = batch[i]["time_diff_minutes"]
        edge_out[n_out]["intersection_area_m2"] = intersection
        edge_out[n_out]["union_area_m2"] = union_area
        edge_out[n_out]["smaller_area_m2"] = smaller_area
        edge_out[n_out]["iou"] = iou
        edge_out[n_out]["overlap_smaller"] = overlap
        _union_min(parent, a, b)
        n_out += 1
    return n_out, rejected

@njit(cache=False)
def _compress(parent, start, end):
    for gid in range(start, end):
        parent[gid] = _find(parent, gid)

@njit(cache=False)
def _accumulate_groups(gids, time_values, sat_code,
                       counts, masks, earliest, latest):
    mask_bit = np.uint8(1 << (sat_code - 1))
    for i in range(len(gids)):
        gid = int(gids[i])
        counts[gid] += np.uint32(1)
        masks[gid] |= mask_bit
        t = time_values[i]
        if t >= 0:
            ut = np.uint64(t)
            if ut < earliest[gid]:
                earliest[gid] = ut
            if ut > latest[gid]:
                latest[gid] = ut


def initialize_parent(total):
    p_path = path_in_work("parent.bin")
    parent = np.memmap(p_path, dtype="<u8", mode="w+", shape=(total + 1,))
    parent[0] = 0
    for start in range(1, total + 1, CHUNK_SIZE):
        end = min(start + CHUNK_SIZE, total + 1)
        parent[start:end] = np.arange(start, end, dtype=np.uint64)
    parent.flush()
    return parent


def harmonize_candidates(total, candidate_path, candidate_count, bounds, areas):
    section("NUMBA-ACCELERATED RECTANGLE INTERSECTIONS AND UNION-FIND")
    parent = initialize_parent(total)
    edges_path = path_in_work("harmonized_edges.bin")
    if not candidate_count:
        Path(edges_path).touch()
        print("No candidate pairs; produced empty harmonized_edges.bin")
        return parent, 0, 0
    candidates = np.memmap(candidate_path, dtype=CANDIDATE_DTYPE,
                           mode="r", shape=(candidate_count,))
    p = Progress("Exact edges + union", candidate_count, "candidate pairs")
    exact, non_intersections = 0, 0
    with open(edges_path, "wb") as dst:
        for start in range(0, candidate_count, CANDIDATE_BATCH_SIZE):
            end = min(start + CANDIDATE_BATCH_SIZE, candidate_count)
            batch = candidates[start:end]
            out = np.empty(len(batch), dtype=EDGE_DTYPE)
            matched, discarded = _eval_edges(batch, bounds, areas, parent, out)
            if matched:
                out[:matched].tofile(dst)
            exact += matched
            non_intersections += discarded
            p.update(end, detail=f"intersections {exact:,}")
    del candidates
    parent.flush()
    verify_size(edges_path, exact, EDGE_DTYPE)
    p.finish(detail=f"intersections {exact:,}; rejections {non_intersections:,}")
    return parent, exact, non_intersections


def compress_groups(parent, total):
    section("COMPRESSING UNION-FIND COMPONENTS")
    p = Progress("Root compression", total, "observations")
    for start in range(1, total + 1, CHUNK_SIZE):
        end = min(start + CHUNK_SIZE, total + 1)
        _compress(parent, start, end)
        p.update(end - 1)
    parent.flush()
    p.finish()
    return parent


# ====================== OUTPUT FILES ======================
def write_outputs(streams, total, parent, times):
    section("WRITING ORIGINAL-SCHEMA MEMBERS AND GROUPS")
    paths = {"counts": path_in_work("group_counts.tmp"),
             "masks": path_in_work("group_masks.tmp"),
             "earliest": path_in_work("group_earliest.tmp"),
             "latest": path_in_work("group_latest.tmp")}
    counts = np.memmap(paths["counts"], dtype="<u4", mode="w+", shape=(total+1,))
    masks = np.memmap(paths["masks"], dtype="u1", mode="w+", shape=(total+1,))
    earliest = np.memmap(paths["earliest"], dtype="<u8", mode="w+", shape=(total+1,))
    latest = np.memmap(paths["latest"], dtype="<u8", mode="w+", shape=(total+1,))
    counts[:] = 0
    masks[:] = 0
    earliest[:] = np.iinfo(np.uint64).max
    latest[:] = 0
    member_path = path_in_work("harmonized_members.bin")
    p = Progress("Members + group statistics", total, "observations")
    done = 0
    with open(member_path, "wb") as fd:
        for s in streams:
            base, count, code = s["base_global_id"], s["count"], s["code"]
            for start in range(0, count, CHUNK_SIZE):
                end = min(start + CHUNK_SIZE, count)
                global_start, global_end = base + start, base + end
                gids = np.asarray(parent[global_start:global_end])
                positions = np.arange(start, end, dtype=np.uint64)
                members = np.empty(end - start, dtype=MEMBER_DTYPE)
                members["group_id"] = gids
                members["global_id"] = base + positions
                members["observation_id"] = positions
                members["satellite_code"] = code
                members["local_position"] = positions
                members.tofile(fd)
                _accumulate_groups(gids, times[global_start:global_end], code,
                                   counts, masks, earliest, latest)
                done += end - start
                p.update(done, detail=s["satellite"])
            print(f"Members written: {s['satellite']}")
    p.finish()
    verify_size(member_path, total, MEMBER_DTYPE)
    for x in (counts, masks, earliest, latest):
        x.flush()

    group_path = path_in_work("harmonized_groups.bin")
    group_count = singletons = multi = matched_observations = counted_members = 0
    p = Progress("Group summary records", total, "global IDs scanned")
    with open(group_path, "wb") as fd:
        for start in range(1, total + 1, CHUNK_SIZE):
            end = min(start + CHUNK_SIZE, total + 1)
            positions = np.flatnonzero(counts[start:end] > 0)
            if len(positions):
                gids = positions.astype(np.uint64) + start
                groups = np.empty(len(gids), dtype=GROUP_DTYPE)
                sizes = counts[gids]
                groups["group_id"] = gids
                groups["member_count"] = sizes
                groups["satellite_mask"] = masks[gids]
                e = np.array(earliest[gids], copy=True)
                e[e == np.iinfo(np.uint64).max] = 0
                groups["earliest_minutes"] = e
                groups["latest_minutes"] = latest[gids]
                groups.tofile(fd)
                group_count += len(gids)
                singletons += int(np.count_nonzero(sizes == 1))
                multi += int(np.count_nonzero(sizes > 1))
                matched_observations += int(sizes[sizes > 1].sum(dtype=np.uint64))
                counted_members += int(sizes.sum(dtype=np.uint64))
            p.update(end - 1, detail=f"groups {group_count:,}")
    p.finish(detail=f"groups {group_count:,}")
    verify_size(group_path, group_count, GROUP_DTYPE)
    if counted_members != total or singletons + multi != group_count:
        raise RuntimeError(f"Conservation check failed: groups sum to {counted_members}, "
                           f"expected {total}; singleton + multi = {singletons+multi}")
    for x in (counts, masks, earliest, latest):
        del x
    return {"group_count": group_count, "singleton_groups": singletons,
            "multi_observation_groups": multi,
            "observations_in_matched_groups": matched_observations}


def build_summary(streams, total, candidates, exact, rejected, group_stats, durations):
    return {
        "project": "Global MODIS-VIIRS Harmonization", "year": YEAR,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "record_bytes": RECORD_DTYPE.itemsize,
        "footprint_bytes": FOOTPRINT_DTYPE.itemsize,
        "footprint_geometry": ("North-aligned rectangle; scan east-west, "
                               "track north-south; dimensions in kilometres."),
        "observation_id_rule": ("Zero-based position within the original yearly "
                                "satellite BIN file."),
        "global_id_rule": ("Sequential IDs beginning at 1 across the available "
                           "satellite streams in SATELLITES order."),
        "time_threshold_minutes": MAX_TIME_DIFFERENCE_MINUTES,
        "time_encoding": ("Unchanged: acq_date*1440 + acq_time. "
                          "Reject acq_time>=1440, exactly as original."),
        "area_calculation": ("Spherical rectangle area using Earth radius "
                             f"{EARTH_RADIUS_M} metres."),
        "boundary_only_intersections_accepted": True,
        "satellite_streams": [{
            "satellite": s["satellite"], "satellite_code": s["code"],
            "observations": s["count"], "valid_footprints": s["valid_footprints"],
            "invalid_footprints": s["invalid_footprints"],
            "source_file": s["path"], "base_global_id": s["base_global_id"],
            "end_global_id": s["end_global_id"]
        } for s in streams],
        "original_observations": total, "candidate_pairs": candidates,
        "exact_intersections": exact, "non_intersecting_candidates": rejected,
        **group_stats,
        "observations_preserved": total,
        "satellite_mask": {
            "1": "MODIS Terra", "2": "MODIS Aqua", "4": "VIIRS SNPP",
            "8": "VIIRS NOAA-20", "16": "VIIRS NOAA-21",
        },
        "outputs": {"edges": "harmonized_edges.bin",
                    "members": "harmonized_members.bin",
                    "groups": "harmonized_groups.bin"},
        "performance": {"spatial_index_dimensions": 3,
                        "numba_acceleration": True,
                        "locally_staged_streams": [s["satellite"] for s in streams
                                                   if s["work_path"] != s["path"]],
                        "phase_seconds": durations},
    }


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fd:
        for block in iter(lambda: fd.read(8 * 1024**2), b""):
            h.update(block)
    return h.hexdigest()


def upload_outputs(streams, summary):
    section("UPLOADING VERIFIED FILES TO GOOGLE DRIVE")
    if os.path.exists(OUTPUT_ROOT) and not FORCE_REPROCESS:
        raise RuntimeError(f"Year already exists at {OUTPUT_ROOT}. Refusing to overwrite.")
    os.makedirs(DRIVE_OUTPUT_ROOT, exist_ok=True)
    staging = OUTPUT_ROOT + ".uploading-" + uuid.uuid4().hex[:10]
    files = []
    for s in streams:
        for key, fname in (("footprint_path", "footprints.bin"),
                           ("id_path", "observation_ids.bin")):
            files.append((s[key], os.path.join(s["satellite"], fname)))
    for fname in ("harmonized_edges.bin", "harmonized_members.bin",
                  "harmonized_groups.bin"):
        files.append((path_in_work(fname), fname))
    total_bytes = sum(os.path.getsize(source) for source, _ in files)
    p = Progress("Drive upload", total_bytes, "bytes")
    copied = 0
    os.makedirs(staging)
    try:
        for src, relative in files:
            dest = os.path.join(staging, relative)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(src, "rb") as fd_src, open(dest, "wb") as fd_dst:
                while True:
                    block = fd_src.read(8 * 1024**2)
                    if not block:
                        break
                    fd_dst.write(block)
                    copied += len(block)
                    p.update(copied, detail=relative)
            if os.path.getsize(src) != os.path.getsize(dest):
                raise RuntimeError(f"Drive size mismatch: {relative}")
            if VERIFY_UPLOAD_SHA256 and file_sha256(src) != file_sha256(dest):
                raise RuntimeError(f"Drive SHA256 mismatch: {relative}")
            print(f"VERIFIED: {relative} ({os.path.getsize(dest) / 2**20:.2f} MiB)")
        p.finish()
        with open(os.path.join(staging, "harmonization_summary.json"), "w") as fd:
            json.dump(summary, fd, indent=2)
        # Never mark COMPLETE until every file and summary has been written.
        with open(os.path.join(staging, "COMPLETE"), "w") as fd:
            fd.write(f"Year {YEAR} completed successfully.\n"
                     f"Completed: {datetime.now(timezone.utc).isoformat()}\n")
        backup = None
        if os.path.exists(OUTPUT_ROOT):
            backup = OUTPUT_ROOT + ".previous-" + uuid.uuid4().hex[:10]
            os.rename(OUTPUT_ROOT, backup)
        try:
            os.rename(staging, OUTPUT_ROOT)
        except Exception:
            if backup and not os.path.exists(OUTPUT_ROOT):
                os.rename(backup, OUTPUT_ROOT)
            raise
        if backup:
            print(f"Previous output saved as backup (delete when verified): {backup}")
        print(f"FINAL OUTPUT: {OUTPUT_ROOT}")
    except Exception:
        print(f"UPLOAD NOT PROMOTED. Partial files (if any): {staging}")
        raise


def main():
    overall_start = time.monotonic()
    section(f"FAST GLOBAL MODIS-VIIRS HARMONIZATION: {YEAR}")
    print(f"Started: {clock_string()}")
    print("Matching policy unchanged: original date/time arithmetic, 720-min window, "
          "rectangle boundary contact allowed.")
    if os.path.exists(OUTPUT_ROOT) and not FORCE_REPROCESS:
        raise RuntimeError(f"Refusing to overwrite existing year: {OUTPUT_ROOT}. "
                           "Set FORCE_REPROCESS=True to replace it after processing.")
    if os.path.exists(WORK_ROOT):
        shutil.rmtree(WORK_ROOT)
    os.makedirs(WORK_ROOT, exist_ok=True)
    durations = {}

    def timed(label, fn, *args):
        start = time.monotonic()
        result = fn(*args)
        durations[label] = round(time.monotonic() - start, 3)
        return result

    streams, total = timed("discover", discover_streams)
    print(f"Processing {total:,} observations from {len(streams)} satellites.")
    timed("local_staging", stage_inputs, streams, total)
    bounds, areas, times, indexable = timed("prepare", prepare_streams, streams, total)
    if len(streams) >= 2 and indexable:
        index_path = timed("build_index", build_spatiotemporal_index,
                           streams, bounds, times, total)
        candidate_path, candidate_count = timed("candidates", build_candidate_pairs,
                                                streams, index_path, bounds, times, total)
    else:
        section("MATCH SEARCH SKIPPED: ONE STREAM OR NO INDEXABLE DETECTIONS")
        candidate_path, candidate_count = empty_candidate_files()
    parent, exact, rejected = timed("edges", harmonize_candidates,
                                    total, candidate_path, candidate_count, bounds, areas)
    parent = timed("compress", compress_groups, parent, total)
    stats = timed("write_outputs", write_outputs, streams, total, parent, times)
    del parent, bounds, areas, times
    summary = build_summary(streams, total, candidate_count, exact, rejected, stats, durations)
    timed("upload", upload_outputs, streams, summary)
    section("YEAR PROCESSING COMPLETE")
    print(f"Year: {YEAR}")
    print(f"Original observations: {total:,}")
    print(f"Candidate pairs: {candidate_count:,}")
    print(f"Exact intersections: {exact:,}")
    print(f"Non-intersecting candidates: {rejected:,}")
    print(f"Groups: {stats['group_count']:,}")
    print(f"Multi-observation groups: {stats['multi_observation_groups']:,}")
    print(f"Singletons: {stats['singleton_groups']:,}")
    print(f"Matched observations: {stats['observations_in_matched_groups']:,}")
    print(f"Elapsed: {duration_string(time.monotonic() - overall_start)}")
    print(f"Finished: {clock_string()}")
    print(f"Output: {OUTPUT_ROOT}")
    print("Phase timings (seconds):", json.dumps(durations, indent=2))
    if REMOVE_LOCAL_WORK_AFTER_SUCCESS:
        shutil.rmtree(WORK_ROOT)
        print("Removed local work files.")
    else:
        print(f"Local work files retained: {WORK_ROOT}")


if __name__ == "__main__":
    main()
