/* Decorative constellation layer behind the main workspace (dark theme).
   Nodes cluster toward the top-right / header band and thin out further
   down so the connections table stays legible. */

type Node = [x: number, y: number, r: number, opacity: number];

const NODES: Node[] = [
  // Dense top-right cluster
  [1540, 40, 3.5, 0.5],
  [1460, 95, 2.5, 0.45],
  [1575, 170, 3, 0.4],
  [1390, 40, 2, 0.4],
  [1350, 150, 3.5, 0.5],
  [1480, 220, 2.5, 0.4],
  [1275, 85, 2.5, 0.45],
  [1220, 200, 3, 0.4],
  [1560, 300, 2, 0.35],
  [1400, 290, 3, 0.4],
  [1150, 30, 2, 0.35],
  [1300, 330, 2.5, 0.35],
  [1100, 130, 3, 0.4],
  [1180, 300, 2, 0.3],
  // Header band, thinning to the left
  [980, 60, 2.5, 0.35],
  [1030, 230, 2, 0.3],
  [860, 140, 3, 0.3],
  [760, 45, 2, 0.3],
  [640, 120, 2.5, 0.25],
  [520, 50, 2, 0.25],
  [400, 110, 2, 0.2],
  [280, 40, 2.5, 0.2],
  // Sparse lower drift
  [1500, 430, 2.5, 0.3],
  [1330, 470, 2, 0.25],
  [1580, 560, 2, 0.2],
  [1120, 420, 2, 0.2],
  [930, 330, 2, 0.2],
  [1420, 640, 2, 0.2],
];

const LINK_DISTANCE = 190;

const LINKS: [number, number][] = [];
NODES.forEach(([ax, ay], a) => {
  NODES.forEach(([bx, by], b) => {
    if (b <= a) return;
    if (Math.hypot(ax - bx, ay - by) <= LINK_DISTANCE) LINKS.push([a, b]);
  });
});

const DEGREE = NODES.map((_, i) => LINKS.filter(([a, b]) => a === i || b === i).length);

export default function DashboardBackground() {
  return (
    <div className="dashboard-background" aria-hidden="true" data-testid="dashboard-background">
      <svg
        className="dashboard-constellation"
        viewBox="0 0 1600 900"
        preserveAspectRatio="xMaxYMin slice"
        xmlns="http://www.w3.org/2000/svg"
      >
        {LINKS.map(([a, b]) => (
          <line
            key={`${a}-${b}`}
            x1={NODES[a][0]}
            y1={NODES[a][1]}
            x2={NODES[b][0]}
            y2={NODES[b][1]}
            stroke="currentColor"
            strokeWidth={1}
            strokeOpacity={0.12}
          />
        ))}
        {NODES.map(([x, y, r, opacity], i) => (
          <circle
            key={`${x}-${y}`}
            cx={x}
            cy={y}
            r={r}
            fill="currentColor"
            fillOpacity={opacity}
            className={DEGREE[i] >= 4 ? "dashboard-constellation-junction" : undefined}
          />
        ))}
      </svg>
    </div>
  );
}
