import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, AreaChart, Area, Legend, PieChart, Pie, Cell } from 'recharts';

const AXIS = { fill: '#64708c', fontSize: 11 };
const TOOLTIP = {
  contentStyle: { background: '#141c33', border: '1px solid #2c3b61', borderRadius: 10, fontSize: 12 },
  labelStyle: { color: '#9aa5c0' },
  itemStyle: { color: '#f4f6fb' },
};

export function TimeChart({ data, x, lines, height = 260 }: {
  data: any[];
  x: string;
  lines: { key: string; color: string; name?: string }[];
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid stroke="#1e2a47" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey={x} tick={AXIS} tickLine={false} axisLine={{ stroke: '#1e2a47' }} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} />
        <Tooltip {...TOOLTIP} />
        <Legend wrapperStyle={{ fontSize: 11, color: '#9aa5c0' }} />
        {lines.map((l) => (
          <Line key={l.key} type="monotone" dataKey={l.key} name={l.name ?? l.key} stroke={l.color} strokeWidth={2} dot={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function BarSeries({ data, x, bars, height = 240 }: {
  data: any[];
  x: string;
  bars: { key: string; color: string; name?: string }[];
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid stroke="#1e2a47" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey={x} tick={AXIS} tickLine={false} axisLine={{ stroke: '#1e2a47' }} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} />
        <Tooltip {...TOOLTIP} cursor={{ fill: 'rgba(255,157,31,0.06)' }} />
        <Legend wrapperStyle={{ fontSize: 11, color: '#9aa5c0' }} />
        {bars.map((b) => (
          <Bar key={b.key} dataKey={b.key} name={b.name ?? b.key} fill={b.color} radius={[4, 4, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function Donut({ data, height = 220 }: { data: { name: string; value: number; color: string }[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" innerRadius={52} outerRadius={80} paddingAngle={3} stroke="none">
          {data.map((d) => (
            <Cell key={d.name} fill={d.color} />
          ))}
        </Pie>
        <Tooltip {...TOOLTIP} />
        <Legend wrapperStyle={{ fontSize: 11, color: '#9aa5c0' }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function SparkArea({ data, x, y, color = '#ff9d1f', height = 90 }: { data: any[]; x: string; y: string; color?: string; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
        <defs>
          <linearGradient id={`g-${y}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey={x} hide />
        <YAxis hide domain={['auto', 'auto']} />
        <Tooltip {...TOOLTIP} />
        <Area type="monotone" dataKey={y} stroke={color} strokeWidth={2} fill={`url(#g-${y})`} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
