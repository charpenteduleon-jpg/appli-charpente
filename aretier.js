// Calcul arêtier & noue – repris de l'outil « Calcul arêtier & noue » fait avec Claude (27/10/2026),
// rangé dans l'appli pour marcher sans réseau. Longueurs en mètres : deux chiffres après la virgule.
'use strict';
const D = Math.PI / 180, R = 180 / Math.PI;
const $ = (id) => document.getElementById(id);
const units = { p1: 'deg', p2: 'deg' };
let mode = 'aret';
const POLICE = '-apple-system, system-ui, sans-serif';

document.getElementById('retour').addEventListener('click', () => {
  if (history.length > 1) history.back(); else location.href = './';
});

function geom(t1deg, t2deg, adeg) {
  const t1 = Math.tan(t1deg * D), t2 = Math.tan(t2deg * D), a = adeg * D;
  const beta = Math.atan2(t2 * Math.sin(a), t1 + t2 * Math.cos(a)); // angle en plan depuis sablière 1
  const tphi = t1 * Math.sin(beta);
  const phi = Math.atan(tphi);
  // délardement : angle du pan dans la section perpendiculaire à l'arêtier
  const h = [Math.cos(beta) * Math.cos(phi), Math.sin(beta) * Math.cos(phi), Math.sin(phi)];
  const q = [-Math.sin(beta), Math.cos(beta), 0];
  const u = cross(h, q);
  const N1 = [0, -t1, 1];
  const n2 = [Math.sin(a), -Math.cos(a)]; const N2 = [-t2 * n2[0], -t2 * n2[1], 1];
  const back = (N) => { const r = norm(cross(N, h)); return Math.atan2(Math.abs(dot(r, u)), Math.abs(dot(r, q))) * R; };
  return { beta: beta * R, beta2: adeg - beta * R, phi: phi * R, d1: back(N1), d2: back(N2) };
}
// réglages scie pour un empannon de pente th, qui rencontre l'arêtier sous l'angle en plan b (depuis sa sablière)
function jack(thdeg, bdeg) {
  const th = thdeg * D, b = bdeg * D;
  const nL = Math.abs(Math.cos(b) * Math.cos(th)), nN = Math.abs(Math.cos(b) * Math.sin(th)), nW = Math.abs(Math.sin(b));
  return {
    flat: { bev: Math.asin(Math.min(1, nN)) * R, mit: Math.atan2(nW, nL) * R },
    edge: { bev: Math.asin(Math.min(1, nW)) * R, mit: Math.atan2(nN, nL) * R },
  };
}
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(a) { const l = Math.hypot(...a); return a.map((x) => x / l); }

const f1 = (x) => (isFinite(x) ? x.toFixed(1).replace('.', ',') + '°' : '–');
const pct = (deg) => (Math.tan(deg * D) * 100).toFixed(1).replace('.', ',') + ' %';
const metres = (x) => x.toFixed(2).replace('.', ',') + ' m';
function slope(id) { const v = parseFloat($(id).value); if (!isFinite(v)) return NaN; return units[id] === 'deg' ? v : Math.atan(v / 100) * R; }

const sides = {}; // clé de carte -> {m:'D'|'G', b:'G'|'D'}
function sawCard(key, title, st) {
  const sd = sides[key] || (sides[key] = { m: 'D', b: 'G' });
  const okB = st.bev <= 49, okM = st.mit <= (sd.m === 'D' ? 60 : 50);
  const flag = (okB && okM) ? '<div class="flag okk">Dans la capacité de la DWS780</div>'
    : `<div class="flag ko">${!okB ? 'Inclinaison > 49° : impossible sur la DWS780. ' : ''}${!okM ? (sd.m === 'G' && st.mit <= 60 ? 'Onglet > 50° à gauche : passe le plateau à droite. ' : 'Onglet > 60° : utilise une cale ou l\'autre position. ') : ''}</div>`;
  const btn = (k, v, lab) => `<button data-key="${key}" data-k="${k}" data-v="${v}" aria-pressed="${sd[k] === v}">${lab}</button>`;
  return `<div class="setting"><h3>${title}</h3>
    <div class="row"><em>Onglet (plateau)</em><b>${f1(st.mit)} ${st.mit > 0.05 ? (sd.m === 'D' ? 'à droite' : 'à gauche') : ''}</b></div>
    <div class="row"><em>Inclinaison (tête)</em><b>${f1(st.bev)} ${st.bev > 0.05 ? (sd.b === 'G' ? 'à gauche' : 'à droite') : ''}</b></div>
    ${sawSvg(st.mit, st.bev, sd)}
    <div class="sides">
      <div>Plateau ${btn('m', 'G', 'Gauche')}${btn('m', 'D', 'Droite')}</div>
      <div>Tête ${btn('b', 'G', 'Gauche')}${btn('b', 'D', 'Droite')}</div>
    </div>${flag}</div>`;
}
// Vue de l'opérateur, debout devant la scie : à gauche vue de dessus (onglet), à droite vue de face (inclinaison)
function sawSvg(mit, bev, sd) {
  const cx = 78, cy = 92, r = 52, a = mit * D * (sd.m === 'D' ? 1 : -1);
  const fx = cx + r * Math.sin(a), fy = cy + r * Math.cos(a), bx = cx - r * Math.sin(a), by = cy - r * Math.cos(a);
  const arcM = Math.abs(mit) > 0.5 ? `<path d="M ${cx} ${cy + 34} A 34 34 0 0 ${sd.m === 'D' ? 0 : 1} ${cx + 34 * Math.sin(a)} ${cy + 34 * Math.cos(a)}" fill="none" stroke="var(--gold)" stroke-width="2"/>` : '';
  const tx = 200, ty = 128, L = 78, b = bev * D * (sd.b === 'G' ? -1 : 1);
  const ex = tx + L * Math.sin(b), ey = ty - L * Math.cos(b);
  const mx = tx + (L + 12) * Math.sin(b), my = ty - (L + 12) * Math.cos(b);
  const arcB = Math.abs(bev) > 0.5 ? `<path d="M ${tx} ${ty - 40} A 40 40 0 0 ${sd.b === 'G' ? 0 : 1} ${tx + 40 * Math.sin(b)} ${ty - 40 * Math.cos(b)}" fill="none" stroke="var(--gold)" stroke-width="2"/>` : '';
  const T = (x, y, t, anc = 'middle', sz = 11, w = 500, c = 'var(--muted)') => `<text x="${x}" y="${y}" text-anchor="${anc}" font-size="${sz}" font-weight="${w}" font-family="${POLICE}" style="fill:${c}">${t}</text>`;
  return `<svg class="sawview" viewBox="0 0 300 168" role="img" aria-label="Scie vue de l'opérateur : onglet ${f1(mit)}, inclinaison ${f1(bev)}">
    ${T(78, 14, 'VUE DE DESSUS · onglet', 'middle', 10, 600)}
    <rect x="16" y="30" width="124" height="7" rx="1" style="fill:var(--muted)"/>${T(78, 27, 'guide (fond)', 'middle', 9)}
    <path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 0 ${cx + r} ${cy}" style="fill:var(--surface);stroke:var(--line)"/>
    <rect x="16" y="37" width="124" height="16" rx="2" style="fill:var(--gold-soft);stroke:var(--gold)" stroke-width="1"/>${T(30, 48, 'pièce', 'start', 9, 600, 'var(--gold)')}
    <line x1="${cx}" y1="${cy - r}" x2="${cx}" y2="${cy + r}" style="stroke:var(--line)" stroke-dasharray="3 3"/>
    <line x1="${bx}" y1="${by}" x2="${fx}" y2="${fy}" style="stroke:var(--warn)" stroke-width="3"/>
    ${arcM}${T(cx + (sd.m === 'D' ? 28 : -28), cy + 56, f1(mit), 'middle', 12, 700, 'var(--ink)')}
    ${T(78, 162, '▲ toi', 'middle', 10, 600, 'var(--ink)')}
    <line x1="150" y1="22" x2="150" y2="160" style="stroke:var(--line)"/>
    ${T(225, 14, 'VUE DE FACE · inclinaison', 'middle', 10, 600)}
    <rect x="160" y="${ty}" width="130" height="10" rx="1" style="fill:var(--muted)"/>
    <rect x="166" y="${ty - 14}" width="68" height="14" rx="2" style="fill:var(--gold-soft);stroke:var(--gold)"/>
    <line x1="${tx}" y1="${ty}" x2="${tx}" y2="${ty - L}" style="stroke:var(--line)" stroke-dasharray="3 3"/>
    <line x1="${tx}" y1="${ty}" x2="${ex}" y2="${ey}" style="stroke:var(--warn)" stroke-width="4"/>
    <circle cx="${mx}" cy="${my}" r="11" style="fill:var(--navy)"/>
    ${arcB}${T(tx + (sd.b === 'G' ? -30 : 30), ty - 46, f1(bev), 'middle', 12, 700, 'var(--ink)')}
    ${T(167, 162, 'gauche', 'start', 10)}${T(288, 162, 'droite', 'end', 10)}
  </svg>`;
}
document.addEventListener('click', (ev) => {
  const bt = ev.target.closest('.sides button'); if (!bt) return;
  sides[bt.dataset.key][bt.dataset.k] = bt.dataset.v; run();
});

const foot = { pc: 'c1', db: 1, ab: 'ap' }; let lastG = null, lastT = [0, 0];
const mm = (x) => (isFinite(x) ? Math.round(x) + ' mm' : '–');
function footRun() {
  if (!lastG) return;
  const g = lastG, [t1, t2] = lastT;
  const W = parseFloat($('sw').value), Hs = parseFloat($('sh').value) || 0, Dcm = parseFloat($('dd').value), A = parseFloat($('aa').value);
  const isAr = foot.pc === 'ar';
  const pdeg = foot.pc === 'c1' ? t1 : foot.pc === 'c2' ? t2 : g.phi, p = pdeg * D;
  const H = parseFloat(isAr ? $('ha').value : $('hc').value);
  if (![W, H, pdeg].every(isFinite) || W <= 0 || H <= 0) return;
  // assise en plan : largeur sablière ; pour l'arêtier, traversée en diagonale de l'angle
  const S = isAr ? W / Math.sin(Math.min(g.beta, g.beta2) * D) : W;
  const heel = S * Math.tan(p), depth = S * Math.sin(p), rest = H - depth, Hv = H / Math.cos(p);
  let D_ = foot.db ? Dcm * 10 : 0;
  if (isAr && foot.db) { const dh = Dcm * 10 * Math.cos(t1 * D); D_ = dh / Math.sin(g.beta * D) / Math.cos(p); } // même alignement que les chevrons du pan 1
  const kv = [];
  kv.push(['Pente de la pièce', f1(pdeg), pct(pdeg)]);
  kv.push(['Talon d\'aplomb (entaille)', mm(heel), 'au nu extérieur de la sablière']);
  kv.push(['Assise', mm(S), 'horizontale, ' + mm(S / Math.cos(p)) + ' sous la pièce']);
  kv.push(['Profondeur d\'entaille', mm(depth), 'perpendiculaire à la pièce']);
  kv.push(['Bois restant', mm(rest), Math.round(depth / H * 100) + ' % de la hauteur entaillée']);
  if (foot.db) {
    kv.push(['Débord le long de la pièce', mm(D_), 'horizontal : ' + mm(D_ * Math.cos(p))]);
    if (foot.ab === 'ap') kv.push(['Coupe d\'about d\'aplomb', mm(Hv), 'hauteur tracée sur la pièce']);
    else { const lv = (Hv - A) / Math.tan(p); kv.push(['About : aplomb + niveau', mm(A) + ' + ' + mm(lv), 'aplomb puis coupe de niveau']); }
  } else {
    kv.push(['Coupe d\'aplomb au nu du mur', mm(Hv - heel), 'du dessus de la pièce jusqu\'à l\'assise']);
  }
  kv.push(['Dessus de la pièce au nu extérieur', mm(Hs + Hv - heel), 'au-dessus du dessous de la sablière']);
  $('foot-kv').innerHTML = kv.map((k) => `<div class="kv"><span>${k[0]}</span><b>${k[1]}</b><small>${k[2]}</small></div>`).join('');
  $('foot-saw').innerHTML = sawCard('fa' + foot.pc, "Coupe d'aplomb (about / pied), pièce sur chant", { mit: pdeg, bev: 0 })
    + ((!foot.db || foot.ab === 'an') ? sawCard('fn' + foot.pc, 'Coupe de niveau, pièce sur chant', { mit: 90 - pdeg, bev: 0 }) : '');
  const notes = [];
  if (rest <= 0) notes.push('⚠ L\'entaille traverse toute la pièce : l\'assise sur toute la largeur est impossible avec cette section.');
  else if (depth > H / 3) notes.push(`⚠ Entaille de plus d'1/3 de la hauteur. Assise maxi pour rester à 1/3 : ${mm(H / 3 / Math.sin(p))} en horizontal.`);
  if (foot.db && foot.ab === 'an' && A >= Hv) notes.push('⚠ L\'aplomb d\'about dépasse la hauteur d\'aplomb de la pièce.');
  if (isAr) notes.push('Arêtier : talon et assise calculés dans l\'axe de l\'arêtier, traversée en diagonale de l\'angle des sablières. Le pied dans l\'angle reste une coupe à double aplomb à tracer.');
  notes.push('L\'entaille elle-même se fait à la circulaire ou à la scie égoïne : la radiale sert aux coupes d\'about et de pied.');
  $('foot-note').innerHTML = notes.join('<br>');
  drawFoot(W, Hs, H, p, D_, A, heel);
}
function drawFoot(W, Hs, H, p, Dl, A, heel) {
  const tp = Math.tan(p), Hv = H / Math.cos(p);
  const yb = (x) => (x - W) * tp, yt = (x) => yb(x) + Hv;
  const xR = W + Math.max(150, Hv * 1.2);
  const pts = [[xR, yt(xR)]];
  let xE = 0;
  if (foot.db) {
    xE = -Dl * Math.cos(p);
    if (foot.ab === 'ap') { pts.push([xE, yt(xE)], [xE, yb(xE)]); }
    else { const yA = yt(xE) - Math.min(A, Hv * 0.99); const x2 = W + yA / tp; pts.push([xE, yt(xE)], [xE, yA], [x2, yA]); }
    pts.push([0, yb(0)], [0, 0], [W, 0]);
  } else pts.push([0, yt(0)], [0, 0], [W, 0]);
  pts.push([xR, yb(xR)]);
  const xs = pts.map((q) => q[0]).concat([0, W]), ys = pts.map((q) => q[1]).concat([-Hs]);
  const minX = Math.min(...xs) - 30, maxX = Math.max(...xs) + 20, minY = Math.min(...ys) - 30, maxY = Math.max(...ys) + 30;
  const vw = maxX - minX, vh = maxY - minY, sc = 320 / vw, H2 = Math.min(260, vh * sc);
  const X = (x) => (x - minX) * sc, Y = (y) => (maxY - y) * (H2 / vh);
  $('foot').setAttribute('viewBox', `0 0 320 ${H2}`);
  const T = (x, y, t, anc = 'middle', c = 'var(--ink)') => `<text x="${x}" y="${y}" text-anchor="${anc}" font-size="11" font-weight="600" font-family="${POLICE}" style="fill:${c}">${t}</text>`;
  $('foot').innerHTML = `
    <rect x="${X(0)}" y="${Y(0)}" width="${W * sc}" height="${Hs * (H2 / vh)}" style="fill:var(--muted);opacity:.55"/>
    <line x1="${X(0)}" y1="${Y(0)}" x2="${X(0)}" y2="${H2}" style="stroke:var(--muted)" stroke-dasharray="4 3"/>
    <polygon points="${pts.map((q) => X(q[0]).toFixed(1) + ',' + Y(q[1]).toFixed(1)).join(' ')}" style="fill:var(--gold-soft);stroke:var(--gold)" stroke-width="1.5"/>
    ${T(X(W / 2), Y(-Hs) + 14, 'sablière')}
    ${T(X(0) - 4, H2 - 6, 'nu ext.', 'end', 'var(--muted)')}
    ${heel > 0 && foot.db ? `<line x1="${X(0)}" y1="${Y(0)}" x2="${X(0)}" y2="${Y(-heel)}" style="stroke:var(--warn)" stroke-width="2.5"/>` : ''}
    <line x1="${X(0)}" y1="${Y(0)}" x2="${X(W)}" y2="${Y(0)}" style="stroke:var(--warn)" stroke-width="2.5"/>
    ${T(X(W / 2), Y(0) - 6, 'assise', 'middle', 'var(--warn)')}
    ${T(X(xR) - 4, Y(yt(xR)) - 6, '→ faîtage', 'end', 'var(--muted)')}`;
}
document.addEventListener('click', (ev) => {
  const b = ev.target.closest('.pc,.db,.ab'); if (!b) return;
  if (b.classList.contains('pc')) { foot.pc = b.dataset.pc; document.querySelectorAll('.pc').forEach((x) => x.setAttribute('aria-pressed', x === b)); }
  if (b.classList.contains('db')) { foot.db = +b.dataset.db; document.querySelectorAll('.db').forEach((x) => x.setAttribute('aria-pressed', x === b)); $('deb-in').hidden = !foot.db; }
  if (b.classList.contains('ab')) { foot.ab = b.dataset.ab; document.querySelectorAll('.ab').forEach((x) => x.setAttribute('aria-pressed', x === b)); $('ab-a').hidden = foot.ab !== 'an'; }
  footRun();
});
['sw', 'sh', 'hc', 'ha', 'dd', 'aa'].forEach((id) => $(id).addEventListener('input', footRun));

function run() {
  const t1 = slope('p1'), t2 = slope('p2'), a = parseFloat($('a').value), H = parseFloat($('h').value), e = parseFloat($('e').value);
  $('h1').textContent = isFinite(t1) ? (units.p1 === 'deg' ? pct(t1) : f1(t1)) : '';
  $('h2').textContent = isFinite(t2) ? (units.p2 === 'deg' ? pct(t2) : f1(t2)) : '';
  if (![t1, t2, a].every(isFinite) || t1 <= 0 || t2 <= 0 || t1 >= 89 || t2 >= 89 || a <= 0 || a >= 180) return;
  const g = geom(t1, t2, a);
  $('lbl-piece').textContent = mode === 'aret' ? 'Arêtier' : 'Noue';
  $('r-phi').textContent = f1(g.phi); $('r-phip').textContent = pct(g.phi);
  $('r-b1').textContent = f1(g.beta); $('r-b2').textContent = f1(g.beta2);
  $('r-d1').textContent = f1(g.d1); $('r-d2').textContent = f1(g.d2);
  const sideTxt = mode === 'aret' ? 'en pente vers le pan' : 'en creux';
  $('r-d1s').textContent = sideTxt; $('r-d2s').textContent = sideTxt;
  if (isFinite(H) && H > 0) {
    const Lp = H / Math.tan(g.phi * D), L = H / Math.sin(g.phi * D);
    $('r-L').textContent = metres(L); $('r-Lp').textContent = 'projection en plan ' + metres(Lp);
  }
  $('ar-saw').innerHTML = sawCard('ap', "Coupe d'aplomb (pied et tête), pièce sur chant", { mit: g.phi, bev: 0 });
  const j1 = jack(t1, g.beta), j2 = jack(t2, g.beta2);
  $('e1-saw').innerHTML = sawCard('e1f', 'Pièce à plat', j1.flat) + sawCard('e1c', 'Pièce sur chant', j1.edge);
  $('e2-saw').innerHTML = sawCard('e2f', 'Pièce à plat', j2.flat) + sawCard('e2c', 'Pièce sur chant', j2.edge);
  if (isFinite(e) && e > 0) {
    const dl1 = e * Math.tan(g.beta * D) / Math.cos(t1 * D), dl2 = e * Math.tan(g.beta2 * D) / Math.cos(t2 * D);
    $('e1-dl').textContent = isFinite(dl1) ? dl1.toFixed(1).replace('.', ',') + ' cm' : '–';
    $('e2-dl').textContent = isFinite(dl2) ? dl2.toFixed(1).replace('.', ',') + ' cm' : '–';
  }
  drawPlan(a, g.beta);
  lastG = g; lastT = [t1, t2]; $('pc-ar').textContent = mode === 'aret' ? 'Arêtier' : 'Noue'; footRun();
}

function drawPlan(a, beta) {
  const ox = 60, oy = 180, L = 200;
  const ex2 = ox + L * Math.cos(a * D), ey2 = oy - L * Math.sin(a * D);
  const hx = ox + 170 * Math.cos(beta * D), hy = oy - 170 * Math.sin(beta * D);
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue('--ink').trim(), gold = css.getPropertyValue('--gold').trim(), muted = css.getPropertyValue('--muted').trim();
  $('plan').innerHTML = `
    <line x1="${ox}" y1="${oy}" x2="${ox + L}" y2="${oy}" stroke="${ink}" stroke-width="4"/>
    <line x1="${ox}" y1="${oy}" x2="${ex2}" y2="${ey2}" stroke="${ink}" stroke-width="4"/>
    <line x1="${ox}" y1="${oy}" x2="${hx}" y2="${hy}" stroke="${gold}" stroke-width="3" stroke-dasharray="${mode === 'noue' ? '6 5' : '0'}"/>
    <text x="${ox + L - 4}" y="${oy + 18}" text-anchor="end" fill="${muted}" font-size="12" font-family="${POLICE}">Sablière 1 (pan 1)</text>
    <text x="${Math.min(300, ex2 + 6)}" y="${Math.max(14, ey2 + 4)}" fill="${muted}" font-size="12" font-family="${POLICE}">Sablière 2</text>
    <text x="${hx + 6}" y="${hy}" fill="${gold}" font-size="13" font-weight="600" font-family="${POLICE}">${mode === 'aret' ? 'Arêtier' : 'Noue'}</text>
    <text x="${ox + 34}" y="${oy - 8}" fill="${ink}" font-size="12" font-family="${POLICE}">${f1(beta)}</text>`;
}

['p1', 'p2', 'a', 'h', 'e'].forEach((id) => $(id).addEventListener('input', run));
['1', '2'].forEach((k) => $('u' + k).addEventListener('click', () => {
  const id = 'p' + k, cur = slope(id);
  units[id] = units[id] === 'deg' ? 'pct' : 'deg';
  $('u' + k).textContent = units[id] === 'deg' ? '°' : '%';
  if (isFinite(cur)) $(id).value = units[id] === 'deg' ? cur.toFixed(1) : (Math.tan(cur * D) * 100).toFixed(1);
  run();
}));
function setMode(m) { mode = m; $('m-aret').setAttribute('aria-pressed', m === 'aret'); $('m-noue').setAttribute('aria-pressed', m === 'noue'); run(); }
$('m-aret').addEventListener('click', () => setMode('aret'));
$('m-noue').addEventListener('click', () => setMode('noue'));
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', run);
run();

// Garder le calcul : l'appli l'ouvre en note « Info » à ranger dans un chantier.
$('garder').addEventListener('click', () => {
  const t = (id) => $(id).textContent;
  const texte = [
    `Calcul ${mode === 'aret' ? 'arêtier' : 'noue'}`,
    `Pentes ${$('p1').value}${units.p1 === 'deg' ? '°' : ' %'} / ${$('p2').value}${units.p2 === 'deg' ? '°' : ' %'} · angle en plan ${$('a').value}° · hauteur ${$('h').value.replace('.', ',')} m · entraxe ${$('e').value} cm`,
    `Pente ${mode === 'aret' ? 'arêtier' : 'noue'} : ${t('r-phi')} (${t('r-phip')})`,
    `Angles en plan : ${t('r-b1')} / ${t('r-b2')}`,
    `Délardement : ${t('r-d1')} / ${t('r-d2')}`,
    `Longueur vraie : ${t('r-L')} (${t('r-Lp')})`,
    `Écart empannons : pan 1 ${t('e1-dl')} · pan 2 ${t('e2-dl')}`,
  ].join('\n');
  try { localStorage.setItem('calcul-a-garder', texte); } catch { /* stockage indisponible */ }
  location.href = './';
});
