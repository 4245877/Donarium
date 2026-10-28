/** Bounded ASCII/binary STL reader. Geometry stays in browser memory only. */
export function parseStl(buffer: ArrayBuffer): Float32Array {
  if (buffer.byteLength > 32 * 1024 ** 2) throw new Error('STL превышает лимит просмотра 32 МиБ');
  const view = new DataView(buffer);
  const count = buffer.byteLength >= 84 ? view.getUint32(80, true) : 0;
  let vertices: number[] = [];
  if (count > 0 && 84 + count * 50 <= buffer.byteLength) {
    if (count > 650000) throw new Error('Слишком много граней для встроенного просмотра');
    vertices = new Array(count * 9);
    for (let triangle = 0; triangle < count; triangle++) for (let axis = 0; axis < 9; axis++) {
      vertices[triangle * 9 + axis] = view.getFloat32(84 + triangle * 50 + 12 + axis * 4, true);
    }
  } else {
    const source = new TextDecoder().decode(buffer);
    if (!/^\s*solid\b/i.test(source) || !/\bendsolid\b/i.test(source)) throw new Error('Не удалось прочитать STL');
    const number = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
    const pattern = new RegExp(`\\bvertex\\s+(${number})\\s+(${number})\\s+(${number})`, 'gi');
    for (const match of source.matchAll(pattern)) {
      vertices.push(Number(match[1]), Number(match[2]), Number(match[3]));
      if (vertices.length > 650000 * 9) throw new Error('Слишком много граней для встроенного просмотра');
    }
  }
  if (!vertices.length || vertices.length % 9 || vertices.some(value => !Number.isFinite(value))) throw new Error('STL содержит некорректную геометрию');
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i++) { const axis = i % 3; min[axis] = Math.min(min[axis]!, vertices[i]!); max[axis] = Math.max(max[axis]!, vertices[i]!); }
  const size = Math.max(...max.map((value, axis) => value - min[axis]!));
  if (!Number.isFinite(size) || size <= 0) throw new Error('STL не содержит видимой геометрии');
  // Sample large meshes for responsive orbit controls; the original is unchanged.
  const step = Math.max(1, Math.ceil(vertices.length / 9 / 12000)), output: number[] = [];
  for (let i = 0; i < vertices.length; i += 9 * step) for (let j = 0; j < 9; j++) {
    const axis = j % 3;
    output.push((vertices[i + j]! - (min[axis]! + max[axis]!) / 2) / size);
  }
  return new Float32Array(output);
}
