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

// ---------- 嵌套标记：端点落在元素子节点边界 ----------

/**
 * 构造 TextView 在「漏标审阅」时会出现的真实结构：
 * 普通文本 / <mark class=hl> 外层高亮，内部再嵌一个 <mark class=qs-range> / 普通文本。
 * 文本总长 10：abcdefghij
 *   root:
 *     #text "ab"
 *     mark.hl            (偏移 2..8)
 *       #text "cd"
 *       mark.qs-range    (偏移 4..7)
 *         #text "efg"
 *       #text "h"
 *     #text "ij"
 */
function renderNested(): HTMLElement {
  const root = doc.getElementById('root') as HTMLElement
  root.innerHTML = ''
  root.appendChild(doc.createTextNode('ab'))
  const outer = doc.createElement('mark')
  outer.className = 'hl'
  outer.dataset.start = '2'
  outer.dataset.end = '8'
  outer.appendChild(doc.createTextNode('cd'))
  const inner = doc.createElement('mark')
  inner.className = 'qs-range'
  inner.dataset.start = '4'
  inner.dataset.end = '7'
  inner.textContent = 'efg'
  outer.appendChild(inner)
  outer.appendChild(doc.createTextNode('h'))
  root.appendChild(outer)
  root.appendChild(doc.createTextNode('ij'))
  return root
}

function placeRange(
  sc: Node,
  so: number,
  ec: Node,
  eo: number,
): Range {
  const range = doc.createRange()
  range.setStart(sc, so)
  range.setEnd(ec, eo)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
  return range
}

check('端点落在外层 / 内层标记子节点边界时偏移不错位', () => {
  const text = 'abcdefghij'
  const root = renderNested()
  const [outer] = root.querySelectorAll('mark.hl')
  const inner = root.querySelector('mark.qs-range')!
  const plain = root.lastChild as Text // "ij"

  // 外标记起点边界（sc=outer, so=0）→ 偏移 2；终点在普通文本第 1 字 → 偏移 9
  const r1 = placeRange(outer, 0, plain, 1)
  assert.strictEqual(r1.toString(), text.slice(2, 9))
  let off = selectionToOffsets(root)
  assert.ok(off, '端点在外标记边界不应导致选区消失')
  assert.strictEqual(off!.start, 2)
  assert.strictEqual(off!.end, 9)
  assert.strictEqual(text.slice(off!.start, off!.end), r1.toString())

  // 两端都落在外层 mark 的子节点边界：外标记起点 → 内层标记之后（h 之前）
  const r2 = placeRange(outer, 0, outer, 2)
  assert.strictEqual(r2.toString(), text.slice(2, 7))
  off = selectionToOffsets(root)
  assert.ok(off, '选区完全在嵌套标记内不应返回 null')
  assert.strictEqual(off!.start, 2)
  assert.strictEqual(off!.end, 7)

  // 端点落在内层 mark 的子节点边界：inner 起点 → inner 末尾
  const r3 = placeRange(inner, 0, inner, 1)
  assert.strictEqual(r3.toString(), text.slice(4, 7))
  off = selectionToOffsets(root)
  assert.ok(off)
  assert.strictEqual(off!.start, 4)
  assert.strictEqual(off!.end, 7)

  // 内层边界 → 外层末尾边界（跨出内层但仍在外层内）
  const r4 = placeRange(inner, 1, outer, 3)
  assert.strictEqual(r4.toString(), text.slice(7, 8))
  off = selectionToOffsets(root)
  assert.ok(off)
  assert.strictEqual(off!.start, 7)
  assert.strictEqual(off!.end, 8)
})

check('反向拖选（base/extent 与文档序相反）得到同一半开区间', () => {
  const text = 'abcdefghij'
  const root = renderNested()
  const [outer] = root.querySelectorAll('mark.hl')
  const inner = root.querySelector('mark.qs-range')!
  const plain = root.lastChild as Text
  const sel = window.getSelection()!
  assert.strictEqual(typeof sel.setBaseAndExtent, 'function')

  // 正向：外层起点边界 → 普通文本
  sel.removeAllRanges()
  sel.setBaseAndExtent(outer, 0, plain, 1)
  const forward = selectionToOffsets(root)
  assert.ok(forward)
  assert.strictEqual(forward!.start, 2)
  assert.strictEqual(forward!.end, 9)

  // 反向：从普通文本往回拖到外层起点边界
  sel.removeAllRanges()
  sel.setBaseAndExtent(plain, 1, outer, 0)
  const backward = selectionToOffsets(root)
  assert.ok(backward, '反向拖选不应消失或得到全文长度')
  assert.deepStrictEqual(backward, forward)
  assert.strictEqual(text.slice(backward!.start, backward!.end), text.slice(2, 9))

  // 跨内层标记的反向拖选：内层末尾 → 外标记开头
  sel.removeAllRanges()
  sel.setBaseAndExtent(inner, 1, outer, 0)
  const back2 = selectionToOffsets(root)
  sel.removeAllRanges()
  sel.setBaseAndExtent(outer, 0, inner, 1)
  const fwd2 = selectionToOffsets(root)
  assert.ok(back2)
  assert.ok(fwd2)
  assert.deepStrictEqual(back2, fwd2)
  assert.strictEqual(fwd2!.start, 2)
  assert.strictEqual(fwd2!.end, 7)
})

check('setSelectionRange 设置后读回与浏览器可见选区一致（含嵌套标记）', () => {
  const text = 'abcdefghij'
  const root = renderNested()
  // 2/4/7/8 是外层 / 内层标记边界，10 是全文末尾
  for (const [s, e] of [
    [2, 9],
    [4, 7],
    [2, 7],
    [7, 8],
    [0, 8],
    [4, 10],
  ] as const) {
    const ok = setSelectionRange(root, s, e)
    assert.ok(ok, `嵌套结构设置选区 [${s}, ${e}) 应成功`)
    const back = selectionToOffsets(root)
    assert.ok(back, `嵌套结构读回选区 [${s}, ${e}) 应非空`)
    assert.strictEqual(back!.start, s, `起点往返 [${s}, ${e})`)
    assert.strictEqual(back!.end, e, `终点往返 [${s}, ${e})`)
    assert.strictEqual(window.getSelection()!.toString(), text.slice(s, e))
  }
})

console.log(`\n全部 ${passed} 项通过`)
