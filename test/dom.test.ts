import assert from 'node:assert'
import { JSDOM } from 'jsdom'
import { buildSegments } from '../src/lib/segments'
import { selectionToOffsets, setSelectionRange } from '../src/lib/dom'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// ---------- 分段逻辑 ----------

check('buildSegments：分段切片拼回与原文逐字符一致', () => {
  const text = '一二三四五六七八九十一二三四五六七八九十' // 20 字
  const segs = buildSegments(text.length, [
    { start: 2, end: 6, id: 'a' }, // 三四五六
    { start: 4, end: 9, id: 'b' }, // 五六七八九（与 a 重叠 4..6）
    { start: 14, end: 16, id: 'c' },
  ])
  const rejoined = segs.map((s) => text.slice(s.start, s.end)).join('')
  assert.strictEqual(rejoined, text)

  // 重叠段应携带两条标注
  const overlap = segs.find((s) => s.start === 4 && s.end === 6)!
  assert.deepStrictEqual(overlap.annotationIds.sort(), ['a', 'b'])

  // 每条标注覆盖到的区间并集应恰好等于其原区间
  for (const [id, lo, hi] of [
    ['a', 2, 6],
    ['b', 4, 9],
    ['c', 14, 16],
  ] as const) {
    const covered = segs
      .filter((s) => s.annotationIds.includes(id))
      .map((s) => [s.start, s.end] as const)
    let union = ''
    for (const [s, e] of covered) union += text.slice(s, e)
    assert.strictEqual(union, text.slice(lo, hi))
  }
})

check('buildSegments：无标注时为整段；空区间被忽略', () => {
  const segs = buildSegments(5, [{ start: 3, end: 3, id: 'x' }])
  assert.strictEqual(segs.length, 1)
  assert.deepStrictEqual(segs[0].annotationIds, [])
})

// ---------- jsdom：选区偏移往返 ----------

const dom = new JSDOM('<!doctype html><body><article id="root"></article></body>')
const { window } = dom
;(globalThis as unknown as { window: typeof window }).window = window
;(globalThis as unknown as { document: Document }).document = window.document
;(globalThis as unknown as { Node: typeof Node }).Node = window.Node
;(globalThis as unknown as { NodeFilter: typeof NodeFilter }).NodeFilter =
  window.NodeFilter

const doc = window.document

function render(text: string, anns: Array<[number, number, string]>) {
  const root = doc.getElementById('root') as HTMLElement
  root.innerHTML = ''
  const segs = buildSegments(
    text.length,
    anns.map(([start, end, id]) => ({ start, end, id })),
  )
  for (const seg of segs) {
    const slice = text.slice(seg.start, seg.end)
    if (seg.annotationIds.length === 0) {
      root.appendChild(doc.createTextNode(slice))
    } else {
      const mark = doc.createElement('mark')
      mark.textContent = slice
      mark.dataset.start = String(seg.start)
      mark.dataset.end = String(seg.end)
      mark.dataset.ids = seg.annotationIds.join(',')
      root.appendChild(mark)
    }
  }
  return root
}

check('selectionToOffsets：跨高亮边界的选区偏移正确', () => {
  const text = '开头平平无奇的文字中间【重点】后面又是普通文字结尾。'
  const root = render(text, [[text.indexOf('【重点】'), text.indexOf('【重点】') + 4, 'a']])

  // 从普通文本拖到 mark 内再拖出来
  const range = doc.createRange()
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let n = walker.nextNode()
  while (n) {
    nodes.push(n as Text)
    n = walker.nextNode()
  }
  // 节点结构：文本 / mark文本 / 文本
  assert.strictEqual(nodes.length, 3)
  range.setStart(nodes[0], 4) // 第一个文本节点第 4 字
  range.setEnd(nodes[2], 3) // 最后一个文本节点第 3 字
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)

  const off = selectionToOffsets(root)
  assert.ok(off)
  assert.strictEqual(text.slice(off!.start, off!.end), range.toString())
  assert.strictEqual(off!.start, 4)
  assert.strictEqual(off!.end, text.length - nodes[2].textContent!.length + 3)
})

check('setSelectionRange / selectionToOffsets：多边界点往返一致', () => {
  const text = '甲乙丙丁戊己庚辛壬癸'.repeat(4) // 40 字
  const root = render(text, [
    [3, 8, 'a'],
    [6, 12, 'b'],
    [20, 25, 'c'],
    [30, 31, 'd'],
  ])

  const points = [0, 1, 3, 5, 8, 12, 19, 20, 25, 29, 31, 39, 40]
  for (const s of points) {
    for (const e of points) {
      if (e <= s) continue
      const ok = setSelectionRange(root, s, e)
      assert.ok(ok, `设置选区 [${s}, ${e}) 应成功`)
      const back = selectionToOffsets(root)
      assert.ok(back, `读回选区 [${s}, ${e}) 应非空`)
      assert.strictEqual(back!.start, s, `起点往返 [${s}, ${e})`)
      assert.strictEqual(back!.end, e, `终点往返 [${s}, ${e})`)
      const sel = window.getSelection()!
      assert.strictEqual(sel.toString(), text.slice(s, e))
    }
  }
})

check('选区不在 root 内时返回 null', () => {
  const text = '容器内的文字'
  const root = render(text, [[1, 3, 'a']])
  const foreign = doc.createElement('div')
  doc.body.appendChild(foreign)
  foreign.textContent = '外部'
  const range = doc.createRange()
  range.selectNodeContents(foreign)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
  assert.strictEqual(selectionToOffsets(root), null)
  foreign.remove()
})

console.log(`\n全部 ${passed} 项通过`)
