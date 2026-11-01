import { ACOUSTIC_DIMENSIONS } from '../core/AcousticVector.ts';
import { PrincipalAxes } from '../math/LinearAlgebra.ts';

export function escapeMarkup(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export interface RadarSeries {
  label: string;
  values: readonly (number | null)[]; // Raw [0, 1]; null when that dimension is unknown
  color: string;
  dashed?: boolean;
}
export const RadarSeries = {};

const RADAR_SIZE = 300;

/** Axes keep the feature's own 0-1 scale, labeled with its real name. Unknown dimensions sit at the center. */
export function radarSvg(series: readonly RadarSeries[]): string {
  const center = RADAR_SIZE / 2;
  const radius = center - 58;
  const count = ACOUSTIC_DIMENSIONS.length;
  const at = (i: number, value: number) => {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2;
    return [center + radius * value * Math.cos(angle), center + radius * value * Math.sin(angle)];
  };

  const rings = [0.25, 0.5, 0.75, 1].map((level) => {
    const points = ACOUSTIC_DIMENSIONS.map((_, i) => at(i, level).map((n) => n.toFixed(1)).join(',')).join(' ');
    return `<polygon points="${points}" fill="none" stroke="rgba(128,128,128,0.3)"/>`;
  }).join('');

  const labels = ACOUSTIC_DIMENSIONS.map((dimension, i) => {
    const [x, y] = at(i, 1.17);
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="9" text-anchor="middle" fill="currentColor">${dimension}</text>`;
  }).join('');

  const shapes = series.map(({ values, color, dashed }) => {
    const points = values.map((value, i) => at(i, value ?? 0).map((n) => n.toFixed(1)).join(',')).join(' ');
    return `<polygon points="${points}" fill="${color}" fill-opacity="0.12" stroke="${color}" stroke-width="1.5"${dashed ? ' stroke-dasharray="4 3"' : ''}/>`;
  }).join('');

  const legend = series.map(({ label, color }, i) => {
    return `<text x="4" y="${12 + i * 12}" font-size="9" fill="${color}">■ ${escapeMarkup(label)}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${RADAR_SIZE} ${RADAR_SIZE}" width="100%" style="max-width:${RADAR_SIZE}px" role="img" aria-label="Radar acústico">${rings}${labels}${shapes}${legend}</svg>`;
}

export interface ConstellationPoint {
  coordinates: readonly number[]; // Standardized 8D position
  label: string;
  rating?: number;
  kind: 'track' | 'cluster' | 'current';
}
export const ConstellationPoint = {};

const MAP_WIDTH = 480;
const MAP_HEIGHT = 300;
const MAP_MARGIN = 18;

function ratingColor(rating: number | undefined): string {
  if (rating === undefined) return '#9aa0a6';
  if (rating >= 4) return '#1db954';
  return rating === 0 ? '#e22134' : rating <= 2 ? '#f59b23' : '#9aa0a6';
}

export function constellationSvg(points: readonly ConstellationPoint[], pca: PrincipalAxes): string {
  const [first, second] = pca.axes;
  const projected = points.map((point) => {
    const project = (axis: readonly number[]) => axis.reduce((sum, value, i) => sum + value * point.coordinates[i], 0);
    return { ...point, x: project(first), y: project(second) };
  });

  const xs = projected.map((p) => p.x);
  const ys = projected.map((p) => p.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs, -1), Math.max(...xs, 1), Math.min(...ys, -1), Math.max(...ys, 1)];
  const scaleX = (v: number) => MAP_MARGIN + ((v - minX) / (maxX - minX)) * (MAP_WIDTH - 2 * MAP_MARGIN);
  const scaleY = (v: number) => MAP_HEIGHT - MAP_MARGIN - ((v - minY) / (maxY - minY)) * (MAP_HEIGHT - 2 * MAP_MARGIN);

  const marks = projected
    .sort((a, b) => (a.kind === 'track' ? 0 : 1) - (b.kind === 'track' ? 0 : 1))
    .map((point) => {
      const [x, y] = [scaleX(point.x).toFixed(1), scaleY(point.y).toFixed(1)];
      const title = `<title>${escapeMarkup(point.label)}</title>`;
      if (point.kind === 'cluster') return `<circle cx="${x}" cy="${y}" r="9" fill="none" stroke="#509bf5" stroke-width="2">${title}</circle>`;
      if (point.kind === 'current') return `<circle cx="${x}" cy="${y}" r="6" fill="#fff" stroke="#000">${title}</circle>`;
      return `<circle cx="${x}" cy="${y}" r="3" fill="${ratingColor(point.rating)}" fill-opacity="0.75">${title}</circle>`;
    }).join('');

  const explained = pca.explained.reduce((sum, value) => sum + value, 0);
  const note = `PC1 + PC2 = ${Math.round(explained * 100)}% da variância: distâncias no mapa aproximam o espaço original de 8 dimensões.`;

  return `<svg viewBox="0 0 ${MAP_WIDTH} ${MAP_HEIGHT}" width="100%" role="img" aria-label="Mapa de constelação musical">${marks}</svg><div style="font-size:11px;opacity:.65">${escapeMarkup(note)}</div>`;
}

/** A plain bar chart with the value printed, for the dossier and the dashboard. */
export function barChartSvg(rows: ReadonlyArray<{ label: string; value: number }>, color: string = '#1db954'): string {
  const peak = Math.max(1e-9, ...rows.map((r) => r.value));
  const height = rows.length * 18 + 4;
  const bars = rows.map(({ label, value }, i) => {
    const width = (value / peak) * 240;
    const y = i * 18 + 2;
    return `<text x="0" y="${y + 11}" font-size="10" fill="currentColor">${escapeMarkup(label)}</text>`
      + `<rect x="110" y="${y + 2}" width="${width.toFixed(1)}" height="11" fill="${color}"/>`
      + `<text x="${(115 + width).toFixed(1)}" y="${y + 11}" font-size="10" fill="currentColor">${Number.isInteger(value) ? value : value.toFixed(2)}</text>`;
  }).join('');

  return `<svg viewBox="0 0 420 ${height}" width="100%" style="max-width:520px">${bars}</svg>`;
}
