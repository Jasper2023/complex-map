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

function vertexSrc(fExpr) {
  return `#version 300 es
precision highp float;
in vec2 aUV;
uniform vec4 uRect;   // layer rect in z-plane: x, y (bottom-left), w, h
uniform vec3 uView;   // w-plane view: center x, center y, half-extent
out vec2 vUV;
out vec2 vZ;
${GLSL_LIB}
vec2 f(vec2 z){ return ${fExpr}; }
void main(){
  vec2 z = uRect.xy + aUV * uRect.zw;
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

const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUV;
in vec2 vZ;
uniform sampler2D uTex;
uniform int uIsGrid;
uniform vec3 uFill;
uniform vec3 uLine;
uniform float uSpacing;
out vec4 outColor;
void main(){
  if (uIsGrid == 1) {
    // world-aligned graph paper: minor lines every uSpacing, major every 4x
    float sp = uSpacing;
    vec2 d1 = abs(fract(vZ / sp + 0.5) - 0.5) * sp;
    float sp2 = sp * 4.0;
    vec2 d2 = abs(fract(vZ / sp2 + 0.5) - 0.5) * sp2;
    float lw = sp * 0.02;
    float a1 = 1.0 - smoothstep(lw * 0.7, lw * 1.3, min(d1.x, d1.y));
    float lw2 = sp * 0.04;
    float a2 = 1.0 - smoothstep(lw2 * 0.7, lw2 * 1.3, min(d2.x, d2.y));
    outColor = vec4(mix(uFill, uLine, max(a1, a2)), 1.0);
  } else {
    outColor = texture(uTex, vUV);
  }
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
const gridsEl = document.getElementById("grids");

const state = {
  palette: [],                              // {id, source, aspect, tex}
  layers: [],                               // {item, rect:{x,y,w,h}} in draw order
  selected: null,                           // a layer, or null
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

function paletteDom(item, thumbCanvas, label, isPhoto) {
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
  }
  (isPhoto ? photosEl : gridsEl).appendChild(div);
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
  paletteDom(item, thumb, label, true);
  return item;
}

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function addGridItem(fillHex, lineHex, lineAlpha, label) {
  const fill = hexToRgb(fillHex);
  const base = hexToRgb(lineHex);
  const line = fill.map((c, i) => Math.round(c * (1 - lineAlpha) + base[i] * lineAlpha));
  const item = {
    id: nextId++,
    kind: "grid",
    aspect: 1,
    fill: fill.map((c) => c / 255),
    line: line.map((c) => c / 255),
    fillCss: fillHex,
    lineCss: `rgb(${line.join(",")})`,
  };
  state.palette.push(item);
  paletteDom(item, makeGridThumb(fillHex, `rgba(${base.join(",")},${lineAlpha})`), label, false);
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
function makeGridThumb(fill, line) {
  const S = Math.round(72 * DPR);
  const c = document.createElement("canvas");
  c.width = c.height = S;
  c.style.width = c.style.height = "72px";
  const g = c.getContext("2d");
  g.fillStyle = fill;
  g.fillRect(0, 0, S, S);
  g.strokeStyle = line;
  g.lineWidth = DPR;
  for (let t = 0; t <= S; t += S / 4) {
    const p = Math.min(S - g.lineWidth, Math.max(g.lineWidth / 2, t));
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, S); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(S, p); g.stroke();
  }
  g.lineWidth = 2 * DPR;
  g.beginPath(); g.moveTo(S / 2, 0); g.lineTo(S / 2, S); g.stroke();
  g.beginPath(); g.moveTo(0, S / 2); g.lineTo(S, S / 2); g.stroke();
  return c;
}


/* ---- layers ---- */
function addLayer(item, cx, cy, width) {
  const w = width || state.leftView.half * 0.66;
  const h = w * item.aspect;
  const layer = { item, rect: { x: cx - w / 2, y: cy - h / 2, w, h } };
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

function setFunction(src) {
  const expr = compileExpr(src); // throws on parse error
  const vs = compileShader(gl.VERTEX_SHADER, vertexSrc(expr));
  const fs = compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(log);
  }
  if (state.program) gl.deleteProgram(state.program);
  state.program = prog;
  state.uRect = gl.getUniformLocation(prog, "uRect");
  state.uView = gl.getUniformLocation(prog, "uView");
  state.uIsGrid = gl.getUniformLocation(prog, "uIsGrid");
  state.uFill = gl.getUniformLocation(prog, "uFill");
  state.uLine = gl.getUniformLocation(prog, "uLine");
  state.uSpacing = gl.getUniformLocation(prog, "uSpacing");
  const loc = gl.getAttribLocation(prog, "aUV");
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
}

/* ---- rendering ---- */
function renderRight() {
  gl.viewport(0, 0, rightCv.width, rightCv.height);
  gl.clearColor(0.05, 0.06, 0.07, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (state.program) {
    gl.useProgram(state.program);
    const v = state.rightView;
    gl.uniform3f(state.uView, v.cx, v.cy, v.half);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    for (const layer of state.layers) {
      const r = layer.rect, it = layer.item;
      gl.uniform4f(state.uRect, r.x, r.y, r.w, r.h);
      if (it.kind === "grid") {
        gl.uniform1i(state.uIsGrid, 1);
        gl.uniform3f(state.uFill, it.fill[0], it.fill[1], it.fill[2]);
        gl.uniform3f(state.uLine, it.line[0], it.line[1], it.line[2]);
        gl.uniform1f(state.uSpacing, GRID_SPACING);
      } else {
        gl.uniform1i(state.uIsGrid, 0);
        gl.bindTexture(gl.TEXTURE_2D, it.tex);
      }
      gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_SHORT, 0);
    }
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

const HANDLE = 5;      // half-size of corner handle, px
const HANDLE_HIT = 9;  // hit-test radius, px

// corners of a layer in pixel coords, order: BL, BR, TL, TR (world orientation)
function layerCornersPix(layer) {
  const r = layer.rect, v = state.leftView;
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
  for (let c = 0; c < 4; c++) {
    if (Math.abs(px - cs[c][0]) <= HANDLE_HIT && Math.abs(py - cs[c][1]) <= HANDLE_HIT) return c;
  }
  return -1;
}
function layerAt(wx, wy) {
  for (let i = state.layers.length - 1; i >= 0; i--) {
    const r = state.layers[i].rect;
    if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) return state.layers[i];
  }
  return null;
}

function renderLeft() {
  const v = state.leftView;
  lctx.clearRect(0, 0, CSSW, CSSW);
  drawAxes(lctx, leftCv, v, false);
  const ppu = CSSW / (2 * v.half);
  for (const layer of state.layers) {
    const r = layer.rect;
    const [px, py] = worldToPix(v, leftCv, r.x, r.y + r.h);
    if (layer.item.kind === "grid") {
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
    lctx.strokeRect(px, py, r.w * ppu, r.h * ppu);
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
  scheduleSave();
}

// draw a grid layer in the z-plane as a window onto the fixed world-aligned grid
function drawGridWindow(layer, px, py, pw, ph) {
  const v = state.leftView, r = layer.rect, it = layer.item;
  const ppu = CSSW / (2 * v.half);
  lctx.save();
  lctx.beginPath();
  lctx.rect(px, py, pw, ph);
  lctx.clip();
  lctx.fillStyle = it.fillCss;
  lctx.fillRect(px, py, pw, ph);
  lctx.strokeStyle = it.lineCss;
  const major = GRID_SPACING * 4;
  for (const [sp, lw] of [[GRID_SPACING, Math.max(0.5, 0.01 * ppu)], [major, Math.max(1, 0.02 * ppu)]]) {
    lctx.lineWidth = lw;
    for (let x = Math.ceil(r.x / sp) * sp; x <= r.x + r.w; x += sp) {
      const [gx] = worldToPix(v, leftCv, x, 0);
      lctx.beginPath(); lctx.moveTo(gx, py); lctx.lineTo(gx, py + ph); lctx.stroke();
    }
    for (let y = Math.ceil(r.y / sp) * sp; y <= r.y + r.h; y += sp) {
      const [, gy] = worldToPix(v, leftCv, 0, y);
      lctx.beginPath(); lctx.moveTo(px, gy); lctx.lineTo(px + pw, gy); lctx.stroke();
    }
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
      layers: state.layers.map((l) =>
        l.item.kind === "grid"
          ? { kind: "grid", i: grids.indexOf(l.item), rect: l.rect }
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
leftCv.addEventListener("pointerdown", (ev) => {
  const [wx, wy] = pixToWorld(state.leftView, leftCv, ev.offsetX, ev.offsetY);
  const corner = hitCorner(state.selected, ev.offsetX, ev.offsetY);
  if (corner >= 0) {
    const r = state.selected.rect;
    // anchor = opposite corner stays fixed
    const anchorX = corner & 1 ? r.x : r.x + r.w;
    const anchorY = corner & 2 ? r.y : r.y + r.h;
    drag = { mode: "resize", layer: state.selected, anchorX, anchorY, aspect: r.h / r.w };
  } else {
    const layer = layerAt(wx, wy);
    if (layer) {
      state.selected = layer;
      drag = { mode: "layer", layer, wx, wy };
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
      ? (c === 0 || c === 3 ? "nesw-resize" : "nwse-resize")
      : (layerAt(wx, wy) ? "grab" : "default");
    return;
  }
  if (drag.mode === "resize") {
    const [wx, wy] = pixToWorld(state.leftView, leftCv, ev.offsetX, ev.offsetY);
    const r = drag.layer.rect;
    const min = state.leftView.half * 0.02;
    if (ev.shiftKey) {
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
    drag.layer.rect.x += wx - drag.wx;
    drag.layer.rect.y += wy - drag.wy;
    drag.wx = wx; drag.wy = wy;
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
  if (ev.key !== "Delete" && ev.key !== "Backspace") return;
  if (document.activeElement === fnInput) return;
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

/* ---- boot ---- */
const GRID_TILES = [
  ["#e8eaee", "#000000", 0.35],
  ["#e0483f", "#ffffff", 0.55],
  ["#2e9e58", "#ffffff", 0.55],
  ["#3672e0", "#ffffff", 0.55],
  ["#8b5cf6", "#ffffff", 0.55],
];
let firstTile = null;
for (const [fill, lineBase, alpha] of GRID_TILES) {
  const item = addGridItem(fill, lineBase, alpha, fill + " grid");
  if (fill === "#8b5cf6") firstTile = item;
}

const saved = loadState();
if (saved && Array.isArray(saved.layers)) {
  if (saved.leftView) Object.assign(state.leftView, saved.leftView);
  if (saved.rightView) Object.assign(state.rightView, saved.rightView);
  if (saved.fn) {
    if (customElements.get("math-field")) fnInput.value = saved.fn;
    else fnInput.textContent = saved.fn; // MathLive reads content when it upgrades
  }
  const gridItems = state.palette.filter((p) => p.kind === "grid");
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
      const item = l.kind === "grid" ? gridItems[l.i] : photoItems[l.i];
      if (item && l.rect) state.layers.push({ item, rect: l.rect });
    }
    renderAll();
  });
} else {
  addLayer(firstTile, 0, 0, 2);
  state.selected = null;
}
applyFunction();
renderAll();
