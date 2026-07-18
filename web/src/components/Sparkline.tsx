/** Minimal sparkline: 1.5px line, terminal dot, zero baseline if in range. */
export function Sparkline({
  values,
  width = 120,
  height = 30,
  color = 'var(--home)',
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (values.length < 2) {
    return <svg width={width} height={height} />;
  }
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * 0.1;
  lo -= pad;
  hi += pad;
  const x = (i: number) => (i / (values.length - 1)) * (width - 4) + 2;
  const y = (v: number) => height - 3 - ((v - lo) / (hi - lo)) * (height - 6);
  const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
  const last = values[values.length - 1] as number;
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      {lo < 0 && hi > 0 && (
        <line x1={0} x2={width} y1={y(0)} y2={y(0)} stroke="var(--axis)" strokeDasharray="2 3" />
      )}
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={x(values.length - 1)} cy={y(last)} r={2.5} fill={color} />
    </svg>
  );
}
