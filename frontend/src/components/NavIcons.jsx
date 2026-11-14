// Navigation icons: outline when idle, filled when the page is active.
const base = { width: 26, height: 26, viewBox: '0 0 24 24', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
const cut = (a) => (a ? 'var(--card)' : 'currentColor');   // lines drawn "into" a filled shape use the bar's background colour

export const IconExplore = ({ active }) => (
  <svg {...base} strokeWidth={active ? 2 : 1.7} fill="none">
    <path d="M9 4 3 6.5v13L9 17l6 3 6-2.5v-13L15 7 9 4Z" fill={active ? 'currentColor' : 'none'} />
    <path d="M9 4v13M15 7v13" stroke={cut(active)} />
  </svg>
);
export const IconCalendar = ({ active }) => (
  <svg {...base} strokeWidth={active ? 2 : 1.7} fill="none">
    <rect x="3.5" y="5" width="17" height="15.5" rx="3" fill={active ? 'currentColor' : 'none'} />
    <path d="M8 3v4M16 3v4" />
    <path d="M3.5 10h17" stroke={cut(active)} />
  </svg>
);
export const IconInsights = ({ active }) => (
  <svg {...base} strokeWidth={active ? 2 : 1.7} fill="none">
    <rect x="4" y="11" width="4" height="9" rx="1" fill={active ? 'currentColor' : 'none'} />
    <rect x="10" y="4" width="4" height="16" rx="1" fill={active ? 'currentColor' : 'none'} />
    <rect x="16" y="8" width="4" height="12" rx="1" fill={active ? 'currentColor' : 'none'} />
  </svg>
);
export const IconSettings = ({ active }) => (
  <svg {...base} strokeWidth={active ? 2 : 1.7} fill="none">
    <path d="M4 7h8M18 7h2M4 17h2M12 17h8" />
    <circle cx="15" cy="7" r="2.6" fill={active ? 'currentColor' : 'none'} />
    <circle cx="9" cy="17" r="2.6" fill={active ? 'currentColor' : 'none'} />
  </svg>
);