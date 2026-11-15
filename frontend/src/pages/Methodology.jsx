import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Check, Copy, Download, ExternalLink, Info } from 'lucide-react';

// The two harmonization scripts live in ./data/code/ next to this page. `?raw` gives us their text (Vite).
import scriptA from './data/code/harmonize_from_bins.py?raw';
import scriptB from './data/code/fast_modis_viirs_harmonization.py?raw';


const DATA_LINKS = [
  { group: 'raw', title: 'Uganda raw detections: MODIS', format: 'CSV, 15 columns', url: https://drive.google.com/drive/folders/1f951lFK2EYqJnVjtFUpKzsl5X88S7mny?usp=sharing'',
    what: 'Terra and Aqua active-fire records for Uganda, exactly as downloaded from NASA FIRMS. Start here if you want to clean and grid the data yourself.' },
  { group: 'raw', title: 'Uganda raw detections: VIIRS', format: 'CSV, 15 columns', url: https://drive.google.com/drive/folders/1Hv3GMRgiE96oonZp5zNmHGty61k_-IQk?usp=sharing'',
    what: 'S-NPP, NOAA-20 and NOAA-21 active-fire records for Uganda, exactly as downloaded from NASA FIRMS.' },
  { group: 'processed', title: 'Uganda cleaned and gridded data', format: 'Parquet', url: '',
    what: 'After our cleaning rules: one row per 0.1 degree cell, month and satellite, with fire count, fire days, summed and maximum FRP, and daytime count.' },
  { group: 'processed', title: 'Uganda district monthly series', format: 'Parquet', url: '',
    what: 'Monthly detections and fire power for every Uganda district and county, kept separate per satellite.' },
  { group: 'harmonised', title: 'Pipeline A output for Uganda', format: 'JSON and binary', url: '',
    what: 'The VIIRS-scale monthly series with its uncertainty band, the map cells with their usual range, and the list of fire-prone places.' },
  { group: 'harmonised', title: 'Pipeline B output for Uganda', format: 'Binary (.bin) and JSON', url: '',
    what: 'Overlap edges, group members and group summaries per year, plus the summary file that describes the run.' },
];


const TOOLS = [
  { name: 'Google Colab', kind: 'Free cloud notebook',
    used: 'The main workhorse. Python with DuckDB summarised the 50 raw CSV files into the grid, processed the data to get tables for graphing and WebP images, and used GeoPandas with pyogrio to tag every cell with its country, district, and county.',
    limits: 'Sessions reset and the disk is temporary, so every step saved its result back to Google Drive and could resume where it stopped. Reading big files through the Drive connection was much slower than a local disk.' },
  { name: 'Kaggle notebooks', kind: 'Free cloud notebook',
    used: 'Also processed data to get tables for graphing and WebP images, serving as extra computing power next to Colab.',
    limits: 'Could not easily access Google Drive by mounting, and download quotas for Drive public links ran out.' },
  { name: 'Google Cloud VM', kind: 'Rented virtual machine',
    used: 'Used $300 credits for testing the datasets.',
    limits: 'Credits were set to expire soon, and even new accounts required a $30 prepayment before unlocking the $300 credits.' },
  { name: 'GitHub Codespaces', kind: 'Browser-based dev environment',
    used: 'Used mainly for deployment and partial processing of data, offering a smoother environment for faster deployment to Firebase Hosting.',
    limits: 'Meant for development. Hours are limited, so the heavy runs happen elsewhere.' },
  { name: 'Azure Web Apps', kind: 'Cloud hosting service',
    used: 'Hosted the Node backend to provide endpoints for the processed data and securely handle AI API keys.',
    limits: 'Dependent on configured cloud environment variables for runtime security.' },
  { name: 'Local machines', kind: 'Our own laptops',
    used: 'Light checks, editing scripts, and building the app.',
    limits: 'Too small for a 45 GB archive. This is the reason the heavy work moved online.' },
];
const LIBS = ['Python', 'DuckDB', 'GeoPandas', 'pyogrio', 'NumPy', 'pandas', 'Numba', 'Rtree', 'Parquet', 'GADM 4.1', 'NASA FIRMS'];

/* ---------- small building blocks (same look as the other pages) ---------- */
const Stat = ({ label, value, note }) => (
  <div className="card rounded-2xl p-4"><p className="muted text-xs">{label}</p><p className="mt-2 text-2xl font-bold">{value}</p>{note && <p className="muted mt-1 text-xs">{note}</p>}</div>
);
const Card = ({ title, why, children }) => (
  <section className="card rounded-3xl p-5"><h2 className="font-semibold">{title}</h2>{why && <p className="muted mb-4 mt-1 text-sm">{why}</p>}{children}</section>
);
const Caution = ({ children }) => (
  <p className="card flex gap-3 rounded-2xl p-4 text-sm" role="note"><Info size={18} className="mt-0.5 shrink-0" /><span>{children}</span></p>
);
const Steps = ({ items }) => (
  <ol className="space-y-2 text-sm">
    {items.map(([t, d], i) => (
      <li key={t} className="card2 flex gap-3 rounded-2xl p-3">
        <span className="btn grid h-8 w-8 shrink-0 place-items-center rounded-xl text-xs">{i + 1}</span>
        <span><b>{t}</b><span className="muted mt-0.5 block">{d}</span></span>
      </li>
    ))}
  </ol>
);
const Chips = ({ items }) => (
  <div className="flex flex-wrap gap-2">{items.map((x) => <span key={x} className="card2 rounded-full px-3 py-1 text-xs">{x}</span>)}</div>
);

const download = (name, text) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
};

function CodeFile({ name, blurb, text }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* clipboard blocked: use Download */ }
  };
  return (
    <section className="card rounded-3xl p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-all font-semibold">{name}</h2>
          <p className="muted mt-1 text-sm">{blurb}</p>
          <p className="muted mt-1 text-xs">{text.split('\n').length.toLocaleString()} lines · {Math.round(text.length / 1024)} KB</p>
        </div>
        <div className="flex gap-2">
          <button onClick={copy} className="ghost inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm">{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'Copied' : 'Copy'}</button>
          <button onClick={() => download(name, text)} className="btn inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm"><Download size={15} />Download</button>
        </div>
      </div>
      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-semibold">View the code</summary>
        <pre className="card2 mt-3 max-h-[28rem] overflow-auto whitespace-pre rounded-2xl p-4 text-xs leading-relaxed"><code>{text}</code></pre>
      </details>
    </section>
  );
}

/* ---------- content ---------- */
const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'tools', label: 'Tools' },
  { id: 'harmonization', label: 'Harmonization' },
  { id: 'code', label: 'Code' },
  { id: 'data', label: 'Data and reproduce' },
];

const PIPELINE = [
  ['Download', 'Downloaded all data for the five satellites (Terra, Aqua, S-NPP, NOAA-20, and NOAA-21) from FIRMS global data in CSV format in batches of one year each.'],
  ['Extract and harmonize', 'Extracted the fire detection records and harmonized the multi-satellite data onto a unified scale to account for sensor differences.'],
  ['Raw analysis', 'Conducted raw analysis directly on the CSVs across different tasks to generate graphing tables, summaries, and WebP visual map assets.'],
];

const COMPARE = [
  ['Question it answers', 'What would a single, consistent monthly line look like from 2000 to today?', 'Which detections from different satellites are probably the same fire event?'],
  ['Core idea', 'Treat VIIRS as the truth and rebuild the MODIS-only years on VIIRS scale.', 'Draw a box for every detection and link boxes from different satellites that overlap within 12 hours.'],
  ['Input', 'Pre-streamed binary files, 13 bytes per detection (cell, day, satellite).', 'Yearly binary files per satellite, 37 bytes per detection, including scan and track size.'],
  ['Output', 'Monthly series with an uncertainty band, map cells, fire-prone places.', 'Edges, group members and group summaries, per year.'],
  ['Strength', 'One continuous line, validated by hiding years and rebuilding them.', 'Keeps every observation and measures real overlap exactly.'],
  ['Weak spot', 'Assumes the same places burned before 2012 as after.', 'Chains of touching boxes can merge separate events, and it does not itself produce a monthly trend.'],
  ['Cost', 'One run over the whole record.', 'Heavy. Runs one year at a time with large temporary files.'],
];

const STEPS_A = [
  ['Read the binary files', 'Each detection is 13 bytes: cell row, cell column, day number and satellite code. No CSV is read again.'],
  ['Find the overlap', 'From when VIIRS starts until the end of Aqua, both see the same world. Place by place, we measure how often MODIS sees the fires VIIRS sees.'],
  ['Set the scale', 'For each calendar month, the ratio of VIIRS to MODIS detections, with a bootstrap band for the uncertainty.'],
  ['Extend Terra to Aqua', 'A monthly factor scales Terra to Aqua, so the first years (before Aqua) sit on the same MODIS scale.'],
  ['Fill the gaps', 'Places where VIIRS sees fire year after year but MODIS sees nothing are MODIS-blind. We estimate their earlier activity with a rule: burning in 2 years in a row, in 2, 3 or 4 different years, 2 years including an early one, or no filling.'],
  ['Pick the rule by backtest', 'We hide the first VIIRS years, rebuild them from MODIS, and compare. The rule with the lowest typical error and a bias within 15% wins.'],
  ['Write the results', 'A monthly series with a 95% band, map cells with their usual range, a list of fire-prone places, and a compact monthly grid for the map.'],
];

const STEPS_B = [
  ['Load one year', 'One binary file per satellite, 37 bytes per detection: position, brightness, scan, track, date, time, confidence, T31, FRP, day or night, and type.'],
  ['Draw a footprint', 'A north-aligned rectangle for each detection, sized from its scan (east to west) and track (north to south) in kilometres. Invalid ones are skipped.'],
  ['Index in 3D', 'A disk-backed R-tree on longitude, latitude and time, so searches are fast.'],
  ['Find candidates', 'For each detection, find detections from other satellites whose box overlaps and that fall within 720 minutes (12 hours).'],
  ['Test exactly', 'Compute the overlap area on a sphere. Boxes that only touch still count. Store intersection, union, IoU and overlap of the smaller box.'],
  ['Group', 'Union-find joins connected detections into groups. The group id is the lowest observation id inside it. Every observation is kept.'],
  ['Write and verify', 'Edges, members, groups and a summary file are checked for size, copied to Drive, and only then marked COMPLETE. An existing year is never overwritten.'],
];

const CHECKPOINTS = [
  ['Cleaning rules', 'Type 0 only. MODIS confidence 30 or more. VIIRS confidence n or h.'],
  ['Grid', 'Cell = 0.1 degrees. lat_i = floor(latitude x 10) and lon_i = floor(longitude x 10).'],
  ['Uganda total', '2,320,818 kept detections, summed over all five satellites and all 58 districts, November 2000 to November 2025. The country-level total can be slightly higher because a few detections fall in cells with no district.'],
  ['Uganda season', 'About 80% of detections fall from December to February, peaking in January (Aqua, 2003 to 2024, using a rough box and not the country border).'],
  ['Northern Uganda test circle', 'A 100 km circle centred at 2.0 N, 32.0 E shows a decline of about two thirds from 2016 to 2024 in both MODIS and VIIRS, and 2025 is higher than 2024.'],
];

const COMPARE_STEPS = [
  ['Download the raw Uganda files', 'Use the raw links above.'],
  ['Apply the same cleaning and grid', 'Use the rules and the 0.1 degree cell from the checkpoints.'],
  ['Compare per satellite first', 'Check monthly totals for each satellite before any harmonizing. This separates differences in cleaning and gridding from differences in the harmonization.'],
  ['Run your own harmonization', 'Use your own algorithm, or run Pipeline A or B on the same inputs.'],
  ['Compare the series', 'Look at the correlation, the total bias in percent, and the month-by-month gap. For the years before 2012, also check how much of your line is estimated.'],
  ['Tell us what differs', 'Where our numbers and yours disagree is exactly where the methods make different assumptions.'],
];

/* ---------- page ---------- */
export default function Methodology() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t.id === params.get('tab')) || TABS[0];
  const go = (id) => setParams({ tab: id }, { replace: true });

  const linkCard = (l) => (
    <div key={l.title} className="card2 flex flex-col justify-between gap-3 rounded-2xl p-4">
      <div>
        <p className="font-semibold">{l.title}</p>
        <p className="muted mt-1 text-sm">{l.what}</p>
        <p className="muted mt-2 text-xs">Format: {l.format}</p>
      </div>
      {l.url
        ? <a href={l.url} target="_blank" rel="noreferrer" className="btn inline-flex w-fit items-center gap-2 rounded-full px-4 py-2 text-sm"><ExternalLink size={15} />Open in Google Drive</a>
        : <span className="muted text-xs">Link coming soon</span>}
    </div>
  );
  const group = (id, title, why) => (
    <Card title={title} why={why}>
      <div className="grid gap-3 md:grid-cols-2">{DATA_LINKS.filter((l) => l.group === id).map(linkCard)}</div>
    </Card>
  );

  const content = {
    overview: (<>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Satellites" value="5" note="Terra, Aqua, S-NPP, NOAA-20, NOAA-21" />
        <Stat label="Raw detections" value="602M" note="601,802,067 across 50 files" />
        <Stat label="Kept after cleaning" value="502M" note="502,148,228 vegetation fires" />
        <Stat label="Raw archive" value="~45 GB" note="too big to query on demand" />
      </div>
      <Card title="The problem" why="The satellite archive is about 45 GB, far too big to search every time someone opens the app. We did not have powerful machines, so we summarised it once, online, into a compact grid that answers a question in a fraction of a second.">
        <Caution>Every number in the app is a count of satellite detections, not a measure of burned area. Detections depend on each sensor&apos;s sensitivity and overpass time.</Caution>
      </Card>
      <Card title="From raw files to this app" why="Six stages, in the order we did them.">
        <Steps items={PIPELINE} />
      </Card>
      <div className="grid gap-3 md:grid-cols-2">
        <button onClick={() => go('tools')} className="card2 rounded-2xl p-4 text-left"><p className="font-semibold">Tools</p><p className="muted mt-1 text-sm">The online platforms we used, and why.</p></button>
        <button onClick={() => go('harmonization')} className="card2 rounded-2xl p-4 text-left"><p className="font-semibold">Harmonization</p><p className="muted mt-1 text-sm">Two ways of putting MODIS and VIIRS on one scale.</p></button>
        <button onClick={() => go('code')} className="card2 rounded-2xl p-4 text-left"><p className="font-semibold">Code</p><p className="muted mt-1 text-sm">Read, copy or download both scripts.</p></button>
        <button onClick={() => go('data')} className="card2 rounded-2xl p-4 text-left"><p className="font-semibold">Data and reproduce</p><p className="muted mt-1 text-sm">Uganda files to download, and checkpoints to compare against.</p></button>
      </div>
    </>),

    tools: (<>
      <Card title="Why we worked online" why="Our own machines could not hold or process a 45 GB archive. So the heavy steps ran on free and rented online machines, one file at a time. Each step saved its output back to Google Drive, so the work survived session resets and could resume where it stopped.">
        <Chips items={LIBS} />
      </Card>
      <div className="grid gap-3 md:grid-cols-2">
        {TOOLS.map((t) => (
          <section key={t.name} className="card rounded-3xl p-5">
            <h2 className="font-semibold">{t.name}</h2>
            <p className="muted text-xs">{t.kind}</p>
            <p className="mt-3 text-sm"><span className="muted">What we used it for: </span>{t.used}</p>
            <p className="mt-2 text-sm"><span className="muted">Limits we hit: </span>{t.limits}</p>
          </section>
        ))}
      </div>
      <Card title="Lessons for anyone repeating this">
        <ul className="muted list-disc space-y-1.5 pl-5 text-sm">
          <li>Read each file once, summarise it, and delete it. Keep only the small summary.</li>
          <li>Save results to a place that outlives the session, and make every step resumable.</li>
          <li>Copy the final files to the machine&apos;s own disk before querying. Reading through a Drive connection was much slower.</li>
          <li>Google Drive can block downloads with a quota limit. This stopped our file audit pass, so plan around it.</li>
          <li>Measure what the cleaning rules remove. We counted the total, but a per-rule audit is still open.</li>
        </ul>
      </Card>
    </>),

    harmonization: (<>
      <Card title="Why harmonize at all" why="MODIS and VIIRS count fires differently. VIIRS has finer pixels, so it reports far more detections: S-NPP has roughly 6 times Aqua's yearly count. If you simply join them, the record jumps when VIIRS arrives in 2012, and that looks like more fire when it is only a better instrument. Harmonizing removes that false jump.">
        <p className="muted text-sm">We built two pipelines because they answer different questions. They are independent, so where they agree we can trust the result more.</p>
      </Card>
      <div className="grid gap-6 md:grid-cols-2">
        <Card title="Pipeline A: one satellite gets priority" why="VIIRS is treated as the truth. Earlier years are rebuilt from MODIS and put on VIIRS scale. File: harmonize_from_bins.py"><Steps items={STEPS_A} /></Card>
        <Card title="Pipeline B: footprint matching" why="A more analytical route that finds the detections that different satellites share. File: fast_modis_viirs_harmonization.py"><Steps items={STEPS_B} /></Card>
      </div>
      <Card title="Side by side">
        <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-sm">
          <thead><tr className="muted text-left text-xs"><th className="py-1.5 pr-3" /><th className="pr-3">Pipeline A: priority satellite</th><th>Pipeline B: footprint matching</th></tr></thead>
          <tbody>{COMPARE.map(([k, a, b]) => (
            <tr key={k} className="bd border-t align-top"><td className="muted py-2 pr-3 text-xs">{k}</td><td className="py-2 pr-3">{a}</td><td className="py-2">{b}</td></tr>
          ))}</tbody>
        </table></div>
      </Card>
      <Caution>Which to use: choose Pipeline A for a trend line on one scale, such as the main Insights chart. Choose Pipeline B to count how many separate fire events there were, or to see how much two satellites really overlap. The two can also be combined: B finds the shared detections, and A sets the scale.</Caution>
    </>),

    code: (<>
      <Card title="Both scripts, open for anyone" why="Read them here, copy them, or download them. Run them on your own machine or on an online notebook, and compare with our results in the Data tab." />
      <CodeFile name="harmonize_from_bins.py" text={scriptA}
        blurb="Pipeline A. Reads pre-streamed binary files and rebuilds the MODIS years on VIIRS scale, with a backtest and uncertainty band." />
      <CodeFile name="fast_modis_viirs_harmonization.py" text={scriptB}
        blurb="Pipeline B. Builds footprints, finds overlapping detections across satellites, and groups them with union-find. Built for Colab." />
      <div className="grid gap-6 md:grid-cols-2">
        <Card title="Run Pipeline A">
          <p className="muted mb-2 text-sm">Needs Python with NumPy and pandas, plus a config.py next to the script. The config holds the cell sizes, thresholds, output folder and region boxes.</p>
          <pre className="card2 overflow-auto whitespace-pre rounded-2xl p-3 text-xs">{`python harmonize_from_bins.py world \\
  --modis  data/modis.bin \\
  --viirs  data/viirs.bin`}</pre>
          <p className="muted mt-3 text-xs">Binary record, 13 bytes: cell row (int32), cell column (int32), day number since 2000-01-01 (int32), satellite code (uint8: 0 Aqua, 1 Terra, 2 VIIRS).</p>
        </Card>
        <Card title="Run Pipeline B">
          <p className="muted mb-2 text-sm">In Colab, install two packages, set the year and folders at the top of the script, then run it. One year per run.</p>
          <pre className="card2 overflow-auto whitespace-pre rounded-2xl p-3 text-xs">{`!pip -q install rtree numba
%run fast_modis_viirs_harmonization.py

# input files expected at SOURCE_ROOT:
#   MODIS/MODIS_Terra_2015.bin
#   MODIS/MODIS_Aqua_2015.bin
#   VIIRS_SNPP/VIIRS_SNPP_2015.bin
#   VIIRS_NOAA20/VIIRS_NOAA20_2018.bin ...`}</pre>
          <p className="muted mt-3 text-xs">Binary record, 37 bytes: latitude, longitude, brightness, scan, track (float32), date (uint32), time (uint16), confidence (uint8), bright_t31, frp (float32), daynight and type (uint8).</p>
        </Card>
      </div>
    </>),

    data: (<>
      <Card title="Try it yourself" why="We share raw Uganda files, our processed files and our harmonized results. Process the raw files with your own algorithm, then check whether your numbers match ours. Where they differ is where the methods make different choices." />
      {group('raw', '1. Raw files for Uganda', 'The starting point, as NASA FIRMS delivers it.')}
      {group('processed', '2. Processed files', 'After cleaning, gridding and tagging with districts.')}
      {group('harmonised', '3. Harmonized files', 'The outputs of our two pipelines.')}
      <Card title="Reference checkpoints for Uganda" why="Numbers from our own run, so you can tell early whether your cleaning and gridding agree with ours.">
        <dl className="space-y-2 text-sm">
          {CHECKPOINTS.map(([k, v]) => (
            <div key={k} className="card2 rounded-2xl p-3"><dt className="muted text-xs">{k}</dt><dd className="mt-0.5">{v}</dd></div>
          ))}
        </dl>
      </Card>
      <Card title="How to compare your result with ours"><Steps items={COMPARE_STEPS} /></Card>
      <Caution>Border cells count wholly toward the region containing their centre, so district and county totals are approximate near borders. Small regions with only a few cells give rough numbers. Please keep this in mind when comparing.</Caution>
    </>),
  };

  return (
    <div className="absolute inset-0 z-10">
      <div className="page absolute inset-0 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-8">
          <header className="card rounded-3xl p-5 md:p-7">
            <button onClick={() => navigate('/insights/advanced')} className="ghost mb-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs"><ArrowLeft size={14} />Advanced insights</button>
            <h1 className="text-2xl font-bold tracking-tight md:text-3xl">How we did it</h1>
            <p className="muted mt-1 max-w-2xl text-sm">From a 45 GB archive of satellite files to the charts in this app: the tools we used, the two ways we merged MODIS and VIIRS, the code, and the data, so you can repeat the work and compare.</p>
          </header>

          <nav className="glass sticky top-2 z-10 flex gap-1 overflow-x-auto rounded-full p-1" role="tablist" aria-label="Methodology sections">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab.id === t.id} onClick={() => go(t.id)} className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold ${tab.id === t.id ? 'on' : 'muted'}`}>{t.label}</button>
            ))}
          </nav>

          {content[tab.id]}
        </div>
      </div>
    </div>
  );
}
