// Isometric CSS-3D city, ported from the "City · 3D" reference design.
// renderCity(client, opts) returns the HTML for the 1100x1100 ground plane.
//
// Orientation: the plane is rotateX(60) rotateZ(-45), so local +x points up-right on
// screen and +y points down-right. The two walls a viewer can see are the south wall
// (y = depth, facing +y) and the west wall (x = 0, facing -x).
(function () {
  const SKY = window.SKY;
  const INK = '#26303A';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // west wall (sunlit) / south wall (shade) / roof / roof edge
  const PAL = {
    cream: ['#FFD3B0', '#E8A87A', '#FFE0C8', '#F5BB92'],
    peach: ['#FFB898', '#E58866', '#FFC9B2', '#F49A78'],
    butter: ['#FFE08E', '#E8B94F', '#FFE9AE', '#F5CA62'],
    lilac: ['#C3ADD9', '#957BB3', '#D2C1E2', '#A88DC3'],
    blue: ['#86B6EA', '#4C88CC', '#A6CBF2', '#5E9ADC'],
    lav: ['#E4DFF9', '#B5ACE3', '#EEEBFB', '#C9C1EE']
  };
  const PAL_BY_WS = { 'payroll-setup': 'lilac', 'employee-data-import': 'blue', 'tax-setup': 'cream', benefits: 'peach', training: 'lav', 'time-and-attendance': 'butter', onboarding: 'peach' };
  const PAL_CYCLE = ['blue', 'lilac', 'cream', 'butter', 'peach', 'lav'];
  const WS_ORDER = ['payroll-setup', 'employee-data-import', 'tax-setup', 'benefits', 'training', 'time-and-attendance', 'onboarding'];
  // One building per block around the park.
  const SLOTS = [
    { x: 450, y: 110, w: 150, d: 140 },
    { x: 830, y: 470, w: 150, d: 140 },
    { x: 100, y: 470, w: 140, d: 130 },
    { x: 450, y: 840, w: 150, d: 120 },
    { x: 860, y: 90, w: 120, d: 110 },
    { x: 840, y: 840, w: 130, d: 130 },
    { x: 100, y: 90, w: 130, d: 120 },
    { x: 100, y: 840, w: 130, d: 120 }
  ];
  const H = (pct) => Math.round(70 + pct * 2.3);
  const hash = (i) => ((i * 9301 + 49297) % 233280) / 233280;
  const winList = (span, room, glass, lit, ratio, seed) => {
    const cols = Math.max(1, Math.floor((span - 10) / 21));
    const rows = Math.max(0, Math.floor(room / 22));
    const out = [];
    for (let i = 0; i < cols * rows; i++) out.push(hash(i * 13 + seed * 7) < ratio ? lit : glass);
    return out;
  };
  const tagThemes = {
    ok: ['#FFF7E8', INK], fire: ['#F0552E', '#FFFFFF'], contained: ['#CFE3DA', INK],
    quiet: ['#3E4B5A', '#EEF2F1'], smoke: ['#E7E4F1', INK], opp: ['#F2C230', INK]
  };

  SKY.layoutCity = function (c) {
    const sorted = c.ws.slice().sort((a, b) => {
      const ia = WS_ORDER.indexOf(a.id), ib = WS_ORDER.indexOf(b.id);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    }).slice(0, SLOTS.length);
    return { placed: sorted.map((w, i) => ({ w, slot: SLOTS[i], idx: i })), free: SLOTS.slice(sorted.length) };
  };

  // Which workstreams each open fire is blocking, from the handoff chains.
  SKY.blockedMap = function (c) {
    const out = {};
    (c.jams || []).forEach((j) => {
      const root = c.ws.find((w) => w.id === j.wsId);
      if (!root || root.status !== 'fire') return;
      new Set(j.cars.map((e) => e.wsId)).forEach((id) => { if (id !== j.wsId) (out[id] = out[id] || []).push(j.wsId); });
    });
    return out;
  };

  const blocks = [
    [12, 12, 306, 306], [402, 12, 296, 306], [782, 12, 306, 306],
    [12, 402, 306, 296], [402, 402, 296, 296], [782, 402, 306, 296],
    [12, 782, 306, 306], [402, 782, 296, 306], [782, 782, 306, 306]
  ];
  const roads = [
    { x: 330, y: 0, w: 60, h: 1100, v: true }, { x: 710, y: 0, w: 60, h: 1100, v: true },
    { x: 0, y: 330, w: 1100, h: 60, v: false }, { x: 0, y: 710, w: 1100, h: 60, v: false }
  ];
  const zebraV = 'repeating-linear-gradient(90deg, #EEF2F1 0 7px, transparent 7px 13px)';
  const zebraH = 'repeating-linear-gradient(0deg, #EEF2F1 0 7px, transparent 7px 13px)';
  const crosswalks = [
    [334, 304, 52, 22, zebraV], [304, 334, 22, 52, zebraH], [714, 394, 52, 22, zebraV], [774, 334, 22, 52, zebraH],
    [334, 774, 52, 22, zebraV], [394, 714, 22, 52, zebraH], [714, 684, 52, 22, zebraV], [684, 714, 22, 52, zebraH]
  ];
  const streetTrees = [
    [318, 60], [318, 160], [318, 260], [318, 450], [318, 560], [318, 660], [318, 840], [318, 940], [318, 1050],
    [784, 60], [784, 160], [784, 260], [784, 440], [784, 680], [784, 840], [784, 940], [784, 1050],
    [60, 318], [160, 318], [260, 318], [440, 318], [640, 318], [860, 318], [960, 318], [1060, 318],
    [60, 784], [160, 784], [440, 784], [640, 784], [860, 784], [960, 784], [1060, 784],
    [270, 80], [270, 280], [660, 120], [660, 60], [1050, 60], [1050, 290], [270, 860], [280, 1060], [1050, 860], [900, 1050], [660, 1000], [420, 1000],
    [270, 450], [270, 640], [1040, 460], [1040, 640], [930, 650], [60, 650]
  ];
  const parkTrees = [[430, 640], [470, 680], [600, 420], [680, 430], [680, 520], [690, 600], [650, 680], [520, 690], [590, 680], [630, 470], [440, 560]];
  const bushes = [[300, 120], [300, 210], [300, 500], [300, 600], [300, 900], [300, 990], [800, 120], [800, 210], [800, 500], [800, 580], [800, 900], [800, 990],
    [120, 300], [220, 300], [480, 300], [600, 300], [880, 300], [990, 300], [120, 800], [220, 800], [500, 800], [600, 800], [900, 800], [1000, 800],
    [420, 600], [475, 640], [625, 440], [660, 560], [580, 640], [500, 470]];
  const parkBeds = [[410, 512, 80, 14], [612, 512, 76, 14], [512, 412, 14, 76], [512, 612, 14, 76], [600, 600, 40, 40]];

  const BILL = 'transform-origin: 50% 100%; transform: rotateZ(45deg) rotateX(-60deg);';

  const FIRE_SVG = '<svg width="100" height="120" viewBox="0 0 100 120" aria-hidden="true" style="position:absolute;left:0;bottom:0;overflow:visible">' +
    '<circle cx="40" cy="40" r="12" fill="#6F7884" stroke="#26303A" stroke-width="2" style="animation:puff 2.4s ease-out infinite"/>' +
    '<circle cx="62" cy="30" r="15" fill="#8A929C" stroke="#26303A" stroke-width="2" style="animation:puff 2.4s ease-out .8s infinite"/>' +
    '<circle cx="50" cy="20" r="10" fill="#5F6873" stroke="#26303A" stroke-width="2" style="animation:puff 2.4s ease-out 1.6s infinite"/>' +
    '<g style="transform-origin:50px 120px;animation:flick .5s ease-in-out infinite"><path d="M50 40 C65 60 80 74 78 96 C77 112 64 120 50 120 C35 120 22 112 22 96 C22 80 36 74 38 58 C43 68 47 70 50 40Z" fill="#F0552E" stroke="#26303A" stroke-width="2.5" stroke-linejoin="round"/></g>' +
    '<g style="transform-origin:28px 120px;animation:flick2 .45s ease-in-out infinite"><path d="M28 74 C37 87 41 96 39 106 C38 115 33 120 26 120 C19 120 13 114 14 106 C15 97 21 93 22 84 C24 89 27 89 28 74Z" fill="#F7823A" stroke="#26303A" stroke-width="2" stroke-linejoin="round"/></g>' +
    '<g style="transform-origin:74px 120px;animation:flick2 .5s ease-in-out infinite"><path d="M74 80 C82 90 86 98 84 107 C83 115 79 120 74 120 C68 120 63 115 64 107 C65 99 70 96 71 88 C72 91 73 91 74 80Z" fill="#F7823A" stroke="#26303A" stroke-width="2" stroke-linejoin="round"/></g>' +
    '<g style="transform-origin:50px 120px;animation:flick2 .4s ease-in-out infinite"><path d="M50 74 C60 88 64 97 62 106 C60 115 55 119 50 119 C44 119 38 114 38 106 C38 97 45 92 46 83 C48 88 49 88 50 74Z" fill="#FFD04D" stroke="#26303A" stroke-width="2" stroke-linejoin="round"/></g></svg>';
  const SMOKE_SVG = (light) => '<svg width="60" height="70" viewBox="0 0 60 70" aria-hidden="true" style="position:absolute;left:0;bottom:0;overflow:visible">' +
    '<circle cx="26" cy="54" r="8" fill="' + (light ? '#E3ECE8' : '#D9CFDE') + '" stroke="#26303A" stroke-width="1.8" style="animation:puff 3s ease-out infinite"/>' +
    '<circle cx="38" cy="46" r="10" fill="' + (light ? '#F1F5F3' : '#E7E4F1') + '" stroke="#26303A" stroke-width="1.8" style="animation:puff 3s ease-out 1.5s infinite"/></svg>';
  const BEACON_SVG = '<svg width="110" height="110" viewBox="0 0 110 110" aria-hidden="true" style="position:absolute;left:0;bottom:0;overflow:visible">' +
    '<g style="transform-origin:55px 50px;animation:rays 10s linear infinite"><path d="M55 50 L49 0 L61 0Z M55 50 L104 44 L104 56Z M55 50 L61 100 L49 100Z M55 50 L6 56 L6 44Z M55 50 L90 12 L98 20Z M55 50 L98 80 L90 88Z M55 50 L20 88 L12 80Z M55 50 L12 20 L20 12Z" fill="#FFE27A" opacity="0.75" style="animation:beacon 1.6s ease-in-out infinite"/></g>' +
    '<path d="M55 30 L61 44 L76 45 L64 54 L68 69 L55 61 L42 69 L46 54 L34 45 L49 44Z" fill="#F2C230" stroke="#26303A" stroke-width="2.2" stroke-linejoin="round"/>' +
    '<line x1="55" y1="66" x2="55" y2="110" stroke="#26303A" stroke-width="2"/></svg>';

  // ---------- greenery ----------
  // Blob canopies: an ink layer, a shade layer, the main colour nudged up (leaving a
  // shaded crescent at the bottom), then highlights.
  const TREE_PAL = {
    leaf: ['#7FA36B', '#5E8455', '#A6C68A'],
    olive: ['#C9B45C', '#A08F45', '#E3D28A'],
    teal: ['#6FA79C', '#4F857B', '#98C8BE'],
    cherry: ['#F4A9BC', '#DC849C', '#FCD6DF']
  };
  function blobs(circles, pal, dy) {
    return '<g fill="' + INK + '">' + circles.map((c) => '<circle cx="' + c[0] + '" cy="' + c[1] + '" r="' + (c[2] + 1.6) + '"/>').join('') + '</g>' +
      '<g fill="' + pal[1] + '">' + circles.map((c) => '<circle cx="' + c[0] + '" cy="' + c[1] + '" r="' + c[2] + '"/>').join('') + '</g>' +
      '<g fill="' + pal[0] + '">' + circles.map((c) => '<circle cx="' + c[0] + '" cy="' + (c[1] - dy) + '" r="' + (c[2] - 1.2) + '"/>').join('') + '</g>';
  }
  function treeSvg(kind, seed) {
    const trunk = '<path d="M18.5 54 L19.2 34 L20.8 34 L21.5 54Z" fill="#6B5444" stroke="' + INK + '" stroke-width="1.4" stroke-linejoin="round"/>';
    if (kind === 'pine') {
      const p = TREE_PAL.teal;
      return '<svg width="40" height="56" viewBox="0 0 40 56">' + trunk +
        '<path d="M20 4 L31 22 L26 22 L34 36 L27 36 L36 48 L4 48 L13 36 L6 36 L14 22 L9 22Z" fill="' + p[1] + '" stroke="' + INK + '" stroke-width="1.6" stroke-linejoin="round"/>' +
        '<path d="M20 8 L27 20 L22 20 L28 32 L22 32 L29 43 L20 43Z" fill="' + p[0] + '"/><path d="M19 10 L15 19 L19 18Z" fill="' + p[2] + '"/></svg>';
    }
    const pal = TREE_PAL[kind];
    const cs = seed % 2 ? [[20, 22, 13], [10, 29, 9], [30, 29, 9], [20, 13, 9]] : [[20, 21, 12], [11, 27, 10], [29, 26, 10], [16, 13, 8], [26, 14, 7]];
    let hi = '<circle cx="15" cy="16" r="4" fill="' + pal[2] + '"/><circle cx="25" cy="21" r="2.6" fill="' + pal[2] + '"/>';
    if (kind === 'cherry') {
      const dots = [[12, 22], [18, 12], [27, 18], [23, 29], [9, 30], [31, 30], [17, 26], [24, 10]];
      hi += dots.map((d, k) => '<circle cx="' + d[0] + '" cy="' + d[1] + '" r="1.6" fill="' + (k % 3 ? '#FFFFFF' : '#C9607E') + '"/>').join('');
    }
    return '<svg width="40" height="56" viewBox="0 0 40 56">' + trunk + blobs(cs, pal, 2) + hi + '</svg>';
  }
  function bushSvg(seed) {
    const pal = seed % 3 === 0 ? TREE_PAL.olive : TREE_PAL.leaf;
    const fl = ['#F4A9BC', '#FFE27A', '#FFFFFF'][seed % 3];
    return '<svg width="34" height="22" viewBox="0 0 34 22">' + blobs([[9, 14, 7], [17, 11, 8], [25, 14, 7]], pal, 1.5) +
      (seed % 2 ? '' : '<circle cx="11" cy="11" r="1.7" fill="' + fl + '"/><circle cx="19" cy="7" r="1.7" fill="' + fl + '"/><circle cx="24" cy="12" r="1.7" fill="' + fl + '"/><circle cx="15" cy="15" r="1.5" fill="' + fl + '"/>') + '</svg>';
  }
  const shadow = (w) => '<div style="position:absolute;left:' + (-w / 2) + 'px;top:-4px;width:' + w + 'px;height:9px;border-radius:50%;background:rgba(38,48,58,.2)"></div>';
  function tree(x, y, kind, seed) {
    return '<div aria-hidden="true" style="position:absolute;left:' + x + 'px;top:' + y + 'px;width:0;height:0;transform-style:preserve-3d">' + shadow(22) +
      '<div style="position:absolute;left:-20px;bottom:0;width:40px;height:56px;' + BILL + '">' + treeSvg(kind, seed) + '</div></div>';
  }
  function bush(x, y, seed) {
    return '<div aria-hidden="true" style="position:absolute;left:' + x + 'px;top:' + y + 'px;width:0;height:0;transform-style:preserve-3d">' + shadow(26) +
      '<div style="position:absolute;left:-17px;bottom:0;width:34px;height:22px;' + BILL + '">' + bushSvg(seed) + '</div></div>';
  }
  const BED_FLOWERS = ['#F4A9BC', '#FFE27A', '#FFFFFF', '#E9876F'];
  function bed(x, y, w, h, seed) {
    const f = BED_FLOWERS[seed % BED_FLOWERS.length], g = BED_FLOWERS[(seed + 1) % BED_FLOWERS.length];
    return '<div aria-hidden="true" style="position:absolute;left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;border-radius:4px;border:1.5px solid #26303A;box-sizing:border-box;' +
      'background:radial-gradient(circle,' + f + ' 0 2px,transparent 2.6px) 0 0/9px 9px,radial-gradient(circle,' + g + ' 0 1.6px,transparent 2.2px) 4px 4px/9px 9px,#6E9A5E"></div>';
  }
  const KINDS = ['leaf', 'cherry', 'olive', 'leaf', 'pine', 'cherry', 'teal'];

  // ---------- ducks ----------
  const DUCK = (mama) => mama
    ? '<svg class="bob" width="22" height="16" viewBox="0 0 22 16"><path d="M2 10 C2 6 7 5 11 6 L13 6 C13 2 16 1 18 2 C20 3 20 6 18 7 L21 8 L18 9 C19 13 15 15 9 15 C4 15 2 13 2 10Z" fill="#E9E4D6" stroke="#26303A" stroke-width="1.4" stroke-linejoin="round"/><path d="M13.5 6.5 C13.3 3 16 1.8 17.8 2.6 C19.6 3.6 19 6 17.6 7Z" fill="#3F7A63"/><path d="M18 7 L21 8 L18 9Z" fill="#F7A23A" stroke="#26303A" stroke-width="1"/><circle cx="16.6" cy="4.4" r=".9" fill="#26303A"/><path d="M5 10 C8 8.5 11 9 12.5 10.5" fill="none" stroke="#8C8577" stroke-width="1.2"/></svg>'
    : '<svg class="bob" width="13" height="10" viewBox="0 0 13 10"><path d="M1 6 C1 4 4 3.4 6 3.8 C6 1.6 8 .8 9.4 1.4 C10.8 2 10.8 4 9.6 4.6 L12 5.2 L9.8 6 C10 8 8 9.2 5 9.2 C2.4 9.2 1 8 1 6Z" fill="#FFD966" stroke="#26303A" stroke-width="1.1" stroke-linejoin="round"/><circle cx="8.7" cy="2.9" r=".7" fill="#26303A"/></svg>';
  function duck(mama, delay, dur) {
    const w = mama ? 33 : 20, h = mama ? 24 : 15;
    return '<div class="swim" style="animation-duration:' + dur + 's;animation-delay:' + delay + 's">' +
      '<div class="ripple" style="left:' + (-w / 2 - 2) + 'px;width:' + (w + 4) + 'px"></div>' +
      '<div style="position:absolute;left:' + (-w / 2) + 'px;bottom:-2px;width:' + w + 'px;height:' + h + 'px;' + BILL + '">' + DUCK(mama).replace(/width="\d+" height="\d+"/, 'width="' + w + '" height="' + h + '"') + '</div></div>';
  }

  // ---------- buildings ----------
  function windowsHtml(list) { return list.map((c) => '<span class="cw" style="background:' + c + '"></span>').join(''); }
  function wall(o) {
    return '<div aria-hidden="true" style="position:absolute;left:' + o.left + 'px;top:' + o.top + 'px;width:' + o.width + 'px;height:' + o.h + 'px;transform-origin:0 100%;transform:' + o.tf + ';background:' + o.bg + ';border:1.5px solid #26303A;box-sizing:border-box;display:flex;flex-direction:column;padding:8px 6px 0">' +
      '<div class="cwins">' + windowsHtml(o.wins) + '</div>' +
      '<div style="height:' + o.baseH + 'px;display:flex;gap:4px;padding:4px 0 0;flex-shrink:0;border-top:1.5px solid #26303A;margin:0 -6px;padding-left:6px;padding-right:6px">' +
      '<span style="flex:1;background:' + o.shop + ';border:1.5px solid #26303A;border-bottom:0"></span>' + (o.door ? '<span style="width:12px;background:#3E4B5A;border:1.5px solid #26303A;border-bottom:0"></span>' : '') + '</div></div>';
  }

  function building(b, mini) {
    const { x, y, w, d, h, pal } = b;
    const plinth = b.blocked ? 'repeating-linear-gradient(45deg,#F2C230 0 8px,#26303A 8px 16px)' : '#C7D1D4';
    let html = '<div aria-hidden="true" style="position:absolute;left:-8px;top:-8px;right:-8px;bottom:-8px;background:' + plinth + ';box-shadow:inset 0 0 0 1.5px #26303A"></div>' +
      '<div aria-hidden="true" style="position:absolute;inset:0;transform:translateZ(' + h + 'px);background:' + pal[2] + ';border:1.5px solid #26303A;box-sizing:border-box;box-shadow:inset 0 0 0 6px ' + pal[3] + ',inset 0 0 0 7.5px #26303A"></div>';
    // south wall: along y = d, facing +y (lower right on screen)
    html += wall({ left: 0, top: d - h, width: w, h, tf: 'rotateX(-90deg)', bg: pal[1], wins: b.sWins, baseH: b.baseH, shop: b.shop, door: true });
    // west wall: along x = 0, facing -x (lower left on screen)
    html += wall({ left: 0, top: -h, width: d, h, tf: 'rotateZ(90deg) rotateX(-90deg)', bg: pal[0], wins: b.wWins, baseH: b.baseH, shop: b.shop });
    if (b.labeled) {
      let fx = '<div style="position:absolute;left:' + Math.round(w / 2) + 'px;top:' + Math.round(d / 2) + 'px;width:0;height:0;transform-style:preserve-3d;transform:translateZ(' + h + 'px)">';
      const fxEl = (label, svg) => mini ? '<span class="cfx" aria-hidden="true">' + svg + '</span>' : '<button type="button" class="cfx" data-pick="' + b.pick + '" aria-label="' + esc(label) + '">' + svg + '</button>';
      if (b.onFire) fx += '<div style="position:absolute;left:-50px;bottom:0;width:100px;height:120px;' + BILL + '">' + fxEl('Fire at ' + b.name, FIRE_SVG) + '</div>';
      if (b.smoky) fx += '<div aria-hidden="true" style="position:absolute;left:-30px;bottom:0;width:60px;height:70px;' + BILL + '">' + SMOKE_SVG(b.status === 'contained') + '</div>';
      if (b.isOpp) fx += '<div style="position:absolute;left:' + (b.onFire ? 10 : -55) + 'px;bottom:0;width:110px;height:110px;' + BILL + '">' + fxEl('New opportunity at ' + b.name, BEACON_SVG) + '</div>';
      // The lift lives inside the billboard (padding), so the tag rises straight up on screen
      // instead of sliding along the ground plane.
      if (!mini) fx += '<div style="position:absolute;left:-130px;bottom:0;width:260px;display:flex;flex-direction:column;align-items:center;padding-bottom:' + b.tagBottom + 'px;' + BILL + '">' +
        '<button type="button" class="ctag" data-pick="' + b.pick + '" aria-label="' + esc(b.aria) + '" style="background:' + b.tagBg + ';color:' + b.tagFg + '">' + esc(b.tag) + (b.blocked ? '<span class="blk">BLOCKED</span>' : '') + '</button>' +
        '<span aria-hidden="true" style="width:1.5px;height:12px;background:#26303A"></span></div>';
      html += fx + '</div>';
    }
    return '<div class="cbld"' + (b.pick && !mini ? ' data-pick="' + b.pick + '"' : '') + ' style="position:absolute;left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + d + 'px;transform-style:preserve-3d">' + html + '</div>';
  }

  SKY.renderCity = function (c, opts) {
    opts = opts || {};
    const mini = !!opts.mini;
    const L = SKY.layoutCity(c);
    const blocked = SKY.blockedMap(c);
    const parts = [];
    parts.push('<div aria-hidden="true" style="position:absolute;inset:0;background-color:#C7D1D4;background-image:repeating-linear-gradient(90deg,rgba(38,48,58,.09) 0 1px,transparent 1px 20px),repeating-linear-gradient(0deg,rgba(38,48,58,.09) 0 1px,transparent 1px 20px)"></div>');
    blocks.forEach((g, i) => parts.push('<div aria-hidden="true" style="position:absolute;left:' + g[0] + 'px;top:' + g[1] + 'px;width:' + g[2] + 'px;height:' + g[3] + 'px;background:' + (i === 4 ? '#8FBD95' : i % 2 ? '#8FB89C' : '#96BEA3') + ';box-shadow:inset 0 0 0 1.5px #26303A"></div>'));
    roads.forEach((r) => parts.push('<div aria-hidden="true" style="position:absolute;left:' + r.x + 'px;top:' + r.y + 'px;width:' + r.w + 'px;height:' + r.h + 'px;background:#5E6670;box-shadow:inset 0 0 0 1.5px #26303A">' +
      '<div style="position:absolute;' + (r.v ? 'left:29px;top:0;width:2px;height:100%;background:repeating-linear-gradient(180deg,#DDE5E8 0 14px,transparent 14px 30px)' : 'left:0;top:29px;width:100%;height:2px;background:repeating-linear-gradient(90deg,#DDE5E8 0 14px,transparent 14px 30px)') + '"></div></div>'));
    [[330, 330], [710, 330], [330, 710], [710, 710]].forEach((j) => parts.push('<div aria-hidden="true" style="position:absolute;left:' + j[0] + 'px;top:' + j[1] + 'px;width:60px;height:60px;background:#5E6670"></div>'));
    if (!mini) crosswalks.forEach((z) => parts.push('<div aria-hidden="true" style="position:absolute;left:' + z[0] + 'px;top:' + z[1] + 'px;width:' + z[2] + 'px;height:' + z[3] + 'px;background:' + z[4] + '"></div>'));

    // park: paths, plaza, ponds
    parts.push('<div aria-hidden="true" style="position:absolute;left:402px;top:538px;width:296px;height:24px;background:#E6DCC8;box-shadow:inset 0 0 0 1.5px #26303A"></div>' +
      '<div aria-hidden="true" style="position:absolute;left:538px;top:402px;width:24px;height:296px;background:#E6DCC8;box-shadow:inset 0 0 0 1.5px #26303A"></div>' +
      '<div aria-hidden="true" style="position:absolute;left:500px;top:500px;width:100px;height:100px;border-radius:50%;background:#EEE6D4;border:1.5px solid #26303A;box-sizing:border-box"></div>' +
      '<div aria-hidden="true" style="position:absolute;left:524px;top:524px;width:52px;height:52px;border-radius:50%;background:#9CC9DD;border:1.5px solid #26303A;box-sizing:border-box"></div>' +
      '<div aria-hidden="true" style="position:absolute;left:412px;top:414px;width:112px;height:76px;border-radius:50%;background:#8FC1D9;border:1.5px solid #26303A;box-sizing:border-box;box-shadow:inset 0 0 0 5px #A9D2E4"></div>');
    if (!mini) {
      parkBeds.forEach((p, i) => parts.push(bed(p[0], p[1], p[2], p[3], i)));
      parts.push('<div aria-hidden="true" style="position:absolute;left:468px;top:452px;width:0;height:0;transform-style:preserve-3d">' +
        duck(true, 0, 16) + duck(false, -1.4, 16) + duck(false, -2.6, 16) + duck(false, -3.8, 16) + '</div>' +
        '<div aria-hidden="true" style="position:absolute;left:550px;top:550px;width:0;height:0;transform-style:preserve-3d"><div class="swim swim-sm" style="animation-duration:11s">' +
        '<div class="ripple" style="left:-16px;width:32px"></div><div style="position:absolute;left:-14px;bottom:-2px;width:28px;height:20px;' + BILL + '">' + DUCK(true).replace(/width="\d+" height="\d+"/, 'width="28" height="20"') + '</div></div></div>');
    }

    // fire → blocked lines on the ground
    const centre = {};
    L.placed.forEach(({ w, slot }) => { centre[w.id] = [slot.x + slot.w / 2, slot.y + slot.d / 2]; });
    const lines = [];
    Object.keys(blocked).forEach((bid) => blocked[bid].forEach((fid) => { if (centre[bid] && centre[fid]) lines.push([centre[fid], centre[bid]]); }));
    if (lines.length) parts.push('<svg aria-hidden="true" width="1100" height="1100" style="position:absolute;left:0;top:0;transform:translateZ(1px);overflow:visible">' +
      lines.map((l) => '<line x1="' + l[0][0] + '" y1="' + l[0][1] + '" x2="' + l[1][0] + '" y2="' + l[1][1] + '" stroke="#26303A" stroke-width="10" stroke-linecap="round"/>' +
        '<line class="spread" x1="' + l[0][0] + '" y1="' + l[0][1] + '" x2="' + l[1][0] + '" y2="' + l[1][1] + '" stroke="#F0552E" stroke-width="6" stroke-linecap="round" stroke-dasharray="16 12"/>').join('') + '</svg>');

    // buildings
    const rects = [];
    const blds = [];
    L.placed.forEach(({ w, slot, idx }) => {
      const pal = PAL[PAL_BY_WS[w.id] || PAL_CYCLE[idx % PAL_CYCLE.length]];
      const h = H(w.pct);
      const st = w.status;
      let glass = '#EEF3FF', lit = '#FFE066', ratio = Math.min(0.85, 0.12 + w.recent / 10), shop = '#E3ECFF';
      if (st === 'quiet') { glass = '#3F3B5A'; lit = '#3F3B5A'; shop = 'repeating-linear-gradient(0deg,#957BB3 0 4px,#6A5888 4px 6px)'; }
      if (w.opp) lit = '#FFB800';
      if (st === 'fire') { lit = '#F7823A'; glass = '#F6B48A'; ratio = 0.7; }
      const tt = tagThemes[st] || tagThemes.ok;
      const tag = (w.opp ? '★ ' : '') + w.pct + '% · ' + w.name.toUpperCase();
      blds.push({
        x: slot.x, y: slot.y, w: slot.w, d: slot.d, h, pal,
        sWins: winList(slot.w, h - 8 - 34, glass, lit, ratio, idx), wWins: winList(slot.d, h - 8 - 34, glass, lit, ratio, idx + 3),
        shop, baseH: 28, labeled: true, name: w.name, status: st, blocked: !!blocked[w.id],
        onFire: st === 'fire', smoky: st === 'smoke' || st === 'contained', isOpp: w.opp,
        tag, tagBg: tt[0], tagFg: tt[1], tagBottom: st === 'fire' ? 118 : w.opp ? 104 : st === 'smoke' || st === 'contained' ? 62 : 14,
        aria: w.name + ', ' + w.pct + '%, ' + ({ fire: 'on fire', contained: 'fire contained', smoke: 'smoky', quiet: 'lights off', opp: 'opportunity' }[st] || 'healthy') + (blocked[w.id] ? ', blocked by a fire' : ''),
        pick: 'ws:' + w.id
      });
      rects.push([slot.x, slot.y, slot.w, slot.d]);
    });
    blds.forEach((b) => parts.push(building(b, mini)));

    if (!mini) {
      L.placed.forEach(({ slot }, i) => {
        parts.push(bed(slot.x, slot.y + slot.d + 14, slot.w, 12, i));
        parts.push(bed(slot.x - 26, slot.y, 12, slot.d, i + 2));
      });
    }
    // empty lots become small forests
    const greens = [];
    L.free.forEach((slot, si) => {
      const n = mini ? 6 : 14;
      for (let i = 0; i < n; i++) {
        const gx = slot.x - 20 + Math.round(hash(i * 7 + si * 31) * (slot.w + 40));
        const gy = slot.y - 30 + Math.round(((i + 0.5) / n) * (slot.d + 60));
        greens.push([gx, gy, KINDS[(i + si) % KINDS.length]]);
      }
      if (!mini) for (let i = 0; i < 6; i++) greens.push([slot.x + Math.round(hash(i * 11 + si * 5 + 3) * slot.w), slot.y + Math.round(hash(i * 13 + si) * slot.d), 'bush']);
    });
    const hits = (x, y, r) => r.some((q) => x >= q[0] - 14 && x <= q[0] + q[2] + 14 && y >= q[1] - 14 && y <= q[1] + q[3] + 30);
    if (!mini) {
      streetTrees.forEach((p, i) => greens.push([p[0], p[1], i % 3 === 1 ? 'cherry' : KINDS[i % KINDS.length]]));
      parkTrees.forEach((p, i) => greens.push([p[0], p[1], i % 2 ? 'cherry' : i % 3 ? 'leaf' : 'olive']));
      bushes.forEach((p) => greens.push([p[0], p[1], 'bush']));
    }
    greens.filter((g) => !hits(g[0], g[1], rects)).forEach((g, i) => parts.push(g[2] === 'bush' ? bush(g[0], g[1], i) : tree(g[0], g[1], g[2], i)));
    return parts.join('');
  };
})();
