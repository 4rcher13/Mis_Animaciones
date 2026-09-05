// scripts/generate.mjs
//
// Genera dist/space-invaders.svg: un juego de "Space Invaders" animado
// (solo CSS/SMIL, sin JS) donde cada "invasor" es un día de tu calendario
// de contribuciones de GitHub. Los invasores caen en vertical (en vez del
// clásico barrido lateral) y la nave se mueve sola disparando.
//
// Uso:
//   GH_USERNAME=tu_usuario GH_TOKEN=xxxxx node scripts/generate.mjs
//
// Si no hay GH_TOKEN, se usan datos de ejemplo (modo demo) para poder
// previsualizar el resultado sin credenciales.

import { writeFile, mkdir } from "node:fs/promises";

const USERNAME = process.env.GH_USERNAME || "4rcher13";
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

// ---- 1. Formación del juego -----------------------------------------
const COLS = 12; // últimas 12 semanas
const ROWS = 6; // Lun, Mar, Mié, Jue, Vie, Fin de semana (Sáb+Dom)
const CELL = 46; // separación entre invasores
const MARGIN_X = 60;
const MARGIN_TOP = 90;
const WIDTH = MARGIN_X * 2 + (COLS - 1) * CELL + 40;
const HEIGHT = 560;
const FALL_HEIGHT = HEIGHT - 60; // recorrido de caída antes de reiniciar

// ---- 2. Obtener datos reales o de ejemplo ----------------------------
async function fetchContributions(username, token) {
  const query = `
    query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays { date contributionCount weekday }
            }
          }
        }
      }
    }`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: { login: username } }),
  });
  if (!res.ok) {
    throw new Error(`GitHub GraphQL API respondió ${res.status}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  return json.data.user.contributionsCollection.contributionCalendar;
}

function mockContributions() {
  const weeks = [];
  for (let w = 0; w < COLS + 2; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const count = Math.random() < 0.35 ? 0 : Math.floor(Math.random() * 10);
      days.push({ contributionCount: count, weekday: d });
    }
    weeks.push({ contributionDays: days });
  }
  const totalContributions = weeks
    .flatMap((w) => w.contributionDays)
    .reduce((a, d) => a + d.contributionCount, 0);
  return { totalContributions, weeks };
}

// ---- 3. Convertir el calendario en una matriz ROWS x COLS ------------
// weekday de GitHub: 0=Domingo ... 6=Sábado
function buildGrid(calendar) {
  const weeks = calendar.weeks.slice(-COLS);
  const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(0));

  weeks.forEach((week, col) => {
    const byWeekday = {};
    week.contributionDays.forEach((d) => (byWeekday[d.weekday] = d.contributionCount));

    grid[0][col] = byWeekday[1] ?? 0; // Lunes
    grid[1][col] = byWeekday[2] ?? 0; // Martes
    grid[2][col] = byWeekday[3] ?? 0; // Miércoles
    grid[3][col] = byWeekday[4] ?? 0; // Jueves
    grid[4][col] = byWeekday[5] ?? 0; // Viernes
    grid[5][col] = Math.round(((byWeekday[6] ?? 0) + (byWeekday[0] ?? 0)) / 2); // Fin de semana
  });

  return grid;
}

// Niveles de color estilo GitHub (0 = sin actividad, 4 = mucha actividad)
const LEVEL_COLORS = ["#30363d", "#0e4429", "#006d32", "#26a641", "#39d353"];

function levelFor(count, quartiles) {
  if (count === 0) return 0;
  if (count <= quartiles[0]) return 1;
  if (count <= quartiles[1]) return 2;
  if (count <= quartiles[2]) return 3;
  return 4;
}

function computeQuartiles(grid) {
  const values = grid.flat().filter((v) => v > 0).sort((a, b) => a - b);
  if (values.length === 0) return [1, 2, 3];
  const q = (p) => values[Math.min(values.length - 1, Math.floor(values.length * p))];
  return [q(0.33), q(0.66), q(0.9)];
}

// ---- 4. Dibujar un invasor pixel-art (path reutilizable) -------------
const ALIEN_SYMBOL = `
<symbol id="alien" viewBox="0 0 22 16">
  <path fill="currentColor" d="M4 0h2v2h8V0h2v2h2v2h-2v2h2v2h2v2h-2v2h-2v-2h-2v2h2v2h-2v-2H8v2H6v-2h2v-2H6v2H4v-2H2v-2H0v-2h2V4h2V2h2V0Z
  M6 4H4v2h2V4Zm10 0h-2v2h2V4Z"/>
</symbol>`;

const SHIP_SYMBOL = `
<symbol id="ship" viewBox="0 0 24 14">
  <path fill="currentColor" d="M11 0h2v2h2v2h2v2h4v6H0V6h4V4h2V2h2V0h1Z"/>
</symbol>`;

// ---- 5. Construir el SVG completo -------------------------------------
function renderSVG(grid, totalContributions) {
  const quartiles = computeQuartiles(grid);

  let invaders = "";
  let count = 0;

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const value = grid[r][c];
      const level = levelFor(value, quartiles);
      const color = LEVEL_COLORS[level];
      const dim = level === 0;

      const x = MARGIN_X + c * CELL;
      const baseY = MARGIN_TOP + r * CELL;

      // Duración y desfase distintos por columna para que la "lluvia"
      // de invasores no caiga sincronizada (efecto más orgánico).
      const dur = 9 + (c % 4) * 1.5;
      const delay = -((r * 0.6 + c * 0.35) % dur);

      // Dos copias apiladas (y, y-FALL_HEIGHT) que se trasladan hacia
      // abajo: cuando la primera sale por debajo, la segunda ya está
      // entrando por arriba -> bucle continuo sin salto visible.
      invaders += `
      <g transform="translate(${x},${baseY})" color="${color}" opacity="${dim ? 0.22 : 0.95}">
        <g>
          <use href="#alien" width="22" height="16" x="-11" y="-8"/>
          <animateTransform attributeName="transform" type="translate"
            values="0,0; 0,${FALL_HEIGHT}" dur="${dur}s" begin="${delay}s"
            repeatCount="indefinite"/>
        </g>
        <g>
          <use href="#alien" width="22" height="16" x="-11" y="-8"/>
          <animateTransform attributeName="transform" type="translate"
            values="0,${-FALL_HEIGHT}; 0,0" dur="${dur}s" begin="${delay}s"
            repeatCount="indefinite"/>
        </g>
      </g>`;
      count++;
    }
  }

  const shipY = HEIGHT - 34;
  const shipMinX = MARGIN_X - 10;
  const shipMaxX = WIDTH - MARGIN_X - 10;
  const shipDur = 6;
  const bulletTravel = shipY - 20; // hasta dónde sube la bala (coords locales)

  // Disparos: van DENTRO del mismo <g> que se traslada con la nave, así
  // que heredan su transform automáticamente (misma posición X en todo
  // momento, sin animación propia en X). Cada bala solo anima su propia
  // traslación vertical local (0 -> -bulletTravel) y su opacidad; el
  // cañón queda pegado a la nave sin importar dónde esté.
  let bullets = "";
  const bulletCount = 4;
  const fireInterval = 1.3; // segundos entre disparos
  for (let i = 0; i < bulletCount; i++) {
    const begin = i * (fireInterval / bulletCount);
    bullets += `
      <rect x="-1" y="-9" width="2" height="10" fill="#39d353">
        <animateTransform attributeName="transform" type="translate"
          values="0,0; 0,-${bulletTravel}" dur="${fireInterval}s"
          begin="${begin}s" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="1;1;0" dur="${fireInterval}s"
          begin="${begin}s" repeatCount="indefinite"/>
      </rect>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}"
     width="${WIDTH}" height="${HEIGHT}" font-family="'Courier New', monospace">
  <defs>
    ${ALIEN_SYMBOL}
    ${SHIP_SYMBOL}
  </defs>

  <rect width="${WIDTH}" height="${HEIGHT}" fill="#0d1117"/>

  <text x="${MARGIN_X}" y="30" fill="#39d353" font-size="14" letter-spacing="2">
    SCORE&lt;GITHUB&gt;
  </text>
  <text x="${MARGIN_X}" y="52" fill="#e6edf3" font-size="20">
    ${String(totalContributions).padStart(5, "0")}
  </text>
  <text x="${WIDTH - MARGIN_X - 150}" y="30" fill="#39d353" font-size="14" letter-spacing="2">
    @${USERNAME}
  </text>

  <g clip-path="url(#field)">
    ${invaders}
  </g>
  <clipPath id="field">
    <rect x="0" y="70" width="${WIDTH}" height="${HEIGHT - 100}"/>
  </clipPath>

  <g color="#39d353">
    <g>
      <animateTransform attributeName="transform" type="translate"
        values="${shipMinX},${shipY}; ${shipMaxX},${shipY}; ${shipMinX},${shipY}"
        keyTimes="0;0.5;1"
        dur="${shipDur}s" repeatCount="indefinite"/>
      <use href="#ship" width="24" height="14" x="-12" y="-7"/>
      ${bullets}
    </g>
  </g>

  <text x="${MARGIN_X}" y="${HEIGHT - 8}" fill="#e6edf3" font-size="12" opacity="0.7">
    contribuciones de las últimas ${COLS} semanas
  </text>
</svg>`;
}

// ---- 6. Main -----------------------------------------------------------
async function main() {
  let calendar;
  if (TOKEN) {
    calendar = await fetchContributions(USERNAME, TOKEN);
  } else {
    console.warn("Sin GH_TOKEN definido: usando datos de ejemplo (modo demo).");
    calendar = mockContributions();
  }

  const grid = buildGrid(calendar);
  const svg = renderSVG(grid, calendar.totalContributions);

  await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
  await writeFile(new URL("../dist/space-invaders.svg", import.meta.url), svg, "utf8");
  console.log("dist/space-invaders.svg generado.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
