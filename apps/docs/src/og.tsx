import type { ReactNode } from "react";

const RED = "#b0392e";
const INK = "#151412";
const PAPER = "#f2f0ea";
const CARD_BG = "#f7f6f2";
const LINE = "#1a1915";

interface FontEntry {
  name: string;
  data: ArrayBuffer;
  weight?: number;
  style?: "normal" | "italic";
}

async function loadGoogleFont(family: string, weight: number, text?: string): Promise<ArrayBuffer> {
  const params = new URLSearchParams({
    family: `${family}:wght@${weight}`,
  });
  if (text) params.set("text", text);

  const css = await fetch(`https://fonts.googleapis.com/css2?${params.toString()}`, {
    // a legacy user agent so Google Fonts responds with TTF sources
    headers: { "User-Agent": "curl/8.0" },
  }).then((res) => res.text());

  const url = css.match(/src: url\((.+?)\) format\('truetype'\)/)?.[1];
  if (!url) throw new Error(`failed to resolve font: ${family} ${weight}`);

  return fetch(url).then((res) => res.arrayBuffer());
}

let fontsCache: Promise<FontEntry[]> | undefined;

export function loadFonts(): Promise<FontEntry[]> {
  fontsCache ??= Promise.all([
    loadGoogleFont("Noto Serif", 500).then((data) => ({
      name: "Noto Serif",
      data,
      weight: 500,
    })),
    loadGoogleFont("Noto Serif", 700).then((data) => ({
      name: "Noto Serif",
      data,
      weight: 700,
    })),
    loadGoogleFont("JetBrains Mono", 400).then((data) => ({
      name: "JetBrains Mono",
      data,
      weight: 400,
    })),
    loadGoogleFont("JetBrains Mono", 700).then((data) => ({
      name: "JetBrains Mono",
      data,
      weight: 700,
    })),
    loadGoogleFont("Noto Serif JP", 600, "手紙").then((data) => ({
      name: "Noto Serif JP",
      data,
      weight: 600,
    })),
  ]);

  return fontsCache;
}

/**
 * The blueprint-style line art behind the text: paper grain, the planet arc,
 * the envelope of dashed lines converging on a red dot, the starburst seal
 * and the red beam. Rendered as a single SVG layer.
 */
function backdrop(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <filter id="grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/>
      <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.14 0"/>
    </filter>
    <radialGradient id="dot" cx="35%" cy="30%" r="80%">
      <stop offset="0%" stop-color="#d4564a"/>
      <stop offset="60%" stop-color="${RED}"/>
      <stop offset="100%" stop-color="#7e241d"/>
    </radialGradient>
    <linearGradient id="beam" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${RED}" stop-opacity="0.75"/>
      <stop offset="100%" stop-color="${RED}" stop-opacity="0.06"/>
    </linearGradient>
  </defs>

  <rect width="1200" height="630" fill="${PAPER}"/>
  <rect width="1200" height="630" filter="url(#grain)"/>

  <!-- planet arc -->
  <circle cx="610" cy="1460" r="1050" fill="#e7e5df"/>
  <circle cx="610" cy="1460" r="1050" fill="none" stroke="${LINE}" stroke-width="2"/>

  <!-- red beam falling onto the starburst -->
  <polygon points="196,330 300,330 262,548 232,548" fill="url(#beam)"/>
  <line x1="196" y1="330" x2="232" y2="548" stroke="${RED}" stroke-width="1.5" stroke-dasharray="6 5" opacity="0.7"/>
  <line x1="300" y1="330" x2="262" y2="548" stroke="${RED}" stroke-width="1.5" stroke-dasharray="6 5" opacity="0.7"/>

  <!-- dashed envelope wiring -->
  <polyline points="248,218 610,218 610,395" fill="none" stroke="${LINE}" stroke-width="2" stroke-dasharray="7 6"/>
  <polyline points="248,218 248,556 952,556 952,318" fill="none" stroke="${LINE}" stroke-width="2" stroke-dasharray="7 6"/>
  <line x1="248" y1="218" x2="592" y2="401" stroke="${LINE}" stroke-width="2" stroke-dasharray="7 6"/>
  <line x1="952" y1="318" x2="630" y2="401" stroke="${LINE}" stroke-width="2" stroke-dasharray="7 6"/>
  <line x1="640" y1="404" x2="1090" y2="330" stroke="#8a877f" stroke-width="2" stroke-dasharray="7 6"/>

  <!-- red dot landing on the arc -->
  <circle cx="610" cy="412" r="58" fill="none" stroke="${LINE}" stroke-width="2" stroke-dasharray="7 6"/>
  <circle cx="610" cy="412" r="19" fill="url(#dot)"/>

  <!-- starburst seal -->
  <circle cx="247" cy="556" r="44" fill="none" stroke="#55524a" stroke-width="1.5"/>
  <g transform="translate(247 556)" stroke="${RED}" stroke-width="3" stroke-linecap="round">
    <line x1="0" y1="-30" x2="0" y2="30"/>
    <line x1="-30" y1="0" x2="30" y2="0"/>
    <line x1="-21" y1="-21" x2="21" y2="21"/>
    <line x1="-21" y1="21" x2="21" y2="-21"/>
    <line x1="-11" y1="-26" x2="11" y2="26" stroke-width="2"/>
    <line x1="-26" y1="-11" x2="26" y2="11" stroke-width="2"/>
    <line x1="-26" y1="11" x2="26" y2="-11" stroke-width="2"/>
    <line x1="-11" y1="26" x2="11" y2="-26" stroke-width="2"/>
  </g>
</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export interface OGImageInput {
  title: string;
  description?: string;
}

export function generateOGImage({ title, description }: OGImageInput): ReactNode {
  const shortDescription =
    description && description.length > 130 ? `${description.slice(0, 127)}...` : description;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        backgroundColor: PAPER,
        fontFamily: "Noto Serif",
        color: INK,
      }}
    >
      <img
        src={backdrop()}
        width={1200}
        height={630}
        style={{ position: "absolute", top: 0, left: 0 }}
      />

      {/* wordmark */}
      <div
        style={{
          position: "absolute",
          top: 42,
          left: 72,
          display: "flex",
          width: 600,
          flexDirection: "column",
        }}
      >
        <div style={{ fontSize: 92, fontWeight: 500, lineHeight: 1.1, zIndex: 5 }}>{title}</div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: 6,
          }}
        >
          <div
            style={{
              fontFamily: "Noto Serif JP",
              fontSize: 54,
              fontWeight: 600,
              color: RED,
              lineHeight: 1.2,
            }}
          >
            手紙
          </div>
          <div
            style={{
              width: 118,
              height: 4,
              backgroundColor: RED,
              marginTop: 4,
            }}
          />
        </div>
      </div>

      {/* letter card */}
      <div
        style={{
          position: "absolute",
          top: 64,
          right: 60,
          width: 520,
          display: "flex",
          flexDirection: "column",
          padding: "26px 30px",
          backgroundColor: CARD_BG,
          border: `1px solid #b9b5aa`,
          fontFamily: "JetBrains Mono",
          fontSize: 21,
          lineHeight: 1.55,
          color: "#3c3a34",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span>---</span>
          <span>packages:</span>
          <span style={{ marginLeft: 24 }}>tegami: minor</span>
          <span>---</span>
        </div>
        <div
          style={{
            marginTop: 24,
            fontWeight: 700,
            color: RED,
            fontSize: 24,
          }}
        >
          ## {title}
        </div>
        {shortDescription ? <div style={{ marginTop: 18 }}>{shortDescription}</div> : null}
      </div>

      {/* signature on the planet */}
      <div
        style={{
          position: "absolute",
          top: 496,
          left: 820,
          fontFamily: "JetBrains Mono",
          fontWeight: 700,
          fontSize: 24,
          letterSpacing: 4,
          color: RED,
        }}
      >
        FUMA NAMA.
      </div>

      {/* tagline */}
      <div
        style={{
          position: "absolute",
          top: 560,
          left: 0,
          width: 1200,
          display: "flex",
          justifyContent: "center",
          fontSize: 36,
          fontWeight: 500,
          color: INK,
        }}
      >
        Changelogs Versioning Publishing
      </div>
    </div>
  );
}
