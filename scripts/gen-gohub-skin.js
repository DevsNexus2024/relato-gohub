#!/usr/bin/env node
// Gera as partes automáticas do visual do GoHub a partir do CSS do próprio site.
//
//   node scripts/gen-gohub-skin.js caminho/para/site.css
//
// Saídas:
//   src/skins/gohub.gen.css       fontes (px ampliados, família moderna)
//   src/skins/gohub-dark.gen.css  todas as cores do site traduzidas para o tema escuro
//
// Como funciona: cada regra do site que declara cor/fonte é repetida com um
// ":root" na frente do seletor. Isso dá a todas a MESMA vantagem de
// especificidade, então a ordem/prioridade original entre as regras do site é
// preservada — só os valores mudam. O site.css é obtido com a captura de
// desenvolvimento (RELATO_INSPECT_DIR, ver scripts/inspect-hook.js).

const fs = require('fs');
const path = require('path');

const input = process.argv[2];
if (!input) {
  console.error('uso: node scripts/gen-gohub-skin.js site.css');
  process.exit(1);
}
const css = fs.readFileSync(input, 'utf8');
const OUT = path.join(__dirname, '..', 'src', 'skins');

// Fonte base do site: html { font-size: 14px } -> nova base (ver gohub.css)
const OLD_BASE = 14;
const NEW_BASE = 17;
const FONT_STACK = 'var(--relato-font)';

// ---------------------------------------------------------------------------
// Parser simples (o CSS vem normalizado de cssRules.cssText)
// ---------------------------------------------------------------------------
function parse(src) {
  const nodes = [];
  let i = 0;
  const skipWs = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const readUntilBrace = () => {
    let s = '';
    let q = null;
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (q) { s += c; if (c === q && src[i - 1] !== '\\') q = null; i++; continue; }
      if (c === '"' || c === "'") { q = c; s += c; i++; continue; }
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (depth === 0 && (c === '{' || c === '}' || c === ';')) break;
      s += c; i++;
    }
    return s.trim();
  };
  const readBlock = () => { // retorna o conteúdo entre { } (assumindo i em '{')
    let depth = 0;
    let q = null;
    const start = i + 1;
    for (; i < src.length; i++) {
      const c = src[i];
      if (q) { if (c === q && src[i - 1] !== '\\') q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { i++; return src.slice(start, i - 1); } }
    }
    return src.slice(start);
  };
  while (i < src.length) {
    skipWs();
    if (i >= src.length) break;
    if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    const prelude = readUntilBrace();
    if (src[i] === ';') { i++; continue; } // @import, @charset
    if (src[i] === '}') { i++; continue; }
    if (src[i] !== '{') break;
    const body = readBlock();
    if (prelude.startsWith('@')) {
      if (/^@(media|supports|container|layer|document)/.test(prelude)) nodes.push({ type: 'at', prelude, children: parse(body) });
      // @keyframes, @font-face, @page... ignorados
    } else {
      nodes.push({ type: 'rule', sel: prelude, decls: parseDecls(body) });
    }
  }
  return nodes;
}

function splitTop(str, sep) {
  const out = [];
  let depth = 0;
  let q = null;
  let cur = '';
  for (let k = 0; k < str.length; k++) {
    const c = str[k];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function parseDecls(body) {
  return splitTop(body, ';').map((d) => {
    const k = d.indexOf(':');
    if (k < 0) return null;
    let val = d.slice(k + 1).trim();
    const imp = /!important\s*$/.test(val);
    if (imp) val = val.replace(/\s*!important\s*$/, '');
    return { prop: d.slice(0, k).trim(), val, imp };
  }).filter(Boolean);
}

function prefixSel(sel) {
  return splitTop(sel, ',').map((s) => {
    s = s.trim();
    if (s.startsWith(':root')) return `:root${s}`;
    if (/^html(?![\w-])/.test(s)) return `html:root${s.slice(4)}`;
    return `:root ${s}`;
  }).join(', ');
}

function emit(nodes, pick) {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'at') {
      const inner = emit(n.children, pick);
      if (inner.trim()) out += `${n.prelude} {\n${inner}}\n`;
      continue;
    }
    const decls = n.decls.map((d) => pick(d, n.sel)).filter(Boolean);
    if (decls.length) out += `${prefixSel(n.sel)} { ${decls.join('; ')} }\n`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cores
// ---------------------------------------------------------------------------
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\b(white|black)\b/g;

function parseColor(s) {
  s = s.toLowerCase();
  if (s === 'white') return [255, 255, 255, 1];
  if (s === 'black') return [0, 0, 0, 1];
  if (s[0] === '#') {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), a];
  }
  const m = s.match(/rgba?\(([^)]*)\)/);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    return [p[0], p[1], p[2], p[3] == null ? 1 : p[3]];
  }
  return null; // hsl: deixa como está
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (h, s, l, a) => (a >= 1
  ? `hsl(${h.toFixed(0)} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%)`
  : `hsl(${h.toFixed(0)} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}% / ${+a.toFixed(3)})`);

// kind: 'bg' | 'fg' | 'border' | 'shadow'
function darkColor(str, kind) {
  const c = parseColor(str);
  if (!c) return str;
  const [r, g, b, a] = c;
  if (a === 0) return str;
  const [h, s0, l] = rgbToHsl(r, g, b);
  // Cinzas "slate"/"zinc" do site (pouca saturação) viram cinzas neutros puros
  const s = s0 < 0.3 ? 0 : s0;
  const accent = s >= 0.5 && l >= 0.35 && l <= 0.68;

  if (kind === 'shadow') {
    if (l > 0.7) return fmt(h, s, l, a * 0.06); // brilhos internos brancos quase somem
    return fmt(h, s, clamp(l, 0, 0.05), clamp(a * 2.2, 0, 0.6)); // sombras mais fortes no escuro
  }
  if (kind === 'fg') {
    if (l >= 0.55) return str; // texto já claro (ex.: em botão escuro)
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (accent && lum >= 0.4) return str; // cor de marca clara (amarelo) já é legível no escuro
    if (s >= 0.35) return fmt(h, clamp(s, 0, 0.75), 0.7, a); // texto colorido: mesma cor, mais clara
    return fmt(h, s * 0.6, clamp(0.94 - l * 0.75, 0.6, 0.94), a);
  }
  if (kind === 'border') {
    if (accent) return str;
    if (l > 0.5) {
      if (s >= 0.35) return fmt(h, s * 0.55, 0.3, a);
      return fmt(h, s * 0.4, 0.2 + (1 - l) * 0.45, a);
    }
    return str;
  }
  // bg
  if (accent) return str;
  if (l > 0.5) {
    if (s >= 0.35) return fmt(h, clamp(s * 0.5, 0, 0.45), 0.15 + (1 - l) * 0.25, a); // fundos pastel -> tons escuros da mesma cor
    return fmt(h, s * 0.5, 0.105 + (1 - l) * 0.8, a); // branco/cinza claro -> carbono
  }
  if (l < 0.3) return fmt(h, s * 0.8, clamp(l + 0.07, 0, 0.3), a); // escuros (ex.: botão grafite) um pouco mais claros que o fundo
  return str;
}

function kindForProp(prop, sel) {
  if (prop.startsWith('--')) {
    if (/(fundo|bg|soft|surface|fill|kb$|-b$|light|hover)/i.test(prop)) return 'bg';
    if (/(borda|border|line|linha)/i.test(prop)) return 'border';
    if (/shadow|sombra/i.test(prop)) return 'shadow';
    return 'fg';
  }
  if (/^(background|background-color|background-image)$/.test(prop)) return 'bg';
  if (/^(color|fill|stroke|caret-color|text-decoration-color|text-decoration|accent-color|-webkit-text-fill-color)$/.test(prop)) return 'fg';
  if (/^(border|outline)/.test(prop) || prop === 'column-rule') return 'border';
  if (/shadow/.test(prop)) return 'shadow';
  return null;
}

// ---------------------------------------------------------------------------
const tree = parse(css);

const base = emit(tree, (d) => {
  if (d.prop === 'font-size') {
    const m = d.val.match(/^([\d.]+)px$/);
    const val = m ? `${+(parseFloat(m[1]) * NEW_BASE / OLD_BASE).toFixed(2)}px` : d.val;
    return `font-size: ${val}${d.imp ? ' !important' : ''}`;
  }
  if (d.prop === 'font-family' && /montserrat/i.test(d.val)) {
    return `font-family: ${FONT_STACK}${d.imp ? ' !important' : ''}`;
  }
  return null;
});

const dark = emit(tree, (d, sel) => {
  const kind = kindForProp(d.prop, sel);
  if (!kind) return null;
  if (d.prop.startsWith('--') && !COLOR_RE.test(d.val)) { COLOR_RE.lastIndex = 0; return null; }
  COLOR_RE.lastIndex = 0;
  const val = d.val.replace(COLOR_RE, (m) => darkColor(m, kind));
  return `${d.prop}: ${val}${d.imp ? ' !important' : ''}`;
});

const header = (what) => `/* GERADO AUTOMATICAMENTE por scripts/gen-gohub-skin.js — ${what}.\n   Não edite à mão: ajustes vão em gohub.css / gohub-dark.css. */\n`;
fs.writeFileSync(path.join(OUT, 'gohub.gen.css'), header('fontes') + base);
fs.writeFileSync(path.join(OUT, 'gohub-dark.gen.css'), header('cores do tema escuro') + dark);
console.log('gohub.gen.css', (base.length / 1024).toFixed(0), 'KB | gohub-dark.gen.css', (dark.length / 1024).toFixed(0), 'KB');
