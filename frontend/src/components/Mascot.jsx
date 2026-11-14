import { useId } from 'react';
import { useSettings } from '../SettingsContext';

// Spark, the guide: an original fire character with a round flame head, flame skin,
// a tight cropped black top, tight black pants.
// mood: 'dance' (default) | 'wave' | 'point' | 'cheer' | 'lounge' | 'sit' | 'worried' | 'run' | 'think'
// aim: angle in degrees the pointing arm should aim at (0 = right, 90 = down). Only used by 'point'.
// Unknown moods fall back to 'dance'.
// dance / wave / point / cheer use your existing CSS classes (spark-dance, spark-leg, spark-wave, spark-cheer...).
// lounge / sit / worried / run / think animate themselves inside the SVG, so they need no extra CSS.
// Shows nothing when "Show Spark" is off in Settings, so it can be dropped in anywhere.

const MOODS = ['dance', 'wave', 'point', 'cheer', 'lounge', 'sit', 'worried', 'run', 'think'];

const BROWS = {
  smile:   ['M44 55 Q51 52 58 54.5', 'M62 54.5 Q69 52 76 55'],
  happy:   ['M44 54 Q51 50 58 54', 'M62 54 Q69 50 76 54'],
  worried: ['M44 58 Q51 56 58 50', 'M62 50 Q69 56 76 58'],
  think:   ['M44 55 Q51 52 58 55', 'M62 50 Q69 45 76 51'],
  run:     ['M44 52 Q51 52 58 56', 'M62 56 Q69 52 76 52'],
};
// where the pupils look (kept small so they stay inside the eye)
const LOOK = { smile: [0, 0], happy: [0, 0], worried: [-0.8, -1.2], think: [1.4, -1.2], run: [1.4, 0] };

export default function Mascot({ size = 96, mood = 'dance', aim = null, className = '' }) {
  const { s } = useSettings();
  const id = useId().replace(/:/g, '');
  if (!s.mascot) return null;

  const m = MOODS.includes(mood) ? mood : 'dance';
  const isLounge = m === 'lounge';
  const isSit = m === 'sit';
  const isWorried = m === 'worried';
  const isRun = m === 'run';
  const isThink = m === 'think';
  const classic = m === 'dance' || m === 'wave' || m === 'point' || m === 'cheer';

  const pointing = m === 'point' && aim != null;
  const flip = pointing && Math.cos((aim * Math.PI) / 180) < 0;      // aiming left: mirror her instead of bending the arm through her body
  const angle = pointing ? (flip ? 180 - aim : aim) : 62;
  const armClass = m === 'wave' ? 'spark-wave' : m === 'cheer' ? 'spark-cheer-arm' : '';
  const bodyClass = classic ? (m === 'cheer' ? 'spark-cheer' : 'spark-dance') : `spark-${m}`;

  const face = (m === 'cheer' || m === 'wave' || isLounge) ? 'happy'
    : isWorried ? 'worried' : isThink ? 'think' : isRun ? 'run' : 'smile';
  const [browL, browR] = BROWS[face];
  const [lx, ly] = LOOK[face];
  const u = (n) => `url(#${id}${n})`;

  // ---- pose placement ----
  const bodyT = isSit ? 'translate(0 16)' : isRun ? 'rotate(10 60 116)' : undefined;       // everything
  const torsoT = isLounge ? 'translate(10 0) rotate(-80 60 118)' : undefined;               // legs + torso only
  const headT = isLounge ? 'translate(-24 20) rotate(-14 60 88)'
    : isRun ? 'rotate(-14 60 88)'
    : isWorried ? 'rotate(-5 60 88)'
    : isThink ? 'rotate(7 60 88)' : undefined;
  const idle = isSit ? { values: '0 0;0 -1.2;0 0', dur: '3.4s' }
    : isWorried ? { values: '-0.6 0;0.6 0;-0.6 0', dur: '0.2s' }
    : isRun ? { values: '0 0;0 -3.5;0 0', dur: '0.28s' } : null;

  // ---- shared pieces ----
  const sleeveL = <ellipse cx="46" cy="96" rx="4.6" ry="5.4" fill={u('black')} />;
  const sleeveR = <ellipse cx="74" cy="96" rx="4.6" ry="5.4" fill={u('black')} />;
  const hand = (cx, cy, r = 4.2) => <circle cx={cx} cy={cy} r={r} fill="#ffd34a" />;
  const limbStroke = { stroke: u('limb'), strokeWidth: 5.2, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' };

  const mouth = (face === 'happy' || face === 'run')
    ? <><path d="M54 77 Q60 86 66 77Z" fill="#7a1d10" /><path d="M56.5 82 Q60 84.5 63.5 82 Q60 80.5 56.5 82Z" fill="#ff6b5a" /></>
    : face === 'worried'
      ? <path d="M53.5 81 Q56.8 77.5 60 81 T66.5 81" stroke="#8a2412" strokeWidth="2" strokeLinecap="round" fill="none" />
      : face === 'think'
        ? <path d="M55 80 Q61 79 66 76" stroke="#8a2412" strokeWidth="2" strokeLinecap="round" fill="none" />
        : <path d="M54.5 78 Q60 83 65.5 78" stroke="#8a2412" strokeWidth="2" strokeLinecap="round" fill="none" />;

  const head = (
    <>
      {/* flame head: round base with rising tongues (outer orange flame, inner yellow flame) */}
      <g filter={u('fire')}>
        <path fill={u('flameOuter')}
          d="M60 88 C44 88 31 75 31 59 C31 50 34 42 38 36 C40 42 42 50 46 50 C51 50 49 40 48 30 C47 18 50 10 55 5 C55 14 58 20 62 20 C67 20 68 10 66 -6 C74 2 80 14 80 28 C80 36 78 42 80 48 C83 46 85 40 84 34 C88 42 89 50 89 59 C89 75 76 88 60 88Z" />
        <path fill={u('flameInner')}
          d="M60 86 C47 86 38 77 38 65 C38 57 42 52 47 48 C46 55 50 59 54 57 C59 55 57 47 55 42 C66 47 72 55 74 63 C75 57 74 55 76 53 C80 59 82 63 82 67 C82 78 72 86 60 86Z">
          <animateTransform attributeName="transform" type="translate" values="0 0;0 -1.2;0 0" dur="2.2s" repeatCount="indefinite" />
        </path>
      </g>

      {/* soft light rising inside the inner flame */}
      <g filter={u('soft')} opacity=".6">
        <path d="M48 78 C44 70 50 66 48 58 C54 64 56 72 52 80Z" fill="#fff6c8">
          <animateTransform attributeName="transform" type="translate" values="0 4;0 -6;0 4" dur="2.8s" repeatCount="indefinite" />
          <animate attributeName="opacity" values=".2;.8;.2" dur="2.8s" repeatCount="indefinite" />
        </path>
        <path d="M72 78 C76 70 70 66 72 58 C66 64 64 72 68 80Z" fill="#fff6c8">
          <animateTransform attributeName="transform" type="translate" values="0 -4;0 6;0 -4" dur="3.4s" repeatCount="indefinite" />
          <animate attributeName="opacity" values=".8;.2;.8" dur="3.4s" repeatCount="indefinite" />
        </path>
      </g>

      {/* cheek warmth */}
      <ellipse cx="45" cy="72" rx="5" ry="3.2" fill="#ff7a3c" opacity=".35" filter={u('soft')} />
      <ellipse cx="75" cy="72" rx="5" ry="3.2" fill="#ff7a3c" opacity=".35" filter={u('soft')} />

      {/* eyes: glowing sclera, amber iris (looks around per mood), lashes */}
      <g className="spark-eyes">
        <ellipse cx="51" cy="65" rx="5.4" ry="6.2" fill="#fff6e0" />
        <ellipse cx="69" cy="65" rx="5.4" ry="6.2" fill="#fff6e0" />
        <g transform={`translate(${lx} ${ly})`}>
          <circle cx="51.6" cy="66" r="4" fill={u('iris')} />
          <circle cx="68.4" cy="66" r="4" fill={u('iris')} />
          <circle cx="51.6" cy="66.2" r="1.8" fill="#2a0c04" />
          <circle cx="68.4" cy="66.2" r="1.8" fill="#2a0c04" />
          <circle cx="53" cy="64.2" r="1.3" fill="#fff" />
          <circle cx="69.8" cy="64.2" r="1.3" fill="#fff" />
        </g>
        <path d="M45 63 C47 58 55 58 57 63" stroke="#4a1608" strokeWidth="1.8" strokeLinecap="round" fill="none" />
        <path d="M63 63 C65 58 73 58 75 63" stroke="#4a1608" strokeWidth="1.8" strokeLinecap="round" fill="none" />
        <path d="M45 62 L42.5 60.5 M75 62 L77.5 60.5" stroke="#4a1608" strokeWidth="1.3" strokeLinecap="round" />
      </g>
      <path d={browL} stroke="#a3280f" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <path d={browR} stroke="#a3280f" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      {/* nose hint */}
      <path d="M59 72 Q60.5 74 62 72" stroke="#c4501a" strokeWidth="1.2" strokeLinecap="round" fill="none" opacity=".7" />
      {mouth}
    </>
  );

  // ---- legs ----
  const legCls = (side) => (classic ? `spark-leg ${side}` : undefined);
  const standLegs = (
    <>
      <g className={legCls('l')}>
        <path d="M53 116 L51 142" stroke={u('black')} strokeWidth="9" strokeLinecap="round" />
        <path d="M52 124 L51 140" stroke="#ffffff" strokeOpacity=".08" strokeWidth="1.2" strokeLinecap="round" />
        <path d="M43 148 C43 144 50 143 55 145 C57 148 55 150 52 150 L44 150Z" fill="#0b090e" />
        <path d="M44 149.5 L53 149.5" stroke="#ff9a2e" strokeOpacity=".6" strokeWidth="1" strokeLinecap="round" />
      </g>
      <g className={legCls('r')}>
        <path d="M67 116 L69 142" stroke={u('black')} strokeWidth="9" strokeLinecap="round" />
        <path d="M68 124 L69 140" stroke="#ffffff" strokeOpacity=".08" strokeWidth="1.2" strokeLinecap="round" />
        <path d="M77 148 C77 144 70 143 65 145 C63 148 65 150 68 150 L76 150Z" fill="#0b090e" />
        <path d="M76 149.5 L67 149.5" stroke="#ff9a2e" strokeOpacity=".6" strokeWidth="1" strokeLinecap="round" />
      </g>
    </>
  );

  // sitting cross-legged
  const sitLegs = (
    <>
      <path d="M53 116 L33 128 L57 132" stroke={u('black')} strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <ellipse cx="57" cy="132" rx="6.5" ry="3.8" fill="#0b090e" />
      <path d="M67 116 L87 128 L63 132" stroke={u('black')} strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <ellipse cx="63" cy="132" rx="6.5" ry="3.8" fill="#0b090e" />
    </>
  );

  // running: thigh swings at the hip, shin folds at the knee, the two legs are half a cycle apart
  const runLeg = (hx, delay) => (
    <g>
      <animateTransform attributeName="transform" type="rotate"
        values={[30, 0, -35, 0, 30].map((a) => `${a} ${hx} 116`).join(';')} dur=".56s" begin={delay} repeatCount="indefinite" />
      <path d={`M${hx} 116 L${hx} 130`} stroke={u('black')} strokeWidth="9" strokeLinecap="round" />
      <g>
        <animateTransform attributeName="transform" type="rotate"
          values={[15, 70, 15, 25, 15].map((a) => `${a} ${hx} 130`).join(';')} dur=".56s" begin={delay} repeatCount="indefinite" />
        <path d={`M${hx} 130 L${hx} 143`} stroke={u('black')} strokeWidth="9" strokeLinecap="round" />
        <ellipse cx={hx + 4} cy="147" rx="7" ry="3.8" fill="#0b090e" />
      </g>
    </g>
  );
  const runLegs = <>{runLeg(54, '-0.28s')}{runLeg(66, '0s')}</>;

  const legs = isSit ? sitLegs : isRun ? runLegs : standLegs;

  // ---- torso (midriff, pants, cropped top, neck) ----
  const torso = (
    <>
      <g filter={u('skin')}>
        <path d="M49 100 L71 100 L70 116 L50 116Z" fill={u('limb')} />
      </g>
      <path d="M48 112 C54 114 66 114 72 112 L74 124 C66 127 54 127 46 124Z" fill={u('black')} />
      <path d="M48 112.5 C54 114.5 66 114.5 72 112.5" stroke="#ff9a2e" strokeOpacity=".5" strokeWidth="1" fill="none" />
      <path d="M47 92 C52 89 68 89 73 92 L74 106 C66 109 54 109 46 106Z" fill={u('black')} />
      {sleeveL}
      <path d="M53 90 C56 95 64 95 67 90" stroke="#ff9a2e" strokeOpacity=".5" strokeWidth="1" fill="none" />
      <path d="M52 98 C56 103 64 103 68 98" stroke="#ffffff" strokeOpacity=".07" strokeWidth="1.2" fill="none" />
      <path d="M47 106 C54 109 66 109 73 106" stroke="#ff9a2e" strokeOpacity=".45" strokeWidth="1" fill="none" />
      <path d="M55 82 L55 92 L65 92 L65 82Z" fill="#ff9626" filter={u('skin')} />
    </>
  );

  // ---- arms, per pose ----
  const runArm = (dx, delay) => (
    <g>
      <animateTransform attributeName="transform" type="rotate"
        values={[-42, 38, -42].map((a) => `${a} ${73 + dx} 97`).join(';')} dur=".56s" begin={delay} repeatCount="indefinite" />
      <path d={`M${73 + dx} 97 L${80 + dx} 108 L${92 + dx} 100`} {...limbStroke} strokeWidth="5" />
      {hand(93 + dx, 99, 4)}
    </g>
  );

  let armsBack = null;   // drawn before the torso
  let armsMid = null;    // drawn after the torso, before the head
  let armsFront = null;  // drawn on top of the head

  if (classic) {
    armsBack = (
      <g filter={u('skin')}>
        <path d="M47 96 Q36 102 33 115" {...limbStroke} />
        {hand(33, 116, 4)}
      </g>
    );
    armsFront = (
      <>
        <g className={armClass} style={{ transformOrigin: '73px 96px', transform: armClass ? undefined : `rotate(${angle}deg)`, transition: 'transform .45s ease' }}>
          <g filter={u('skin')}>
            <path d="M73 96 L96 96" {...limbStroke} />
            {hand(98, 96, 4.4)}
            {pointing && <path d="M101 96 L109 96" stroke="#ffd34a" strokeWidth="3.2" strokeLinecap="round" />}
          </g>
        </g>
        {sleeveR}
      </>
    );
  } else if (isWorried) {
    armsFront = (
      <>
        <g filter={u('skin')}>
          <path d="M47 97 L37 108 L56 106" {...limbStroke} strokeWidth="5" />
          <path d="M73 97 L83 108 L64 106" {...limbStroke} strokeWidth="5" />
          {hand(57, 106, 4)}{hand(63, 106, 4)}
        </g>
        {sleeveL}{sleeveR}
      </>
    );
  } else if (isThink) {
    armsFront = (
      <>
        <g filter={u('skin')}>
          <path d="M73 97 L86 105 L73 90" {...limbStroke} />
          {hand(72.5, 88.5, 4.2)}
          <path d="M47 97 L36 106 L46 114" {...limbStroke} />
          {hand(47, 115, 4)}
        </g>
        {sleeveL}{sleeveR}
      </>
    );
  } else if (isSit) {
    armsFront = (
      <>
        <g filter={u('skin')}>
          <path d="M47 97 Q38 109 36 122" {...limbStroke} />
          {hand(36, 124, 4)}
          <path d="M73 97 Q82 109 84 122" {...limbStroke} />
          {hand(84, 124, 4)}
        </g>
        {sleeveL}{sleeveR}
      </>
    );
  } else if (isRun) {
    armsBack = runArm(-26, '-0.28s');
    armsFront = <>{runArm(0, '0s')}{sleeveR}</>;
  } else if (isLounge) {
    // waving arm: upper arm lies along her side, forearm waves from the elbow
    armsMid = (
      <>
        <g filter={u('skin')}>
          <path d="M51 101 L67 95" {...limbStroke} />
          <g>
            <animateTransform attributeName="transform" type="rotate"
              values="-18 67 95;18 67 95;-18 67 95" keyTimes="0;.5;1" calcMode="spline"
              keySplines=".45 0 .55 1;.45 0 .55 1" dur="1s" repeatCount="indefinite" />
            <path d="M67 95 L73 72" {...limbStroke} />
            {hand(74, 69, 4.4)}
          </g>
        </g>
        <g transform={torsoT}>{sleeveR}</g>
      </>
    );
    // propping arm: elbow on the ground, hand under her chin
    armsFront = (
      <>
        <g filter={u('skin')}>
          <path d="M46 127 L30 135 L25 108" {...limbStroke} />
          {hand(25, 106, 4.4)}
        </g>
        <g transform={torsoT}>{sleeveL}</g>
      </>
    );
  }

  // ---- ground shadow ----
  const ground = isLounge ? (
    <>
      <ellipse cx="58" cy="139" rx="60" ry="5" fill="rgba(0,0,0,.22)" />
      <ellipse cx="58" cy="138" rx="64" ry="8" fill={u('glow')} />
    </>
  ) : isSit ? (
    <>
      <ellipse cx="60" cy="152" rx="36" ry="4" fill="rgba(0,0,0,.2)" />
      <ellipse cx="60" cy="151" rx="42" ry="6" fill={u('glow')} />
    </>
  ) : isRun ? (
    <>
      <ellipse cx="60" cy="152" rx="22" ry="3" fill="rgba(0,0,0,.2)">
        <animate attributeName="rx" values="22;17;22" dur=".28s" repeatCount="indefinite" />
      </ellipse>
      <ellipse cx="60" cy="151" rx="30" ry="5" fill={u('glow')} />
    </>
  ) : (
    <>
      <ellipse cx="60" cy="152" rx="24" ry="3.4" fill="rgba(0,0,0,.2)" />
      <ellipse cx="60" cy="151" rx="30" ry="5" fill={u('glow')} />
    </>
  );

  return (
    <div className={`spark ${className}`} style={{ width: size, height: size * 1.3, transform: flip ? 'scaleX(-1)' : undefined }} role="img" aria-label="Spark, the guide">
      <div className={`spark-body ${bodyClass}`}>
        <svg viewBox="0 0 120 156" width="100%" height="100%" aria-hidden="true" style={{ overflow: 'visible' }}>
          <defs>
            {/* flame flicker: animated noise nudges the edges like real fire.
                userSpaceOnUse so thin strokes (arms, legs) are never clipped by the filter region. */}
            <filter id={`${id}fire`} filterUnits="userSpaceOnUse" x="-40" y="-40" width="200" height="240">
              <feTurbulence type="fractalNoise" baseFrequency="0.03 0.06" numOctaves="2" seed="4" result="n">
                <animate attributeName="baseFrequency" dur="3.2s" values="0.03 0.06;0.038 0.075;0.03 0.06" repeatCount="indefinite" />
              </feTurbulence>
              <feDisplacementMap in="SourceGraphic" in2="n" scale="4" xChannelSelector="R" yChannelSelector="G" />
            </filter>
            <filter id={`${id}skin`} filterUnits="userSpaceOnUse" x="-40" y="-40" width="200" height="240">
              <feTurbulence type="fractalNoise" baseFrequency="0.05 0.09" numOctaves="2" seed="9" result="n">
                <animate attributeName="baseFrequency" dur="2.4s" values="0.05 0.09;0.06 0.11;0.05 0.09" repeatCount="indefinite" />
              </feTurbulence>
              <feDisplacementMap in="SourceGraphic" in2="n" scale="2.4" xChannelSelector="R" yChannelSelector="G" />
            </filter>
            <filter id={`${id}blur`} filterUnits="userSpaceOnUse" x="-60" y="-60" width="240" height="280"><feGaussianBlur stdDeviation="6" /></filter>
            <filter id={`${id}soft`} filterUnits="userSpaceOnUse" x="-40" y="-40" width="200" height="240"><feGaussianBlur stdDeviation="1.2" /></filter>

            <radialGradient id={`${id}glow`} cx=".5" cy=".5" r=".5">
              <stop offset="0" stopColor="#ff9a2e" stopOpacity=".55" /><stop offset="1" stopColor="#ff3d00" stopOpacity="0" />
            </radialGradient>
            <linearGradient id={`${id}flameOuter`} x1="0" y1="1" x2="0" y2="0">
              <stop offset="0" stopColor="#f7931e" /><stop offset=".6" stopColor="#f58a14" /><stop offset="1" stopColor="#ef5a14" />
            </linearGradient>
            <linearGradient id={`${id}flameInner`} x1="0" y1="1" x2="0" y2="0">
              <stop offset="0" stopColor="#ffd25a" /><stop offset="1" stopColor="#ffc233" />
            </linearGradient>
            {/* limb + clothes gradients use fixed coordinates (userSpaceOnUse). With the default box-relative
                units, a perfectly straight horizontal or vertical stroke has a zero-size box and is not drawn at all. */}
            <linearGradient id={`${id}limb`} gradientUnits="userSpaceOnUse" x1="0" y1="90" x2="0" y2="140">
              <stop offset="0" stopColor="#ffc233" /><stop offset=".55" stopColor="#ff8a1f" /><stop offset="1" stopColor="#e8431a" />
            </linearGradient>
            <linearGradient id={`${id}black`} gradientUnits="userSpaceOnUse" x1="30" y1="90" x2="90" y2="150">
              <stop offset="0" stopColor="#2b2430" /><stop offset=".5" stopColor="#0b090e" /><stop offset="1" stopColor="#1a1520" />
            </linearGradient>
            <radialGradient id={`${id}iris`} cx=".5" cy=".4" r=".6">
              <stop offset="0" stopColor="#ffb347" /><stop offset=".6" stopColor="#b8460f" /><stop offset="1" stopColor="#5a1d08" />
            </radialGradient>
          </defs>

          {ground}

          {/* run: speed lines streaming behind her */}
          {isRun && [[4, 78], [0, 96], [6, 114]].map(([x, y], i) => (
            <line key={i} x1={x} y1={y} x2={x + 20} y2={y} stroke="#ffb347" strokeWidth="1.6" strokeLinecap="round" opacity=".6">
              <animateTransform attributeName="transform" type="translate" values="8 0;-14 0" dur=".7s" begin={`${i * 0.2}s`} repeatCount="indefinite" />
              <animate attributeName="opacity" values="0;.7;0" dur=".7s" begin={`${i * 0.2}s`} repeatCount="indefinite" />
            </line>
          ))}

          <g>
            {idle && <animateTransform attributeName="transform" type="translate" values={idle.values} dur={idle.dur} repeatCount="indefinite" />}
            <g transform={bodyT}>
              {/* halo glow follows the head */}
              <g transform={headT}>
                <circle cx="60" cy="48" r="50" fill={u('glow')} filter={u('blur')}>
                  <animate attributeName="opacity" values=".7;1;.7" dur="2.4s" repeatCount="indefinite" />
                </circle>
              </g>

              {armsBack}
              <g transform={torsoT}>{legs}{torso}</g>
              {armsMid}
              <g transform={headT}>{head}</g>
              {armsFront}

              {/* worried: a nervous drop of sweat */}
              {isWorried && (
                <path d="M89 44 C91 48 93 50 93 53 C93 56 91 58 89 58 C87 58 85 56 85 53 C85 50 87 48 89 44Z" fill="#9fdcff" opacity=".9">
                  <animateTransform attributeName="transform" type="translate" values="0 0;0 10" dur="1.6s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0;.9;.9;0" dur="1.6s" repeatCount="indefinite" />
                </path>
              )}
              {/* think: thought dots rising */}
              {isThink && [[92, 22, 1.8], [100, 13, 2.6], [110, 2, 3.6]].map(([x, y, r], i) => (
                <circle key={i} cx={x} cy={y} r={r} fill="#ffe9b0">
                  <animate attributeName="opacity" values=".15;1;.15" dur="1.8s" begin={`${i * 0.3}s`} repeatCount="indefinite" />
                </circle>
              ))}
            </g>
          </g>

          {/* drifting embers */}
          {[[28, 40, 0], [92, 34, 1.1], [18, 70, 2.1], [102, 66, .6], [64, 6, 1.6]].map(([x, y, d], i) => (
            <circle key={i} cx={x} cy={y} r={i % 2 ? 1.1 : 1.6} fill="#ffd34a">
              <animate attributeName="cy" values={`${y};${y - 26}`} dur="3s" begin={`${d}s`} repeatCount="indefinite" />
              <animate attributeName="opacity" values="0;1;0" dur="3s" begin={`${d}s`} repeatCount="indefinite" />
            </circle>
          ))}
        </svg>
      </div>
    </div>
  );
}