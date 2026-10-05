"use strict";

/* ============ complex expression -> GLSL compiler ============ */

const FUNCS = {
  sin: "csin", cos: "ccos", tan: "ctan",
  sinh: "csinh", cosh: "ccosh", tanh: "ctanh",
  exp: "cexp", log: "clog", ln: "clog", sqrt: "csqrt",
  conj: "cconj", abs: "cabs", arg: "carg", re: "cre", im: "cim",
};
const CONSTS = {
  z: "z",
  i: "vec2(0.0,1.0)",
  pi: "vec2(3.14159265358979,0.0)",
  e: "vec2(2.71828182845905,0.0)",
};

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const v = src.slice(i, j);
      if (!/^\d*\.?\d*$/.test(v) || v === ".") throw new Error(`bad number "${v}"`);
      toks.push({ t: "num", v });
      i = j;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      let j = i;
      while (j < src.length && /[a-zA-Z]/.test(src[j])) j++;
      const word = src.slice(i, j).toLowerCase();
      i = j;
      if (FUNCS[word] || CONSTS[word]) { toks.push({ t: "id", v: word }); continue; }
      // split unknown runs like "iz" into single-letter constants: i*z
      for (const ch of word) {
        if (!CONSTS[ch]) throw new Error(`unknown name "${word}"`);
        toks.push({ t: "id", v: ch });
      }
      continue;
    }
    if ("+-*/^()".includes(c)) { toks.push({ t: c }); i++; continue; }
    throw new Error(`unexpected character "${c}"`);
  }
  return toks;
}

function glf(x) {
  const s = String(x);
  return /[.e]/.test(s) ? s : s + ".0";
}

// Parses tokens and returns a GLSL expression string in terms of `z`.
function compileExpr(src) {
  const toks = tokenize(src);
  if (!toks.length) throw new Error("empty expression");
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const expect = (t) => {
    const p = next();
    if (!p || p.t !== t) throw new Error(`expected "${t}"`);
  };

  function expr() {
    let a = term();
    while (peek() && (peek().t === "+" || peek().t === "-")) {
      const op = next().t;
      a = `(${a}${op}${term()})`;
    }
    return a;
  }
  function term() {
    let a = unary();
    for (;;) {
      const p = peek();
      if (p && (p.t === "*" || p.t === "/")) {
        next();
        const b = unary();
        a = p.t === "*" ? `cmul(${a},${b})` : `cdiv(${a},${b})`;
      } else if (p && (p.t === "num" || p.t === "id" || p.t === "(")) {
        a = `cmul(${a},${unary()})`; // implicit multiplication
      } else break;
    }
    return a;
  }
  function unary() {
    const p = peek();
    if (p && p.t === "-") { next(); return `(-${unary()})`; }
    if (p && p.t === "+") { next(); return unary(); }
    return power();
  }
  function power() {
    const a = atom();
    if (peek() && peek().t === "^") {
      next();
      const b = unary(); // right-associative
      // small positive integer exponents: repeated multiplication (exact at 0, no branch cut)
      const m = b.match(/^vec2\((\d+)\.0,0\.0\)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n === 0) return "vec2(1.0,0.0)";
        if (n <= 8) {
          let out = a;
          for (let k = 1; k < n; k++) out = `cmul(${out},${a})`;
          return out;
        }
      }
      return `cpow(${a},${b})`;
    }
    return a;
  }
  function atom() {
    const p = next();
    if (!p) throw new Error("unexpected end of expression");
    if (p.t === "num") return `vec2(${glf(parseFloat(p.v))},0.0)`;
    if (p.t === "(") { const e = expr(); expect(")"); return e; }
    if (p.t === "id") {
      if (FUNCS[p.v]) { expect("("); const e = expr(); expect(")"); return `${FUNCS[p.v]}(${e})`; }
      return CONSTS[p.v];
    }
    throw new Error("unexpected token");
  }

  const g = expr();
  if (pos < toks.length) throw new Error("unexpected trailing input");
  return g;
}

/* ============ WebGL: mesh of each layer pushed through f ============ */

const GRID = 192; // (GRID+1)^2 vertices, fits in Uint16 indices

const GLSL_LIB = `
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x-a.y*b.y, a.x*b.y+a.y*b.x); }
vec2 cdiv(vec2 a, vec2 b){ float d=dot(b,b); return vec2(dot(a,b), a.y*b.x-a.x*b.y)/d; }
vec2 cexp(vec2 v){ return exp(v.x)*vec2(cos(v.y), sin(v.y)); }
vec2 clog(vec2 v){ return vec2(log(length(v)), atan(v.y, v.x)); }
vec2 cpow(vec2 a, vec2 b){ return cexp(cmul(b, clog(a))); }
vec2 csin(vec2 v){ return vec2(sin(v.x)*cosh(v.y), cos(v.x)*sinh(v.y)); }
vec2 ccos(vec2 v){ return vec2(cos(v.x)*cosh(v.y), -sin(v.x)*sinh(v.y)); }
vec2 ctan(vec2 v){ return cdiv(csin(v), ccos(v)); }
vec2 csinh(vec2 v){ return vec2(sinh(v.x)*cos(v.y), cosh(v.x)*sin(v.y)); }
vec2 ccosh(vec2 v){ return vec2(cosh(v.x)*cos(v.y), sinh(v.x)*sin(v.y)); }
vec2 ctanh(vec2 v){ return cdiv(csinh(v), ccosh(v)); }
vec2 csqrt(vec2 v){ float r=length(v); return vec2(sqrt(max(0.0,(r+v.x)*0.5)), sign(v.y+1e-30)*sqrt(max(0.0,(r-v.x)*0.5))); }
vec2 cconj(vec2 v){ return vec2(v.x, -v.y); }
vec2 cabs(vec2 v){ return vec2(length(v), 0.0); }
vec2 carg(vec2 v){ return vec2(atan(v.y, v.x), 0.0); }
vec2 cre(vec2 v){ return vec2(v.x, 0.0); }
vec2 cim(vec2 v){ return vec2(v.y, 0.0); }
`;

// unit-square coords of the unrotated shape -> z: rotate uRot quarter turns CCW within the
// square, then stretch onto uRect (whose w/h the CPU already swapped for odd rotations)
const PLACE_UV = `
vec2 placeUV(vec2 uv){
  for (int k = 0; k < 3; k++) { if (k >= uRot) break; uv = vec2(1.0 - uv.y, uv.x); }
  return uRect.xy + uv * uRect.zw;
}`;

function vertexSrc(fExpr) {
  return `#version 300 es
precision highp float;
in vec2 aUV;
uniform vec4 uRect;   // layer rect in z-plane: x, y (bottom-left), w, h
uniform vec3 uView;   // w-plane view: center x, center y, half-extent
uniform int uShape;   // 0 = rect, 1 = circle (ellipse inscribed in uRect), 2 = semicircle
uniform int uRot;     // semicircle: quarter turns counter-clockwise
out vec2 vUV;
out vec2 vZ;
${GLSL_LIB}
${PLACE_UV}
vec2 f(vec2 z){ return ${fExpr}; }
void main(){
  vec2 z;
  if (uShape == 1) {
    // polar mesh: aUV.x = radius fraction, aUV.y = angle fraction
    float a = aUV.y * 6.28318530718;
    z = uRect.xy + uRect.zw * 0.5 * (1.0 + aUV.x * vec2(cos(a), sin(a)));
  } else if (uShape == 2) {
    // half-polar mesh over the upper half-disk, then rotated into place
    float a = aUV.y * 3.14159265359;
    z = placeUV(vec2(0.5 + 0.5 * aUV.x * cos(a), aUV.x * sin(a)));
  } else {
    z = uRect.xy + aUV * uRect.zw;
  }
  vec2 w = f(z);
  vUV = vec2(aUV.x, 1.0 - aUV.y);
  vZ = z;
  if (isnan(w.x) || isnan(w.y) || isinf(w.x) || isinf(w.y)) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // behind clip space -> culled
    return;
  }
  w = clamp(w, vec2(-1e5), vec2(1e5));
  vec2 p = (w - uView.xy) / uView.z;
  gl_Position = vec4(p, 0.0, 1.0);
}`;
}

// sweep animation: only the part of the z-plane with arg z in [0, uSweep] is laid down
const SWEEP_CLIP = `
void sweepClip(vec2 z){
  float a = atan(z.y, z.x);
  if (a < 0.0) a += 6.28318530718;
  if (a > uSweep) discard;
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUV;
in vec2 vZ;
uniform sampler2D uTex;
uniform int uIsGrid;
uniform vec3 uFill;
uniform vec3 uLine;
uniform float uSpacing;
uniform float uDpr;
uniform float uSweep;
out vec4 outColor;
${SWEEP_CLIP}
// coverage of the grid lines (one family per axis) at this fragment, as hairlines of
// constant screen width: distance to the nearest line is measured in device pixels
// via the screen-space gradient of z, so lines never thicken or blur under f
float hairlines(float sp){
  vec2 d = abs(fract(vZ / sp + 0.5) - 0.5) * sp;           // z-distance to nearest line
  vec2 g = vec2(length(vec2(dFdx(vZ.x), dFdy(vZ.x))),
                length(vec2(dFdx(vZ.y), dFdy(vZ.y))));     // z per device pixel
  g = max(g, vec2(1e-12));
  vec2 px = d / g;
  vec2 cov = clamp(1.0 - px, 0.0, 1.0);                     // 1 device px wide, antialiased
  cov *= smoothstep(2.0, 6.0, sp / g * (1.0 / uDpr));      // fade where lines crowd < ~4px apart
  return max(cov.x, cov.y);
}
void main(){
  sweepClip(vZ);
  if (uIsGrid == 1) {
    // world-aligned graph paper: hairlines every uSpacing
    outColor = vec4(mix(uFill, uLine, hairlines(uSpacing)), 1.0);
  } else {
    outColor = texture(uTex, vUV);
  }
}`;

// Outline of a shape pushed through f, drawn as a constant-pixel-width band.
// Each boundary segment is its own quad (6 verts) so a segment that jumps across
// a branch cut or pole can be culled whole.
const LINE_SEGS = 2048;
const LINE_HALF_PX = 1.25; // half line width, CSS px

function lineVertexSrc(fExpr) {
  return `#version 300 es
precision highp float;
in vec3 aSeg;         // segment start t in [0,1), end flag (0/1), side (-1/+1)
uniform vec4 uRect;
uniform vec3 uView;
uniform int uShape;
uniform int uRot;
uniform float uStep;  // boundary parameter per segment
uniform float uHalfW; // half line width, clip units
out vec2 vZ;
${GLSL_LIB}
${PLACE_UV}
vec2 f(vec2 z){ return ${fExpr}; }
vec2 boundary(float t){
  // segment from uRect.xy along the signed vector uRect.zw; open, so no wrap-around
  if (uShape == 3) return uRect.xy + clamp(t, 0.0, 1.0) * uRect.zw;
  t = fract(t);
  if (uShape == 1) {
    float a = t * 6.28318530718;
    return uRect.xy + uRect.zw * 0.5 * (1.0 + vec2(cos(a), sin(a)));
  }
  if (uShape == 2) {
    // arc (right end -> left end), then the diameter back; split by arc length
    const float PI = 3.14159265359, TA = PI / (PI + 2.0);
    if (t < TA) { float a = t / TA * PI; return placeUV(vec2(0.5 + 0.5 * cos(a), sin(a))); }
    return placeUV(vec2((t - TA) / (1.0 - TA), 0.0));
  }
  // rect, counter-clockwise from bottom-left
  float s = t * 4.0, side = floor(s), u = s - side;
  vec2 p0 = uRect.xy, p1 = uRect.xy + vec2(uRect.z, 0.0);
  vec2 p2 = uRect.xy + uRect.zw, p3 = uRect.xy + vec2(0.0, uRect.w);
  if (side < 1.0) return mix(p0, p1, u);
  if (side < 2.0) return mix(p1, p2, u);
  if (side < 3.0) return mix(p2, p3, u);
  return mix(p3, p0, u);
}
bool bad(vec2 w){ return isnan(w.x) || isnan(w.y) || isinf(w.x) || isinf(w.y); }
vec2 toClip(vec2 w){ return (clamp(w, vec2(-1e5), vec2(1e5)) - uView.xy) / uView.z; }
const float JUMP = 0.5; // clip-space segment length treated as a discontinuity
void main(){
  float t = aSeg.x + aSeg.y * uStep;
  vZ = boundary(t);
  vec2 wa = f(boundary(t - uStep)), wc = f(vZ), wb = f(boundary(t + uStep));
  vec2 pa = toClip(wa), pc = toClip(wc), pb = toClip(wb);
  // the other end of this vertex's own segment
  bool partnerBad = aSeg.y < 0.5 ? bad(wb) : bad(wa);
  vec2 partner = aSeg.y < 0.5 ? pb : pa;
  if (bad(wc) || partnerBad || length(partner - pc) > JUMP) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  vec2 da = pc - pa, db = pb - pc;
  float la = length(da), lb = length(db);
  bool okA = !bad(wa) && la > 1e-9 && la < JUMP;
  bool okB = !bad(wb) && lb > 1e-9 && lb < JUMP;
  vec2 na = okA ? vec2(-da.y, da.x) / la : vec2(0.0);
  vec2 nb = okB ? vec2(-db.y, db.x) / lb : vec2(0.0);
  vec2 n = okA ? na : nb;
  if (okA && okB) {
    // miter join
    vec2 m = na + nb;
    float ml = length(m);
    if (ml > 1e-6) { n = m / ml; n /= max(dot(n, na), 0.25); }
  }
  gl_Position = vec4(pc + n * aSeg.z * uHalfW, 0.0, 1.0);
}`;
}

const LINE_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vZ;
uniform vec3 uColor;
uniform vec4 uTint;   // rgb + alpha override (alpha 0 = use uColor)
uniform float uSweep;
out vec4 outColor;
${SWEEP_CLIP}
void main(){
  sweepClip(vZ);
  outColor = uTint.a > 0.0 ? uTint : vec4(uColor, 1.0);
}`;

/* ============ app state ============ */

const leftCv = document.getElementById("left");
const rightCv = document.getElementById("right");
const overlayCv = document.getElementById("rightOverlay");

// render at device resolution, lay out / do math in CSS pixels
const DPR = Math.min(3, window.devicePixelRatio || 1);
const CSSW = 520;
for (const cv of [leftCv, rightCv, overlayCv]) {
  cv.width = cv.height = Math.round(CSSW * DPR);
  cv.style.width = cv.style.height = CSSW + "px";
}

const lctx = leftCv.getContext("2d");
const octx = overlayCv.getContext("2d");
lctx.setTransform(DPR, 0, 0, DPR, 0, 0);
octx.setTransform(DPR, 0, 0, DPR, 0, 0);
const gl = rightCv.getContext("webgl2", { antialias: true });

let fnInput = document.getElementById("fn");
const errEl = document.getElementById("err");
const photosEl = document.getElementById("photos");
const shapesEl = document.getElementById("shapes");

const state = {
  palette: [],                              // {id, source, aspect, tex}
  layers: [],                               // {item, rect:{x,y,w,h}, filled} in draw order
  selected: null,                           // a layer, or null
  sweep: null,                              // sweep animation angle, or null when not sweeping
  leftView: { cx: 0, cy: 0, half: 3 },
  rightView: { cx: 0, cy: 0, half: 4 },
  program: null,
  uRect: null, uView: null,
};

if (!gl) {
  errEl.textContent = "WebGL2 not available in this browser.";
  throw new Error("no webgl2");
}

/* ---- mesh ---- */
const N = GRID + 1;
const uvs = new Float32Array(N * N * 2);
for (let r = 0; r < N; r++)
  for (let c = 0; c < N; c++) {
    uvs[(r * N + c) * 2] = c / GRID;
    uvs[(r * N + c) * 2 + 1] = r / GRID;
  }
const idx = new Uint16Array(GRID * GRID * 6);
let k = 0;
for (let r = 0; r < GRID; r++)
  for (let c = 0; c < GRID; c++) {
    const a = r * N + c, b = a + 1, d = a + N, e = d + 1;
    idx[k++] = a; idx[k++] = b; idx[k++] = d;
    idx[k++] = b; idx[k++] = e; idx[k++] = d;
  }
const uvBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
const idxBuf = gl.createBuffer();
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);

// outline band: 6 verts per boundary segment, each (t0, endFlag, side)
const LINE_CORNERS = [[0, -1], [0, 1], [1, -1], [1, -1], [0, 1], [1, 1]];
const lineVerts = new Float32Array(LINE_SEGS * 6 * 3);
k = 0;
for (let sg = 0; sg < LINE_SEGS; sg++)
  for (const [end, side] of LINE_CORNERS) {
    lineVerts[k++] = sg / LINE_SEGS; lineVerts[k++] = end; lineVerts[k++] = side;
  }
const lineBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
gl.bufferData(gl.ARRAY_BUFFER, lineVerts, gl.STATIC_DRAW);

// both programs bind their single attribute to location 0
const vaoFill = gl.createVertexArray();
gl.bindVertexArray(vaoFill);
gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
const vaoLine = gl.createVertexArray();
gl.bindVertexArray(vaoLine);
gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
gl.bindVertexArray(null);

gl.enable(gl.BLEND);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

/* ---- palette ---- */
let nextId = 1;

function makeTexture(source) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.generateMipmap(gl.TEXTURE_2D);
  return t;
}

function paletteDom(item, thumbCanvas, label, sectionEl) {
  const isPhoto = item.kind === "photo";
  const div = document.createElement("div");
  div.className = isPhoto ? "pitem photo" : "pitem";
  div.draggable = true;
  div.title = label + " — drag onto the z-plane";
  div.appendChild(thumbCanvas);
  div.addEventListener("dragstart", (ev) => {
    ev.dataTransfer.setData("text/plain", String(item.id));
    ev.dataTransfer.effectAllowed = "copy";
  });
  if (isPhoto) {
    const del = document.createElement("button");
    del.className = "pdel";
    del.textContent = "✕";
    del.title = "remove from palette";
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      removePaletteItem(item, div);
    });
    div.appendChild(del);
  } else {
    // color (bottom-left) and filled / outline (bottom-right) toggles: set how this tile lands
    const col = document.createElement("button");
    col.className = "pcolor";
    col.title = "color — click to cycle";
    const tog = document.createElement("button");
    tog.className = "pfill";
    const sync = () => {
      col.style.background = COLORS[item.color].fillCss;
      tog.textContent = item.filled ? "●" : "○";
      tog.title = item.filled ? "filled — click for outline only" : "outline — click for filled";
      drawShapeThumb(thumbCanvas, item);
    };
    col.addEventListener("click", (ev) => {
      ev.stopPropagation();
      item.color = (item.color + 1) % COLORS.length;
      sync();
      scheduleSave();
    });
    tog.addEventListener("click", (ev) => {
      ev.stopPropagation();
      item.filled = !item.filled;
      sync();
      scheduleSave();
    });
    item.syncToggle = sync;
    sync();
    div.appendChild(col);
    if (item.shape !== "line") div.appendChild(tog);
  }
  sectionEl.appendChild(div);
}

function addPhotoItem(source, label, dataURL) {
  const item = {
    id: nextId++,
    kind: "photo",
    source,
    aspect: source.height / source.width,
    tex: makeTexture(source),
    dataURL: dataURL || null, // cached serialized form for persistence
  };
  state.palette.push(item);
  const thumb = document.createElement("canvas");
  // fit inside 72x72 preserving aspect (no letterbox box around photos)
  const cssW = item.aspect >= 1 ? Math.max(1, Math.round(72 / item.aspect)) : 72;
  const cssH = item.aspect >= 1 ? 72 : Math.max(1, Math.round(72 * item.aspect));
  thumb.width = Math.round(cssW * DPR);
  thumb.height = Math.round(cssH * DPR);
  thumb.style.width = cssW + "px";
  thumb.style.height = cssH + "px";
  thumb.getContext("2d").drawImage(source, 0, 0, thumb.width, thumb.height);
  paletteDom(item, thumb, label, photosEl);
  return item;
}

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// grid colors: fill, line base color, line opacity over the fill
const COLORS = [
  ["#e8eaee", "#000000", 0.35],
  ["#e0483f", "#ffffff", 0.55],
  ["#2e9e58", "#ffffff", 0.55],
  ["#3672e0", "#ffffff", 0.55],
  ["#8b5cf6", "#ffffff", 0.55],
].map(([fillHex, lineHex, lineAlpha]) => {
  const fill = hexToRgb(fillHex);
  const base = hexToRgb(lineHex);
  const line = fill.map((c, i) => Math.round(c * (1 - lineAlpha) + base[i] * lineAlpha));
  return {
    fill: fill.map((c) => c / 255),
    line: line.map((c) => c / 255),
    fillCss: fillHex,
    lineCss: `rgb(${line.join(",")})`,
    thumbLineCss: `rgba(${base.join(",")},${lineAlpha})`,
  };
});

const SHAPE_ASPECT = { rect: 1, circle: 1, semicircle: 0.5, line: 0 }; // h / w, unrotated
const SHAPE_ID = { rect: 0, circle: 1, semicircle: 2, line: 3 };     // uShape in the shaders

function addShapeItem(shape, color, label) {
  const item = {
    id: nextId++,
    kind: "grid",
    shape,                                  // "rect" | "circle" | "semicircle" | "line"
    color,                                  // palette toggles: how new layers land
    filled: true,
    aspect: SHAPE_ASPECT[shape],
  };
  state.palette.push(item);
  const thumb = document.createElement("canvas");
  thumb.width = thumb.height = Math.round(72 * DPR);
  thumb.style.width = thumb.style.height = "72px";
  paletteDom(item, thumb, label, shapesEl);
  return item;
}

function removePaletteItem(item, div) {
  state.layers = state.layers.filter((l) => l.item !== item);
  if (state.selected && state.selected.item === item) state.selected = null;
  const i = state.palette.indexOf(item);
  if (i >= 0) state.palette.splice(i, 1);
  if (item.tex) gl.deleteTexture(item.tex);
  div.remove();
  renderAll();
}

// spacing of the world-aligned "graph paper" grids, in z-plane units
const GRID_SPACING = 0.25;

// 72px (device-resolution) thumbnail drawn at thumb scale so the gridding is visible
function drawShapeThumb(c, item) {
  const S = c.width;
  const g = c.getContext("2d");
  const col = COLORS[item.color];
  g.clearRect(0, 0, S, S);
  const outlinePath = (m) => {
    g.beginPath();
    if (item.shape === "circle") g.arc(S / 2, S / 2, S / 2 - m, 0, 2 * Math.PI);
    else if (item.shape === "semicircle") {
      g.arc(S / 2, S * 0.75 - m / 2, S / 2 - m, Math.PI, 2 * Math.PI);
      g.closePath();
    } else g.rect(m, m, S - 2 * m, S - 2 * m);
  };
  if (item.shape === "line") {
    g.strokeStyle = col.fillCss;
    g.lineWidth = 3 * DPR;
    g.lineCap = "round";
    g.beginPath(); g.moveTo(12 * DPR, S - 12 * DPR); g.lineTo(S - 12 * DPR, 12 * DPR); g.stroke();
    return;
  }
  if (!item.filled) {
    g.strokeStyle = col.fillCss;
    g.lineWidth = 3 * DPR;
    outlinePath(8 * DPR);
    g.stroke();
    return;
  }
  g.save();
  if (item.shape !== "rect") {
    outlinePath(DPR);
    g.clip();
  }
  const line = col.thumbLineCss;
  g.fillStyle = col.fillCss;
  g.fillRect(0, 0, S, S);
  g.strokeStyle = line;
  g.lineWidth = DPR;
  for (let t = 0; t <= S; t += S / 4) {
    const p = Math.min(S - g.lineWidth, Math.max(g.lineWidth / 2, t));
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, S); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(S, p); g.stroke();
  }
  g.beginPath(); g.moveTo(S / 2, 0); g.lineTo(S / 2, S); g.stroke();
  g.beginPath(); g.moveTo(0, S / 2); g.lineTo(S, S / 2); g.stroke();
  g.restore();
}


/* ---- layers ---- */
function addLayer(item, cx, cy, width) {
  const w = width || state.leftView.half * 0.66;
  const h = w * item.aspect;
  const layer = { item, rect: { x: cx - w / 2, y: cy - h / 2, w, h }, filled: true, color: 0, rot: 0 };
  if (item.kind === "grid") { layer.filled = item.filled; layer.color = item.color; }
  state.layers.push(layer);
  state.selected = layer;
  renderAll();
  return layer;
}

function deleteLayer(layer) {
  const i = state.layers.indexOf(layer);
  if (i >= 0) state.layers.splice(i, 1);
  if (state.selected === layer) state.selected = null;
  renderAll();
}

/* ---- shader ---- */
function compileShader(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(log);
  }
  return s;
}

function linkProgram(vsSrc, fsSrc, attrib) {
  const vs = compileShader(gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.bindAttribLocation(prog, 0, attrib);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(log);
  }
  return prog;
}

function setFunction(src) {
  const expr = compileExpr(src); // throws on parse error
  const prog = linkProgram(vertexSrc(expr), FRAG_SRC, "aUV");
  let lprog;
  try {
    lprog = linkProgram(lineVertexSrc(expr), LINE_FRAG_SRC, "aSeg");
  } catch (e) {
    gl.deleteProgram(prog);
    throw e;
  }
  if (state.program) gl.deleteProgram(state.program);
  if (state.lineProgram) gl.deleteProgram(state.lineProgram);
  state.program = prog;
  state.uRect = gl.getUniformLocation(prog, "uRect");
  state.uView = gl.getUniformLocation(prog, "uView");
  state.uShape = gl.getUniformLocation(prog, "uShape");
  state.uRot = gl.getUniformLocation(prog, "uRot");
  state.uSweep = gl.getUniformLocation(prog, "uSweep");
  state.uIsGrid = gl.getUniformLocation(prog, "uIsGrid");
  state.uFill = gl.getUniformLocation(prog, "uFill");
  state.uLine = gl.getUniformLocation(prog, "uLine");
  state.uSpacing = gl.getUniformLocation(prog, "uSpacing");
  state.uDpr = gl.getUniformLocation(prog, "uDpr");
  const u = (n) => gl.getUniformLocation(lprog, n);
  state.lineProgram = lprog;
  state.lu = {
    rect: u("uRect"), view: u("uView"), shape: u("uShape"), rot: u("uRot"),
    step: u("uStep"), halfW: u("uHalfW"), color: u("uColor"),
    tint: u("uTint"), sweep: u("uSweep"),
  };
}

/* ---- rendering ---- */
function renderRight() {
  gl.viewport(0, 0, rightCv.width, rightCv.height);
  gl.clearColor(0.05, 0.06, 0.07, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (state.program) {
    const v = state.rightView;
    const sweep = state.sweep ?? 10; // > 2π: everything visible
    const lu = state.lu;
    const drawOutline = (rect, shape, rot, rgb, tint, sw) => {
      gl.useProgram(state.lineProgram);
      gl.bindVertexArray(vaoLine);
      gl.uniform3f(lu.view, v.cx, v.cy, v.half);
      gl.uniform4f(lu.rect, rect.x, rect.y, rect.w, rect.h);
      gl.uniform1i(lu.shape, shape);
      gl.uniform1i(lu.rot, rot);
      gl.uniform1f(lu.step, 1 / LINE_SEGS);
      gl.uniform1f(lu.halfW, LINE_HALF_PX * 2 / CSSW);
      gl.uniform3f(lu.color, rgb[0], rgb[1], rgb[2]);
      gl.uniform4f(lu.tint, ...(tint || [0, 0, 0, 0]));
      gl.uniform1f(lu.sweep, sw);
      gl.drawArrays(gl.TRIANGLES, 0, LINE_SEGS * 6);
    };
    for (const layer of state.layers) {
      const r = layer.rect, it = layer.item;
      const shape = SHAPE_ID[it.shape] || 0;
      const col = COLORS[layer.color];
      if (!layer.filled || it.shape === "line") {
        drawOutline(r, shape, layer.rot, col.fill, null, sweep);
        continue;
      }
      gl.useProgram(state.program);
      gl.bindVertexArray(vaoFill);
      gl.uniform3f(state.uView, v.cx, v.cy, v.half);
      gl.uniform4f(state.uRect, r.x, r.y, r.w, r.h);
      gl.uniform1i(state.uShape, shape);
      gl.uniform1i(state.uRot, layer.rot);
      gl.uniform1f(state.uSweep, sweep);
      if (it.kind === "grid") {
        gl.uniform1i(state.uIsGrid, 1);
        gl.uniform3f(state.uFill, col.fill[0], col.fill[1], col.fill[2]);
        gl.uniform3f(state.uLine, col.line[0], col.line[1], col.line[2]);
        gl.uniform1f(state.uSpacing, GRID_SPACING);
        gl.uniform1f(state.uDpr, DPR);
      } else {
        gl.uniform1i(state.uIsGrid, 0);
        gl.bindTexture(gl.TEXTURE_2D, it.tex);
      }
      gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_SHORT, 0);
    }
    if (state.sweep !== null) {
      // image of the sweeping ray arg z = θ, long enough to cross the whole z-plane view
      const lv = state.leftView;
      const R = Math.hypot(Math.abs(lv.cx) + lv.half, Math.abs(lv.cy) + lv.half);
      const ray = { x: 0, y: 0, w: R * Math.cos(state.sweep), h: R * Math.sin(state.sweep) };
      drawOutline(ray, SHAPE_ID.line, 0, [1, 1, 1], [1, 1, 1, 0.75], 10);
    }
    gl.bindVertexArray(null);
  }
  drawAxes(octx, overlayCv, state.rightView, true);
  scheduleSave();
}

function worldToPix(view, cv, x, y) {
  const ppu = CSSW / (2 * view.half);
  return [(x - view.cx) * ppu + CSSW / 2, CSSW / 2 - (y - view.cy) * ppu];
}
function pixToWorld(view, cv, px, py) {
  const ppu = CSSW / (2 * view.half);
  return [(px - CSSW / 2) / ppu + view.cx, view.cy - (py - CSSW / 2) / ppu];
}

function drawAxes(ctx, cv, view, overlay) {
  if (overlay) ctx.clearRect(0, 0, CSSW, CSSW);
  const step = niceStep(view.half);
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.font = "11px sans-serif";
  ctx.lineWidth = 1;
  const x0 = view.cx - view.half, x1 = view.cx + view.half;
  const y0 = view.cy - view.half, y1 = view.cy + view.half;
  for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
    const [px] = worldToPix(view, cv, x, 0);
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, CSSW); ctx.stroke();
    if (Math.abs(x) > step / 2) ctx.fillText(fmt(x), px + 3, worldToPix(view, cv, 0, 0)[1] - 4);
  }
  for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
    const [, py] = worldToPix(view, cv, 0, y);
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(CSSW, py); ctx.stroke();
    if (Math.abs(y) > step / 2) ctx.fillText(fmt(y) + "i", worldToPix(view, cv, 0, 0)[0] + 4, py - 3);
  }
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  const [ax] = worldToPix(view, cv, 0, 0);
  const [, ay] = worldToPix(view, cv, 0, 0);
  ctx.beginPath(); ctx.moveTo(ax, 0); ctx.lineTo(ax, CSSW); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, ay); ctx.lineTo(CSSW, ay); ctx.stroke();
  ctx.restore();
}
function niceStep(half) {
  const raw = half / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag;
}
function fmt(x) {
  return Math.abs(x) >= 1000 || (Math.abs(x) < 0.001 && x !== 0)
    ? x.toExponential(0)
    : +x.toFixed(3) + "";
}

const SNAP_PX = 8;     // axis snapping distance, px (hold ⌥ to disable)
const HANDLE = 5;      // half-size of corner handle, px
const HANDLE_HIT = 9;  // hit-test radius, px

// corners of a layer in pixel coords, order: BL, BR, TL, TR (world orientation)
// (lines: just the two endpoints)
function layerCornersPix(layer) {
  const r = layer.rect, v = state.leftView;
  if (layer.item.shape === "line")
    return [worldToPix(v, leftCv, r.x, r.y), worldToPix(v, leftCv, r.x + r.w, r.y + r.h)];
  return [
    worldToPix(v, leftCv, r.x, r.y),
    worldToPix(v, leftCv, r.x + r.w, r.y),
    worldToPix(v, leftCv, r.x, r.y + r.h),
    worldToPix(v, leftCv, r.x + r.w, r.y + r.h),
  ];
}
function hitCorner(layer, px, py) {
  if (!layer) return -1;
  const cs = layerCornersPix(layer);
  for (let c = 0; c < cs.length; c++) {
    if (Math.abs(px - cs[c][0]) <= HANDLE_HIT && Math.abs(py - cs[c][1]) <= HANDLE_HIT) return c;
  }
  return -1;
}
function layerAt(wx, wy) {
  for (let i = state.layers.length - 1; i >= 0; i--) {
    const l = state.layers[i], r = l.rect;
    if (l.item.shape === "line") {
      const len2 = r.w * r.w + r.h * r.h;
      const t = len2 ? Math.max(0, Math.min(1, ((wx - r.x) * r.w + (wy - r.y) * r.h) / len2)) : 0;
      const tol = 6 * (2 * state.leftView.half) / CSSW;
      if (Math.hypot(wx - r.x - t * r.w, wy - r.y - t * r.h) <= tol) return l;
    } else if (l.item.shape === "circle") {
      const dx = (wx - r.x - r.w / 2) / (r.w / 2), dy = (wy - r.y - r.h / 2) / (r.h / 2);
      if (dx * dx + dy * dy <= 1) return l;
    } else if (l.item.shape === "semicircle") {
      // back to the unrotated unit square (inverse of placeUV's quarter turns)
      let u = (wx - r.x) / r.w, v = (wy - r.y) / r.h;
      for (let k = 0; k < l.rot; k++) [u, v] = [v, 1 - u];
      if (v >= 0 && (2 * u - 1) ** 2 + v * v <= 1) return l;
    } else if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) return l;
  }
  return null;
}

// unit-square coords of the unrotated shape -> world (mirrors the shaders' placeUV)
function placeUV(layer, u, v) {
  for (let k = 0; k < layer.rot; k++) [u, v] = [1 - v, u];
  const r = layer.rect;
  return [r.x + u * r.w, r.y + v * r.h];
}

// adds the layer's outline (rect, inscribed ellipse or semicircle) to the current path
function shapePath(ctx, layer, px, py, pw, ph) {
  ctx.beginPath();
  if (layer.item.shape === "circle") ctx.ellipse(px + pw / 2, py + ph / 2, pw / 2, ph / 2, 0, 0, 2 * Math.PI);
  else if (layer.item.shape === "semicircle") {
    for (let i = 0; i <= 96; i++) {
      const a = Math.PI * i / 96;
      const [x, y] = placeUV(layer, 0.5 + 0.5 * Math.cos(a), Math.sin(a));
      const [sx, sy] = worldToPix(state.leftView, leftCv, x, y);
      i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
    }
    ctx.closePath();
  } else ctx.rect(px, py, pw, ph);
}

function renderLeft() {
  const v = state.leftView;
  lctx.clearRect(0, 0, CSSW, CSSW);
  drawAxes(lctx, leftCv, v, false);
  const ppu = CSSW / (2 * v.half);
  for (const layer of state.layers) {
    const r = layer.rect;
    const [px, py] = worldToPix(v, leftCv, r.x, r.y + r.h);
    if (layer.item.shape === "line") {
      const [ax, ay] = worldToPix(v, leftCv, r.x, r.y);
      const [bx, by] = worldToPix(v, leftCv, r.x + r.w, r.y + r.h);
      lctx.strokeStyle = COLORS[layer.color].fillCss;
      lctx.lineWidth = LINE_HALF_PX * 2;
      lctx.lineCap = "round";
      lctx.beginPath(); lctx.moveTo(ax, ay); lctx.lineTo(bx, by); lctx.stroke();
    } else if (layer.item.kind === "grid" && !layer.filled) {
      shapePath(lctx, layer, px, py, r.w * ppu, r.h * ppu);
      lctx.strokeStyle = COLORS[layer.color].fillCss;
      lctx.lineWidth = LINE_HALF_PX * 2;
      lctx.stroke();
    } else if (layer.item.kind === "grid") {
      drawGridWindow(layer, px, py, r.w * ppu, r.h * ppu);
    } else {
      lctx.drawImage(layer.item.source, px, py, r.w * ppu, r.h * ppu);
    }
  }
  if (state.selected) {
    const r = state.selected.rect;
    const [px, py] = worldToPix(v, leftCv, r.x, r.y + r.h);
    lctx.strokeStyle = "rgba(120,170,255,0.9)";
    lctx.lineWidth = 1.5;
    if (state.selected.item.shape !== "line") lctx.strokeRect(px, py, r.w * ppu, r.h * ppu);
    lctx.fillStyle = "#fff";
    lctx.strokeStyle = "rgba(0,0,0,0.5)";
    lctx.lineWidth = 1;
    for (const [cx, cy] of layerCornersPix(state.selected)) {
      lctx.beginPath();
      lctx.rect(cx - HANDLE, cy - HANDLE, HANDLE * 2, HANDLE * 2);
      lctx.fill();
      lctx.stroke();
    }
  }
  if (state.sweep !== null) {
    // the sweeping ray arg z = θ from the origin
    const [ox, oy] = worldToPix(v, leftCv, 0, 0);
    const far = 4 * CSSW;
    lctx.strokeStyle = "rgba(255,255,255,0.75)";
    lctx.lineWidth = 1.5;
    lctx.beginPath();
    lctx.moveTo(ox, oy);
    lctx.lineTo(ox + far * Math.cos(state.sweep), oy - far * Math.sin(state.sweep));
    lctx.stroke();
  }
  scheduleSave();
}

// draw a grid layer in the z-plane as a window onto the fixed world-aligned grid
function drawGridWindow(layer, px, py, pw, ph) {
  const v = state.leftView, r = layer.rect, col = COLORS[layer.color];
  // hairlines: one device pixel wide at any zoom, snapped to pixel centers
  const snap = (p) => (Math.floor(p * DPR) + 0.5) / DPR;
  lctx.save();
  shapePath(lctx, layer, px, py, pw, ph);
  lctx.clip();
  lctx.fillStyle = col.fillCss;
  lctx.fillRect(px, py, pw, ph);
  lctx.strokeStyle = col.lineCss;
  lctx.lineWidth = 1 / DPR;
  const sp = GRID_SPACING;
  if (sp * CSSW / (2 * v.half) >= 3) { // skip when lines would crowd into a solid wash
    lctx.beginPath();
    for (let x = Math.ceil(r.x / sp) * sp; x <= r.x + r.w; x += sp) {
      const gx = snap(worldToPix(v, leftCv, x, 0)[0]);
      lctx.moveTo(gx, py); lctx.lineTo(gx, py + ph);
    }
    for (let y = Math.ceil(r.y / sp) * sp; y <= r.y + r.h; y += sp) {
      const gy = snap(worldToPix(v, leftCv, 0, y)[1]);
      lctx.moveTo(px, gy); lctx.lineTo(px + pw, gy);
    }
    lctx.stroke();
  }
  lctx.restore();
}

function renderAll() { renderLeft(); renderRight(); }

/* ---- persistence (localStorage; survives reloads) ---- */
const SAVE_KEY = "complexmap.v1";

function currentLatex() {
  return fnInput.value ?? (fnInput.textContent || "").trim();
}

function shrinkToDataURL(src) {
  const maxD = 1024;
  const scale = Math.min(1, maxD / Math.max(src.width, src.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(src.width * scale));
  c.height = Math.max(1, Math.round(src.height * scale));
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85);
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 500);
}

function saveState() {
  try {
    const grids = state.palette.filter((p) => p.kind === "grid");
    const photos = state.palette.filter((p) => p.kind === "photo");
    const data = {
      fn: currentLatex(),
      leftView: state.leftView,
      rightView: state.rightView,
      photos: photos.map((p) => ({ url: p.dataURL || (p.dataURL = shrinkToDataURL(p.source)) })),
      tiles: grids.map((g) => ({ shape: g.shape, color: g.color, filled: g.filled })),
      layers: state.layers.map((l) =>
        l.item.kind === "grid"
          ? { kind: "shape", shape: l.item.shape, color: l.color, filled: l.filled, rot: l.rot, rect: l.rect }
          : { kind: "photo", i: photos.indexOf(l.item), rect: l.rect }
      ),
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch (e) {
    // best-effort: quota exceeded or storage disabled — keep the app working
  }
}

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(SAVE_KEY));
  } catch (e) {
    return null;
  }
}

/* ---- z-plane interactions ---- */
let drag = null;

// Snap a rect's position along one axis so its low edge, centroid or high edge sits on
// the axis (coordinate 0). Returns the adjusted low coordinate, or null if nothing is close.
function snapSpan(lo, size, enabled) {
  if (!enabled) return null;
  const tol = SNAP_PX * (2 * state.leftView.half) / CSSW;
  let best = null, bestD = tol;
  for (const off of [0, size / 2, size]) {
    const d = Math.abs(lo + off);
    if (d <= bestD) { bestD = d; best = -off; }
  }
  return best;
}
// Snap a single coordinate (a dragged edge) onto the axis.
function snapCoord(c, enabled) {
  const tol = SNAP_PX * (2 * state.leftView.half) / CSSW;
  return enabled && Math.abs(c) <= tol ? 0 : null;
}
leftCv.addEventListener("pointerdown", (ev) => {
  const [wx, wy] = pixToWorld(state.leftView, leftCv, ev.offsetX, ev.offsetY);
  const corner = hitCorner(state.selected, ev.offsetX, ev.offsetY);
  if (corner >= 0 && state.selected.item.shape === "line") {
    drag = { mode: "endpoint", layer: state.selected, end: corner };
  } else if (corner >= 0) {
    const r = state.selected.rect;
    // anchor = opposite corner stays fixed
    const anchorX = corner & 1 ? r.x : r.x + r.w;
    const anchorY = corner & 2 ? r.y : r.y + r.h;
    drag = { mode: "resize", layer: state.selected, anchorX, anchorY, aspect: r.h / r.w,
             lockAspect: state.selected.item.shape === "circle" || state.selected.item.shape === "semicircle" };
  } else {
    const layer = layerAt(wx, wy);
    if (layer) {
      state.selected = layer;
      // offset from pointer to rect origin, so snapping never accumulates drift
      drag = { mode: "layer", layer, ox: layer.rect.x - wx, oy: layer.rect.y - wy };
      leftCv.style.cursor = "grabbing";
    } else {
      state.selected = null;
      drag = { mode: "pan", px: ev.offsetX, py: ev.offsetY };
    }
    renderAll();
  }
  leftCv.setPointerCapture(ev.pointerId);
});
leftCv.addEventListener("pointermove", (ev) => {
  if (!drag) {
    const c = hitCorner(state.selected, ev.offsetX, ev.offsetY);
    const [wx, wy] = pixToWorld(state.leftView, leftCv, ev.offsetX, ev.offsetY);
    leftCv.style.cursor = c >= 0
      ? (state.selected.item.shape === "line" ? "move" : c === 0 || c === 3 ? "nesw-resize" : "nwse-resize")
      : (layerAt(wx, wy) ? "grab" : "default");
    return;
  }
  if (drag.mode === "endpoint") {
    let [wx, wy] = pixToWorld(state.leftView, leftCv, ev.offsetX, ev.offsetY);
    wx = snapCoord(wx, !ev.altKey) ?? wx;
    wy = snapCoord(wy, !ev.altKey) ?? wy;
    const r = drag.layer.rect;
    if (drag.end === 0) {
      // move the start, keep the end fixed
      const ex = r.x + r.w, ey = r.y + r.h;
      r.x = wx; r.y = wy; r.w = ex - wx; r.h = ey - wy;
    } else {
      r.w = wx - r.x; r.h = wy - r.y;
    }
    renderAll();
    return;
  }
  if (drag.mode === "resize") {
    let [wx, wy] = pixToWorld(state.leftView, leftCv, ev.offsetX, ev.offsetY);
    const r = drag.layer.rect;
    const min = state.leftView.half * 0.02;
    // edge snapping: the dragged corner's edges land on the axes
    const sx = snapCoord(wx, !ev.altKey), sy = snapCoord(wy, !ev.altKey);
    if (sx !== null) wx = sx;
    if (sy !== null) wy = sy;
    if (ev.shiftKey || drag.lockAspect) {
      // keep the aspect ratio the rect had when the drag started
      r.w = Math.max(min, Math.max(Math.abs(wx - drag.anchorX), Math.abs(wy - drag.anchorY) / drag.aspect));
      r.h = r.w * drag.aspect;
    } else {
      r.w = Math.max(min, Math.abs(wx - drag.anchorX));
      r.h = Math.max(min, Math.abs(wy - drag.anchorY));
    }
    r.x = wx < drag.anchorX ? drag.anchorX - r.w : drag.anchorX;
    r.y = wy < drag.anchorY ? drag.anchorY - r.h : drag.anchorY;
    renderAll();
    return;
  }
  if (drag.mode === "layer") {
    const [wx, wy] = pixToWorld(state.leftView, leftCv, ev.offsetX, ev.offsetY);
    const r = drag.layer.rect;
    const x = wx + drag.ox, y = wy + drag.oy;
    // edge + centroid snapping to the imaginary (x = 0) and real (y = 0) axes
    const sx = snapSpan(x, r.w, !ev.altKey), sy = snapSpan(y, r.h, !ev.altKey);
    r.x = sx ?? x;
    r.y = sy ?? y;
    renderAll();
    return;
  }
  const ppu = CSSW / (2 * state.leftView.half);
  state.leftView.cx -= (ev.offsetX - drag.px) / ppu;
  state.leftView.cy += (ev.offsetY - drag.py) / ppu;
  drag.px = ev.offsetX; drag.py = ev.offsetY;
  renderAll();
});
const endDrag = () => { drag = null; leftCv.style.cursor = "default"; };
leftCv.addEventListener("pointerup", endDrag);
leftCv.addEventListener("pointercancel", endDrag);

// pinch gestures arrive as ctrlKey wheel events with tiny deltas — boost them
const zoomFactor = (ev) => Math.exp(ev.deltaY * (ev.ctrlKey ? 0.012 : 0.0015));

leftCv.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  const v = state.leftView;
  const [wx, wy] = pixToWorld(v, leftCv, ev.offsetX, ev.offsetY);
  const f = zoomFactor(ev);
  v.half = Math.min(1e4, Math.max(1e-4, v.half * f));
  const [wx2, wy2] = pixToWorld(v, leftCv, ev.offsetX, ev.offsetY);
  v.cx += wx - wx2; v.cy += wy - wy2;
  renderLeft();
}, { passive: false });

/* drop from palette */
leftCv.addEventListener("dragover", (ev) => {
  ev.preventDefault();
  ev.dataTransfer.dropEffect = "copy";
});
leftCv.addEventListener("drop", (ev) => {
  ev.preventDefault();
  const id = parseInt(ev.dataTransfer.getData("text/plain"), 10);
  const item = state.palette.find((p) => p.id === id);
  if (!item) return;
  const [wx, wy] = pixToWorld(state.leftView, leftCv, ev.offsetX, ev.offsetY);
  addLayer(item, wx, wy);
});

window.addEventListener("keydown", (ev) => {
  if (document.activeElement === fnInput) return;
  if ((ev.key === "r" || ev.key === "R") && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
    const l = state.selected;
    if (l && l.item.shape === "semicircle") {
      const r = l.rect, cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      l.rot = (l.rot + 1) % 4;
      [r.w, r.h] = [r.h, r.w];
      r.x = cx - r.w / 2; r.y = cy - r.h / 2;
      renderAll();
    }
    return;
  }
  if ((ev.key === "f" || ev.key === "F") && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
    if (state.selected && state.selected.item.kind === "grid" && state.selected.item.shape !== "line") {
      state.selected.filled = !state.selected.filled;
      renderAll();
    }
    return;
  }
  if (ev.key !== "Delete" && ev.key !== "Backspace") return;
  if (state.selected) {
    ev.preventDefault();
    deleteLayer(state.selected);
  }
});

/* ---- w-plane interactions ---- */
let rdrag = null;
rightCv.addEventListener("pointerdown", (ev) => {
  rdrag = { px: ev.offsetX, py: ev.offsetY };
  rightCv.setPointerCapture(ev.pointerId);
});
rightCv.addEventListener("pointermove", (ev) => {
  if (!rdrag) return;
  const ppu = CSSW / (2 * state.rightView.half);
  state.rightView.cx -= (ev.offsetX - rdrag.px) / ppu;
  state.rightView.cy += (ev.offsetY - rdrag.py) / ppu;
  rdrag.px = ev.offsetX; rdrag.py = ev.offsetY;
  renderRight();
});
rightCv.addEventListener("pointerup", () => { rdrag = null; });
rightCv.addEventListener("pointercancel", () => { rdrag = null; });
rightCv.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  const v = state.rightView;
  const [wx, wy] = pixToWorld(v, rightCv, ev.offsetX, ev.offsetY);
  const f = zoomFactor(ev);
  v.half = Math.min(1e4, Math.max(1e-4, v.half * f));
  const [wx2, wy2] = pixToWorld(v, rightCv, ev.offsetX, ev.offsetY);
  v.cx += wx - wx2; v.cy += wy - wy2;
  renderRight();
}, { passive: false });

/* ---- function input ---- */

// Convert MathLive's LaTeX output to this app's plain expression syntax.
function grabGroup(s, i) {
  if (s[i] !== "{") return [s[i] || "", i + 1]; // bare token, e.g. ^2
  let depth = 0, j = i;
  for (; j < s.length; j++) {
    if (s[j] === "{") depth++;
    else if (s[j] === "}") { depth--; if (!depth) break; }
  }
  return [s.slice(i + 1, j), j + 1];
}
function convStructures(s) {
  let out = "", i = 0;
  while (i < s.length) {
    if (s.startsWith("\\frac", i)) {
      const [a, i2] = grabGroup(s, i + 5);
      const [b, i3] = grabGroup(s, i2);
      out += `((${convStructures(a)})/(${convStructures(b)}))`;
      i = i3;
    } else if (s.startsWith("\\sqrt", i)) {
      const [a, i2] = grabGroup(s, i + 5);
      out += `sqrt(${convStructures(a)})`;
      i = i2;
    } else if (s.startsWith("\\overline", i)) {
      const [a, i2] = grabGroup(s, i + 9);
      out += `conj(${convStructures(a)})`;
      i = i2;
    } else if (s[i] === "^") {
      const [a, i2] = grabGroup(s, i + 1);
      out += `^(${convStructures(a)})`;
      i = i2;
    } else if (s[i] === "{") {
      const [a, i2] = grabGroup(s, i);
      out += `(${convStructures(a)})`;
      i = i2;
    } else {
      out += s[i];
      i++;
    }
  }
  return out;
}
function latexToExpr(latex) {
  let s = latex;
  s = s.replace(/\\left|\\right|\\mleft|\\mright|\\!|\\,|\\;|\\:|\\ /g, "");
  s = s.replace(/\\imaginaryI/g, "i").replace(/\\exponentialE/g, "e");
  s = s.replace(/\\differentialD/g, "d");
  s = s.replace(/\\cdot|\\times|\\ast/g, "*");
  s = s.replace(/\\div/g, "/");
  s = s.replace(/\\pi/g, " pi ");
  s = s.replace(/\\operatorname\{\s*([a-zA-Z]+)\s*\}/g, " $1 ");
  s = s.replace(/\\(sinh|cosh|tanh|sin|cos|tan|exp|ln|log|arg|Re|Im)\b/g, " $1 ");
  s = convStructures(s);
  return s;
}

function readFnSource() {
  return latexToExpr(currentLatex());
}

function applyFunction() {
  const src = readFnSource();
  try {
    setFunction(src);
    fnInput.classList.remove("bad");
    errEl.textContent = "";
    renderRight();
  } catch (e) {
    fnInput.classList.add("bad");
    errEl.textContent = String(e.message || e).split("\n")[0].slice(0, 120);
  }
}
fnInput.addEventListener("input", applyFunction);

// If the MathLive CDN script fails, swap in a plain text input so the app still works.
window.addEventListener("load", () => {
  if (customElements.get("math-field")) {
    // typing "conj" renders as an overbar
    try {
      fnInput.inlineShortcuts = { ...fnInput.inlineShortcuts, conj: "\\overline{#?}" };
    } catch (e) { /* older MathLive without inlineShortcuts setter */ }
    // math-field upgraded after boot: re-read the value it now reports
    applyFunction();
    return;
  }
  const plain = document.createElement("input");
  plain.id = "fn";
  plain.value = "e^z";
  plain.spellcheck = false;
  fnInput.replaceWith(plain);
  fnInput = plain;
  plain.addEventListener("input", applyFunction);
  applyFunction();
});
/* presets dropdown with LaTeX-rendered entries */
const PRESETS = [
  "z^2", "z^3", "\\frac{1}{z}", "e^z", "\\ln(z)", "\\sin(z)",
  "\\sqrt{z}", "\\frac{z-1}{z+1}", "z+\\frac{1}{z}", "\\overline{z}",
];
const presetBtn = document.getElementById("presetBtn");
const presetMenu = document.getElementById("presetMenu");
for (const latex of PRESETS) {
  const row = document.createElement("div");
  row.className = "preset-item";
  const mf = document.createElement("math-field");
  mf.setAttribute("read-only", "");
  mf.textContent = latex;
  row.appendChild(mf);
  row.addEventListener("click", () => {
    fnInput.value = latex;
    applyFunction();
    presetMenu.hidden = true;
  });
  presetMenu.appendChild(row);
}
presetBtn.addEventListener("click", (ev) => {
  ev.stopPropagation();
  presetMenu.hidden = !presetMenu.hidden;
});
document.addEventListener("click", () => { presetMenu.hidden = true; });

document.getElementById("file").addEventListener("change", (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(img.src);
    const item = addPhotoItem(img, f.name);
    // also place it on the plane right away
    addLayer(item, state.leftView.cx, state.leftView.cy);
  };
  img.src = URL.createObjectURL(f);
  ev.target.value = "";
});

/* sweep animation: lay the z-plane down onto the w-plane by arg z, 0 -> 2π */
const SWEEP_MS = 4000;
const playBtn = document.getElementById("playBtn");
let sweepRaf = 0;
function stopSweep() {
  cancelAnimationFrame(sweepRaf);
  state.sweep = null;
  playBtn.textContent = "▶ sweep";
  renderAll();
}
playBtn.addEventListener("click", () => {
  if (state.sweep !== null) { stopSweep(); return; }
  playBtn.textContent = "■ stop";
  const t0 = performance.now();
  const step = (now) => {
    const t = (now - t0) / SWEEP_MS;
    if (t >= 1) { stopSweep(); return; }
    state.sweep = 2 * Math.PI * t;
    renderAll();
    sweepRaf = requestAnimationFrame(step);
  };
  state.sweep = 0;
  renderAll();
  sweepRaf = requestAnimationFrame(step);
});

/* dismissable pane instructions (dismissal remembered per pane) */
for (const [id, key] of [["hintLeft", "complexmap.hintL"], ["hintRight", "complexmap.hintR"]]) {
  const el = document.getElementById(id);
  if (!el) continue;
  let hidden = false;
  try { hidden = !!localStorage.getItem(key); } catch (e) {}
  if (hidden) { el.remove(); continue; }
  el.querySelector(".hclose").addEventListener("click", () => {
    el.remove();
    try { localStorage.setItem(key, "1"); } catch (e) {}
  });
}

/* ---- boot ---- */
const shapeItems = {
  rect: addShapeItem("rect", 4, "rectangle"),
  circle: addShapeItem("circle", 3, "circle"),
  semicircle: addShapeItem("semicircle", 2, "semicircle"),
  line: addShapeItem("line", 1, "line"),
};

const saved = loadState();
if (saved && Array.isArray(saved.layers)) {
  if (saved.leftView) Object.assign(state.leftView, saved.leftView);
  if (saved.rightView) Object.assign(state.rightView, saved.rightView);
  if (saved.fn) {
    if (customElements.get("math-field")) fnInput.value = saved.fn;
    else fnInput.textContent = saved.fn; // MathLive reads content when it upgrades
  }
  for (const t of saved.tiles || []) {
    const it = shapeItems[t.shape];
    if (!it) continue;
    if (COLORS[t.color]) it.color = t.color;
    it.filled = t.filled !== false;
    it.syncToggle();
  }
  Promise.all(
    (saved.photos || []).map(
      (p) =>
        new Promise((res) => {
          const img = new Image();
          img.onload = () => res(addPhotoItem(img, "photo", p.url));
          img.onerror = () => res(null);
          img.src = p.url;
        })
    )
  ).then((photoItems) => {
    for (const l of saved.layers) {
      if (!l.rect) continue;
      if (l.kind === "photo") {
        if (photoItems[l.i]) state.layers.push({ item: photoItems[l.i], rect: l.rect, filled: true, color: 0, rot: 0 });
        continue;
      }
      // "grid" = older saves: index into 5 rect tiles then 5 circle tiles, one per color
      const shape = l.kind === "grid" ? (l.i < 5 ? "rect" : "circle") : l.shape;
      const color = l.kind === "grid" ? l.i % 5 : l.color;
      if (!shapeItems[shape]) continue;
      state.layers.push({
        item: shapeItems[shape], rect: l.rect, filled: l.filled !== false,
        color: COLORS[color] ? color : 0, rot: l.rot | 0,
      });
    }
    renderAll();
  });
} else {
  addLayer(shapeItems.rect, 0, 0, 2);
  state.selected = null;
}
applyFunction();
renderAll();
