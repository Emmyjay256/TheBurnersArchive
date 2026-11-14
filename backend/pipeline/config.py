import os

MAP_KEY = os.environ.get('FIRMS_MAP_KEY', '')   # never hardcode this; export FIRMS_MAP_KEY=...
# Always <backend>/data, wherever you run the scripts from (this file lives in <backend>/pipeline).
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get('FIRE_DATA_DIR') or os.path.normpath(os.path.join(HERE, '..', 'data'))
RAW, OUT = os.path.join(DATA, 'raw'), os.path.join(DATA, 'processed')

# bbox = west, south, east, north. Boxes also cover neighbouring land and ocean; fine for a first harmonization.
REGIONS = {
    'north_america': dict(bbox=(-170, 24, -50, 72), note='USA + Canada box (includes northern Mexico)'),
    'uganda_test': dict(bbox=(29.5, -1.5, 35.1, 4.3), note='Uganda only: a small box for checking the pipeline before the big runs (the app ignores it)'),
    'east_africa': dict(bbox=(12, -14, 42, 23), note='Uganda, Kenya, Tanzania, Rwanda, Burundi, DRC, Sudan box (includes neighbours)'),
    'world': dict(bbox=(-180, -90, 180, 90), note='global'),
}

# Six 30-degree latitude bands. Used when running the "world" region on a small-RAM machine.
BANDS = [
    (-90, -60), (-60, -30), (-30, 0),
    (0,   30), (30,  60), (60,  90),
]

SOURCES = {'MODIS_SP': '2000-11-01', 'VIIRS_SNPP_SP': '2012-01-19'}  # fallback start dates if availability lookup fails
CHUNK_DAYS = 5      # FIRMS area API accepts a day range of 1 to 5
BUDGET = 3000       # transactions we allow per 10 min (limit is 5000; bigger requests can count as several)

MATCH_CELL = 0.02     # sensors "see the same fire" if detections fall in the same 0.02 degree cell (about 2 km) or a neighbour, on the same day
LOC_CELL = 0.1        # a "place" for detection rates and fire-prone tags (about 11 km)
OUT_CELL = 0.5        # published grid for the calendar and map
KAPPA = 20            # how strongly a place's detection rate is pulled toward its region's rate when evidence is thin
A_FLOOR = 0.02        # never trust a detection rate below 2% (stops division blow-ups)
MIN_ACTIVE = 3        # a place counts as "burning" in a year only with at least this many VIIRS fire cell-days
MODIS_CONF_MIN = 30          # drop MODIS "low" confidence (<30); VIIRS keeps nominal+high
MIN_M = 30                   # months with fewer MODIS cell-days are too noisy for a monthly ratio
BOOT = 200                   # bootstrap resamples for uncertainty