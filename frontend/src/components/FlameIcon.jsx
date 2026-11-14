// The fire symbol. Colour = kind of fire (live / expected / past); this is the only colour in the interface.
export const FLAME_PATH = 'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z';
export default function FlameIcon({ color, size = 16, filled = true, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={`inline-block shrink-0 ${className}`}>
      <path d={FLAME_PATH} fill={filled ? color : 'none'} stroke={filled ? 'rgba(255,255,255,.95)' : color} strokeWidth={filled ? 1.1 : 2} strokeLinejoin="round" />
    </svg>
  );
}