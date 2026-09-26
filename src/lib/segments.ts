// 区间分段与配色：把标注区间切成互不重叠的文本段，同一段内可能叠加多条标注

export interface TextSegment {
  start: number
  end: number
  annotationIds: string[]
}

interface Interval {
  start: number
  end: number
  id: string
}

export function buildSegments(
  textLength: number,
  intervals: Interval[],
): TextSegment[] {
  const points = new Set<number>([0, textLength])
  for (const iv of intervals) {
    if (iv.start >= 0 && iv.end <= textLength && iv.end > iv.start) {
      points.add(iv.start)
      points.add(iv.end)
    }
  }
  const sorted = [...points].sort((a, b) => a - b)
  const segments: TextSegment[] = segmentsFromPoints(sorted, intervals)
  return segments.filter((s) => s.end > s.start)
}

function segmentsFromPoints(points: number[], intervals: Interval[]): TextSegment[] {
  const out: TextSegment[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]
    const end = points[i + 1]
    const ids = intervals
      .filter((iv) => iv.start <= start && end <= iv.end)
      .map((iv) => iv.id)
    out.push({ start, end, annotationIds: ids })
  }
  return out
}

// ---------- 颜色混合 ----------

const PALETTE: Array<[number, number, number]> = [
  [255, 138, 128], // red
  [255, 213, 79], // amber
  [129, 199, 132], // green
  [100, 181, 246], // blue
  [186, 104, 200], // purple
  [255, 167, 38], // orange
  [77, 208, 225], // cyan
]

export function colorForId(id: string): [number, number, number] {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

function toRgb(c: [number, number, number]) {
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}

/**
 * 多条标注叠加：以白色为底、各颜色半透明叠加后，再按 alpha 与白底混合，
 * 输出浏览器可直接使用的 rgb()。
 */
export function blendedColor(ids: string[], alpha = 0.38): string {
  if (ids.length === 0) return 'transparent'
  if (ids.length === 1) return toRgb(colorForId(ids[0]))

  let [r, g, b]: [number, number, number] = [255, 255, 255]
  for (const id of ids) {
    const [cr, cg, cb] = colorForId(id)
    ;[r, g, b] = blendOver([r, g, b], [cr, cg, cb], alpha)
  }
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`
}

function blendOver(
  base: number[],
  over: number[],
  alpha: number,
): [number, number, number] {
  return [
    base[0] * (1 - alpha) + over[0] * alpha,
    base[1] * (1 - alpha) + over[1] * alpha,
    base[2] * (1 - alpha) + over[2] * alpha,
  ]
}

/** 单条标注的徽章底色 */
export function badgeColor(id: string): string {
  return toRgb(colorForId(id))
}
