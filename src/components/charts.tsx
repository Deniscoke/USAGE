import { formatUsd, microsToUsd } from "@/lib/domain/money";
import type { SeriesPoint } from "@/lib/pipeline/dashboard";

/**
 * Hand-rolled SVG charts.
 *
 * A charting library would be ~50KB of JS for two static, server-rendered
 * shapes. These render on the server, ship zero JS, and scale with the
 * container via viewBox + preserveAspectRatio.
 */

const CHART = { width: 720, height: 180, gap: 2 };

export function StackedUsageChart({ series }: { series: readonly SeriesPoint[] }) {
  if (series.length === 0) return null;

  const max = Math.max(
    ...series.map((p) => p.verifiedMicros + p.routedMicros + p.reportedMicros),
    1,
  );
  const slot = CHART.width / series.length;
  const barWidth = Math.max(slot - CHART.gap, 1);

  return (
    <div>
      <svg
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        preserveAspectRatio="none"
        className="h-44 w-full"
        role="img"
        aria-label="Daily AI spend by verification level"
      >
        {[0.25, 0.5, 0.75, 1].map((tick) => (
          <line
            key={tick}
            x1={0}
            x2={CHART.width}
            y1={CHART.height * (1 - tick)}
            y2={CHART.height * (1 - tick)}
            stroke="var(--border)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {series.map((point, index) => {
          const layers = [
            { value: point.verifiedMicros, color: "var(--verified)" },
            { value: point.routedMicros, color: "var(--routed)" },
            { value: point.reportedMicros, color: "var(--reported)" },
          ];
          let offset = 0;
          const total = point.verifiedMicros + point.routedMicros + point.reportedMicros;

          return (
            <g key={point.day}>
              <title>{`${point.day} — ${formatUsd(total)}`}</title>
              {layers.map((layer) => {
                const height = (layer.value / max) * (CHART.height - 6);
                const y = CHART.height - offset - height;
                offset += height;
                if (height <= 0) return null;
                return (
                  <rect
                    key={layer.color}
                    x={index * slot}
                    y={y}
                    width={barWidth}
                    height={height}
                    fill={layer.color}
                    opacity={0.9}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>

      <div className="mt-2 flex items-center justify-between text-[10px] text-[var(--faint)]">
        <span className="tnum">{series[0]?.day}</span>
        <span className="tnum">peak {formatUsd(max)} / day</span>
        <span className="tnum">{series[series.length - 1]?.day}</span>
      </div>
    </div>
  );
}

export function ScoreSparkline({ series }: { series: readonly SeriesPoint[] }) {
  if (series.length < 2) return null;

  const width = 320;
  const height = 48;
  const max = Math.max(...series.map((p) => p.points), 1);
  const step = width / (series.length - 1);

  const path = series
    .map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(2)},${(height - (p.points / max) * (height - 4)).toFixed(2)}`)
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="h-12 w-full"
      role="img"
      aria-label="Daily Proof of Usage score"
    >
      <path d={path} fill="none" stroke="var(--verified)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function usdAxisLabel(micros: number): string {
  return `$${microsToUsd(micros).toFixed(2)}`;
}
