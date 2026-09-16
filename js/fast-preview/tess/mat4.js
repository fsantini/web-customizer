// Column-vector 4x4 affine transforms for tessellation-side geometry.
// The .csg dump's multmatrix() rows are already in column-vector convention
// (p' = M * p, translation in the last column of each row -- see fromRows()
// below), so no transpose is needed: fromRows() is a straight repack into
// column-major storage.
// GPL-2.0-or-later; part of the OpenSCAD fast-preview module.

export function mat4() { return new Float32Array(16); }

export function identity() {
  const m = mat4();
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

// from OpenSCAD dump form [[...4],[...4],[...4],[...4]]. The dump's matrices
// are COLUMN-convention (translation in the 4th column — see the spool dump's
// multmatrix([[1,0,0,0],[0,1,0,-37],[0,0,1,-1],[0,0,0,1]]), and rotate([45,0,0])
// dumps the standard CCW column-vector rotation block), so this is a plain
// copy into column-major storage: element (r, c) lands at m[c*4+r].
export function fromRows(rows) {
  const a = mat4();
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++)
      a[c * 4 + r] = rows[r][c];
  return a;
}

export function multiply(a, b) { // a * b
  const out = mat4();
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  return out;
}

export function translation(x, y, z) {
  const m = identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

export function transformPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

// upper-left 3x3 applied to directions (no translation)
export function transformDir(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z,
  ];
}
