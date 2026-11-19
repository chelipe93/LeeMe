/**
 * Motor interactivo de Grafo de Relaciones de Personajes en HTML5 Canvas HiDPI (Vanilla JS).
 * Física Force-Directed (repulsión Coulomb + atracción Hooke + gravedad central),
 * colores por comunidad Louvain, aristas codificadas por peso y tono afectivo,
 * arrastre de nodos, pan/zoom, inspección de nodos/aristas y exportación PNG.
 */
class CharacterGraphRenderer {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSelectNode = callbacks.onSelectNode || (() => {});
    this.onSelectEdge = callbacks.onSelectEdge || (() => {});

    this.palette = [
      '#38bdf8', '#f59e0b', '#34d399', '#f472b6', '#a78bfa',
      '#fb7185', '#2dd4bf', '#facc15', '#60a5fa', '#c084fc'
    ];
    this.toneColors = {
      'afinidad':    '#34d399',
      'tensión':     '#f87171',
      'ambivalente': '#fbbf24',
      'neutral':     '#94a3b8'
    };

    this.allNodes = [];
    this.allEdges = [];
    this.nodes = [];
    this.edges = [];
    this.nodeMap = new Map();

    this.minWeight = 6;
    this.chapterFilter = 'all';
    this.searchTerm = '';

    this.cam = { x: 0, y: 0, k: 1 };
    this.dragNode = null;
    this.isPanning = false;
    this.panStart = { x: 0, y: 0 };
    this.hoveredNode = null;
    this.selectedNode = null;
    this.selectedEdge = null;
    this.alpha = 1.0;
    this.animId = null;

    this._bindEvents();
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  getCommunityColor(cid) {
    return this.palette[Math.abs(cid || 0) % this.palette.length];
  }

  setData(characters, relations) {
    this.allNodes = characters.map((c, idx) => ({
      ...c,
      id: Number(c.id),
      x: Math.cos((idx / Math.max(1, characters.length)) * Math.PI * 2) * (160 + (idx % 4) * 45),
      y: Math.sin((idx / Math.max(1, characters.length)) * Math.PI * 2) * (160 + (idx % 4) * 45),
      vx: 0,
      vy: 0,
      radius: 10 + Math.sqrt(Math.max(1, c.mention_count)) * 1.15
    }));
    this.allEdges = relations.map((r) => ({
      ...r,
      source: Number(r.source),
      target: Number(r.target)
    }));

    this.selectedNode = null;
    this.selectedEdge = null;
    this.applyFilters();
    this.resetCamera();
    this.startLoop();
  }

  applyFilters({ minWeight, chapterFilter, searchTerm } = {}) {
    if (minWeight !== undefined) this.minWeight = Number(minWeight);
    if (chapterFilter !== undefined) this.chapterFilter = String(chapterFilter);
    if (searchTerm !== undefined) this.searchTerm = (searchTerm || '').trim().toLowerCase();

    const chId = this.chapterFilter === 'all' ? null : Number(this.chapterFilter);

    // Filtrar nodos activos
    const activeNodes = this.allNodes.filter((n) => {
      if (chId !== null) {
        return n.chapters && (n.chapters[String(chId)] > 0);
      }
      return true;
    });
    const activeIds = new Set(activeNodes.map((n) => n.id));

    // Filtrar aristas
    this.edges = this.allEdges.filter((e) => {
      if (!activeIds.has(e.source) || !activeIds.has(e.target)) return false;
      if (e.weight < this.minWeight) return false;
      if (chId !== null && (!Array.isArray(e.shared_chapters) || !e.shared_chapters.includes(chId))) {
        return false;
      }
      return true;
    });

    this.nodes = activeNodes;
    this.nodeMap = new Map(this.nodes.map((n) => [n.id, n]));
    this.alpha = Math.max(this.alpha, 0.55);
  }

  focusCharacter(charId) {
    const n = this.nodeMap.get(Number(charId));
    if (!n) return;
    this.selectedNode = n;
    this.selectedEdge = null;
    this.cam.x = -n.x * this.cam.k;
    this.cam.y = -n.y * this.cam.k;
    this.onSelectNode(n, this._getIncidentEdges(n.id));
  }

  relayout() {
    this.nodes.forEach((n, idx) => {
      const ang = (idx / Math.max(1, this.nodes.length)) * Math.PI * 2;
      const dist = 120 + (n.community_id % 5) * 55;
      n.x = Math.cos(ang) * dist + (Math.random() - 0.5) * 40;
      n.y = Math.sin(ang) * dist + (Math.random() - 0.5) * 40;
      n.vx = 0;
      n.vy = 0;
    });
    this.alpha = 1.0;
    this.resetCamera();
  }

  resetCamera() {
    this.cam = { x: 0, y: 0, k: 0.92 };
  }

  _resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(300, parent.clientWidth);
    const h = Math.max(300, parent.clientHeight);
    this.width = w;
    this.height = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _screenToWorld(sx, sy) {
    return {
      x: (sx - this.width / 2 - this.cam.x) / this.cam.k,
      y: (sy - this.height / 2 - this.cam.y) / this.cam.k
    };
  }

  _findNodeAt(wx, wy) {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      const dx = wx - n.x;
      const dy = wy - n.y;
      if (dx * dx + dy * dy <= (n.radius + 5) * (n.radius + 5)) {
        return n;
      }
    }
    return null;
  }

  _findEdgeAt(wx, wy) {
    let best = null;
    let bestDist = 8 / this.cam.k;
    for (const e of this.edges) {
      const s = this.nodeMap.get(e.source);
      const t = this.nodeMap.get(e.target);
      if (!s || !t) continue;
      const d = this._pointToSegmentDist(wx, wy, s.x, s.y, t.x, t.y);
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    return best;
  }

  _pointToSegmentDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  _getIncidentEdges(nodeId) {
    return this.edges
      .filter((e) => e.source === nodeId || e.target === nodeId)
      .sort((a, b) => b.weight - a.weight);
  }

  _bindEvents() {
    let downPos = { x: 0, y: 0 };

    this.canvas.addEventListener('mousedown', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      downPos = { x: sx, y: sy };
      const w = this._screenToWorld(sx, sy);
      const hitNode = this._findNodeAt(w.x, w.y);

      if (hitNode) {
        this.dragNode = hitNode;
        this.alpha = Math.max(this.alpha, 0.35);
      } else {
        this.isPanning = true;
        this.panStart = { x: sx - this.cam.x, y: sy - this.cam.y };
      }
    });

    window.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      if (this.dragNode) {
        const w = this._screenToWorld(sx, sy);
        this.dragNode.x = w.x;
        this.dragNode.y = w.y;
        this.dragNode.vx = 0;
        this.dragNode.vy = 0;
        this.alpha = Math.max(this.alpha, 0.2);
        return;
      }
      if (this.isPanning) {
        this.cam.x = sx - this.panStart.x;
        this.cam.y = sy - this.panStart.y;
        return;
      }

      if (sx >= 0 && sy >= 0 && sx <= this.width && sy <= this.height) {
        const w = this._screenToWorld(sx, sy);
        this.hoveredNode = this._findNodeAt(w.x, w.y);
        this.canvas.style.cursor = this.hoveredNode ? 'pointer' : 'grab';
      }
    });

    window.addEventListener('mouseup', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const moved = Math.hypot(sx - downPos.x, sy - downPos.y);

      if (moved < 5 && sx >= 0 && sy >= 0 && sx <= this.width && sy <= this.height) {
        const w = this._screenToWorld(sx, sy);
        const hitNode = this._findNodeAt(w.x, w.y);
        if (hitNode) {
          this.selectedNode = hitNode;
          this.selectedEdge = null;
          this.onSelectNode(hitNode, this._getIncidentEdges(hitNode.id));
        } else {
          const hitEdge = this._findEdgeAt(w.x, w.y);
          if (hitEdge) {
            this.selectedEdge = hitEdge;
            this.selectedNode = null;
            this.onSelectEdge(
              hitEdge,
              this.nodeMap.get(hitEdge.source),
              this.nodeMap.get(hitEdge.target)
            );
          }
        }
      }

      this.dragNode = null;
      this.isPanning = false;
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      this.cam.k = Math.max(0.3, Math.min(3.0, this.cam.k * factor));
    }, { passive: false });
  }

  _stepPhysics() {
    if (this.alpha < 0.008 || this.nodes.length === 0) return;

    const nodes = this.nodes;
    const n = nodes.length;
    const repulsion = 6500;
    const centerGravity = 0.025;

    // Repulsión entre pares de nodos
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distSq = dx * dx + dy * dy + 1.0;
        let dist = Math.sqrt(distSq);
        const minDist = a.radius + b.radius + 26;
        let force = repulsion / distSq;
        if (dist < minDist) force *= 2.4;
        const fx = (dx / dist) * force * this.alpha;
        const fy = (dy / dist) * force * this.alpha;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }

    // Atracción de resortes por aristas (ponderada por log(weight))
    let maxW = 1;
    for (const e of this.edges) {
      if (e.weight > maxW) maxW = e.weight;
    }

    for (const e of this.edges) {
      const s = this.nodeMap.get(e.source);
      const t = this.nodeMap.get(e.target);
      if (!s || !t) continue;
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const normW = Math.log1p(e.weight) / Math.log1p(maxW);
      const ideal = 200 - normW * 95;
      const sameCommBonus = (s.community_id === t.community_id) ? 1.35 : 0.75;
      const f = (dist - ideal) * 0.018 * (0.4 + normW) * sameCommBonus * this.alpha;
      const fx = (dx / dist) * f;
      const fy = (dy / dist) * f;
      s.vx += fx; s.vy += fy;
      t.vx -= fx; t.vy -= fy;
    }

    // Gravedad central e integración con amortiguamiento
    for (const node of nodes) {
      if (node === this.dragNode) continue;
      node.vx += -node.x * centerGravity * this.alpha;
      node.vy += -node.y * centerGravity * this.alpha;
      node.vx *= 0.78;
      node.vy *= 0.78;
      node.x += Math.max(-18, Math.min(18, node.vx));
      node.y += Math.max(-18, Math.min(18, node.vy));
    }

    this.alpha *= 0.985;
  }

  _draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    // Fondo espacial oscuro elegante
    ctx.fillStyle = '#111820';
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.save();
    ctx.translate(this.width / 2 + this.cam.x, this.height / 2 + this.cam.y);
    ctx.scale(this.cam.k, this.cam.k);

    const focusId = this.selectedNode ? this.selectedNode.id : (this.hoveredNode ? this.hoveredNode.id : null);
    const neighbors = new Set();
    if (focusId !== null) {
      neighbors.add(focusId);
      for (const e of this.edges) {
        if (e.source === focusId) neighbors.add(e.target);
        if (e.target === focusId) neighbors.add(e.source);
      }
    }

    let maxW = 1;
    for (const e of this.edges) if (e.weight > maxW) maxW = e.weight;

    // 1. Dibujar aristas
    for (const e of this.edges) {
      const s = this.nodeMap.get(e.source);
      const t = this.nodeMap.get(e.target);
      if (!s || !t) continue;

      const isSelectedEdge = this.selectedEdge === e;
      const isConnectedFocus = focusId !== null && (e.source === focusId || e.target === focusId);
      const dimmed = focusId !== null && !isConnectedFocus;

      const normW = Math.log1p(e.weight) / Math.log1p(maxW);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.strokeStyle = isSelectedEdge ? '#ffffff' : (this.toneColors[e.relation_tone] || '#94a3b8');
      ctx.globalAlpha = isSelectedEdge ? 1 : (dimmed ? 0.08 : (0.28 + normW * 0.55));
      ctx.lineWidth = isSelectedEdge ? 3.5 : (0.8 + normW * 4.2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 2. Dibujar nodos
    for (const n of this.nodes) {
      const matchSearch = this.searchTerm !== '' && n.canonical_name.toLowerCase().includes(this.searchTerm);
      const isSelected = this.selectedNode === n;
      const dimmed = (focusId !== null && !neighbors.has(n.id)) || (this.searchTerm !== '' && !matchSearch);
      const col = this.getCommunityColor(n.community_id);

      ctx.globalAlpha = dimmed ? 0.22 : 1.0;

      // Halo exterior para nodos seleccionados o buscados
      if (isSelected || matchSearch) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius + 6, 0, Math.PI * 2);
        ctx.fillStyle = matchSearch ? 'rgba(250, 204, 21, 0.32)' : 'rgba(255, 255, 255, 0.25)';
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.lineWidth = isSelected ? 3 : 1.6;
      ctx.strokeStyle = isSelected ? '#ffffff' : '#0b1016';
      ctx.stroke();

      // Etiqueta
      ctx.font = `${n.radius > 20 ? '700 12.5px' : '600 11px'} Segoe UI, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const label = n.canonical_name;
      const ly = n.y + n.radius + 5;
      ctx.fillStyle = 'rgba(11, 16, 22, 0.72)';
      const tw = ctx.measureText(label).width;
      ctx.fillRect(n.x - tw / 2 - 4, ly - 1, tw + 8, 15);
      ctx.fillStyle = isSelected || matchSearch ? '#fef08a' : '#eef4f8';
      ctx.fillText(label, n.x, ly);
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  startLoop() {
    if (this.animId !== null) return;
    const tick = () => {
      this._stepPhysics();
      this._draw();
      this.animId = requestAnimationFrame(tick);
    };
    this.animId = requestAnimationFrame(tick);
  }

  exportPng(filename = 'grafo-personajes.png') {
    const a = document.createElement('a');
    a.href = this.canvas.toDataURL('image/png');
    a.download = filename;
    a.click();
  }
}
