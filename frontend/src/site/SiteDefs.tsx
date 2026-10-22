/**
 * Definisi SVG global (logo, gradien, modul mecha). Di-render sekali di root
 * agar seluruh halaman bisa memakai `<use href="#logo" />` dsb.
 * Di-vendor dari gattai-site (setiap halaman statis membawa blok yang sama).
 */
export function SiteSvgDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <linearGradient id="plateGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2a2f37" />
          <stop offset=".5" stopColor="#171a1f" />
          <stop offset="1" stopColor="#0f1115" />
        </linearGradient>
        <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(236,233,226,.07)" strokeWidth="1" />
        </pattern>
        <radialGradient id="coreGrad">
          <stop offset="0" stopColor="#2a1208" />
          <stop offset=".7" stopColor="#120a07" />
          <stop offset="1" stopColor="#0b0b0c" />
        </radialGradient>
        <radialGradient id="glowGrad">
          <stop offset="0" stopColor="#ff5b1f" stopOpacity=".55" />
          <stop offset="1" stopColor="#ff5b1f" stopOpacity="0" />
        </radialGradient>
        <path id="q" d="M20 72 L72 20 L194 20 L194 139.5 A61 61 0 0 0 139.5 194 L20 194 Z" />
        <g id="modArt">
          <use href="#q" fill="url(#plateGrad)" stroke="rgba(236,233,226,.24)" strokeWidth="1" />
          <use href="#q" fill="url(#hatch)" opacity=".6" />
          <path fill="none" stroke="rgba(236,233,226,.13)" strokeWidth="1" d="M34 80 L80 34 L180 34 M34 80 L34 180 M120 34 L120 60 L180 60" />
          <circle fill="#2b3038" stroke="rgba(236,233,226,.35)" strokeWidth=".8" cx="64" cy="40" r="3.2" />
          <circle fill="#2b3038" stroke="rgba(236,233,226,.35)" strokeWidth=".8" cx="180" cy="180" r="3.2" />
          <circle fill="#2b3038" stroke="rgba(236,233,226,.35)" strokeWidth=".8" cx="40" cy="64" r="3.2" />
          <rect x="148" y="44" width="22" height="4" rx="1" fill="#ff5b1f" opacity=".85" />
        </g>
        <symbol id="logo" viewBox="0 0 32 32">
          <image href="/logo_gattai.png" x="0" y="0" width="32" height="32" preserveAspectRatio="xMidYMid meet" />
        </symbol>
        <linearGradient id="wmFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ece9e2" stopOpacity=".82" />
          <stop offset=".5" stopColor="#ece9e2" stopOpacity=".22" />
          <stop offset="1" stopColor="#ece9e2" stopOpacity=".02" />
        </linearGradient>
        <linearGradient id="wmSheen" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ff5b1f" stopOpacity="0" />
          <stop offset=".5" stopColor="#ff8a4c" stopOpacity=".9" />
          <stop offset="1" stopColor="#ff5b1f" stopOpacity="0" />
          <animate attributeName="x1" values="-1;1.2;1.2" keyTimes="0;.45;1" dur="8s" repeatCount="indefinite" />
          <animate attributeName="x2" values="0;2.2;2.2" keyTimes="0;.45;1" dur="8s" repeatCount="indefinite" />
        </linearGradient>
      </defs>
    </svg>
  );
}
