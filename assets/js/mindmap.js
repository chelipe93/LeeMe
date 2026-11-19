/**
 * Motor interactivo de Mapas Mentales en SVG puro (Vanilla JS).
 * Soporta layout jerárquico ordenado, colapsar/expandir ramas, pan/zoom,
 * búsqueda de nodos, inspector de detalles y exportación SVG.
 */
class MindMapRenderer {
  constructor(containerEl, onSelectNode) {
    this.container = containerEl;
    this.onSelectNode = onSelectNode || (() => {});
    this.rootData = null;
    this.collapsed = new Set();
    this.selectedId = null;
    this.searchTerm = '';
    this.transform = { x: 60, y: 300, k: 0.9 };
    this.isPanning = false;
    this.panStart = { x: 0, y: 0 };

    this.colors = {
      root:       { bg: '#16222a', stroke: '#16222a', text: '#ffffff' },
      part:       { bg: '#1f4e5f', stroke: '#173c49', text: '#ffffff' },
      cluster:    { bg: '#2b6b7f', stroke: '#1f4e5f', text: '#ffffff' },
      chapter:    { bg: '#e8f1f4', stroke: '#2c6d82', text: '#163540' },
      group:      { bg: '#ede9df', stroke: '#9f947f', text: '#3a342a' },
      note_group: { bg: '#fbf0d4', stroke: '#c88a2b', text: '#6e4a0a' },
      concept:    { bg: '#ffffff', stroke: '#4d9cb3', text: '#1e242b' },
      phrase:     { bg: '#f4f9fb', stroke: '#70a8ba', text: '#1f3b45' },
      character:  { bg: '#edf7f2', stroke: '#2a7f62', text: '#184d3a' },
      summary:    { bg: '#f7f5f0', stroke: '#8c8375', text: '#2e2b26' },
      note:       { bg: '#fff8db', stroke: '#d69e2e', text: '#5c4007' }
    };

    this._initSvg();
  }

  _initSvg() {
    this.container.innerHTML = '';
    const ns = 'http://www.w3.org/2000/svg';
    this.svg = document.createElementNS(ns, 'svg');
    this.svg.setAttribute('xmlns', ns);
    this.gViewport = document.createElementNS(ns, 'g');
    this.gLinks = document.createElementNS(ns, 'g');
    this.gNodes = document.createElementNS(ns, 'g');
    this.gViewport.appendChild(this.gLinks);
    this.gViewport.appendChild(this.gNodes);
    this.svg.appendChild(this.gViewport);
    this.container.appendChild(this.svg);

    // Pan & Zoom
    this.svg.addEventListener('mousedown', (e) => {
      if (e.target.closest('.mm-node')) return;
      this.isPanning = true;
      this.panStart = { x: e.clientX - this.transform.x, y: e.clientY - this.transform.y };
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.isPanning) return;
      this.transform.x = e.clientX - this.panStart.x;
      this.transform.y = e.clientY - this.panStart.y;
      this._applyTransform();
    });
    window.addEventListener('mouseup', () => { this.isPanning = false; });

    this.svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      const rect = this.svg.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      this.zoomAt(factor, mx, my);
    }, { passive: false });
  }

  setData(treeData, defaultCollapseDepth = 2) {
    this.rootData = treeData;
    this.collapsed.clear();
    this.selectedId = null;

    if (treeData && defaultCollapseDepth !== null) {
      const markCollapsed = (node, depth) => {
        if (depth >= defaultCollapseDepth && node.children && node.children.length > 0) {
          this.collapsed.add(node.id);
        } else if (node.children) {
          node.children.forEach((c) => markCollapsed(c, depth + 1));
        }
      };
      markCollapsed(treeData, 0);
    }

    this.render();
    this.fitToScreen();
  }

  setSearch(term) {
    this.searchTerm = (term || '').trim().toLowerCase();
    if (this.searchTerm && this.rootData) {
      // Expandir ancestros de coincidencias
      const expandMatching = (node) => {
        let hit = (node.label || '').toLowerCase().includes(this.searchTerm)
          || (node.meta || '').toLowerCase().includes(this.searchTerm);
        if (node.children) {
          for (const ch of node.children) {
            if (expandMatching(ch)) {
              this.collapsed.delete(node.id);
              hit = true;
            }
          }
        }
        return hit;
      };
      expandMatching(this.rootData);
    }
    this.render();
  }

  expandAll() {
    this.collapsed.clear();
    this.render();
    this.fitToScreen();
  }

  collapseToDepth(maxDepth = 1) {
    this.collapsed.clear();
    if (!this.rootData) return;
    const walk = (n, d) => {
      if (d >= maxDepth && n.children && n.children.length) {
        this.collapsed.add(n.id);
      } else if (n.children) {
        n.children.forEach((c) => walk(c, d + 1));
      }
    };
    walk(this.rootData, 0);
    this.render();
    this.fitToScreen();
  }

  zoom(factor) {
    const rect = this.svg.getBoundingClientRect();
    this.zoomAt(factor, rect.width / 2, rect.height / 2);
  }

  zoomAt(factor, mx, my) {
    const newK = Math.max(0.22, Math.min(2.6, this.transform.k * factor));
    const ratio = newK / this.transform.k;
    this.transform.x = mx - (mx - this.transform.x) * ratio;
    this.transform.y = my - (my - this.transform.y) * ratio;
    this.transform.k = newK;
    this._applyTransform();
  }

  fitToScreen() {
    if (!this._bounds) return;
    const rect = this.svg.getBoundingClientRect();
    const w = Math.max(320, rect.width);
    const h = Math.max(320, rect.height);
    const bw = Math.max(100, this._bounds.maxX - this._bounds.minX + 120);
    const bh = Math.max(100, this._bounds.maxY - this._bounds.minY + 90);
    const k = Math.max(0.28, Math.min(1.15, Math.min(w / bw, h / bh)));
    this.transform.k = k;
    this.transform.x = (w - bw * k) / 2 - (this._bounds.minX - 60) * k;
    this.transform.y = (h - bh * k) / 2 - (this._bounds.minY - 45) * k;
    this._applyTransform();
  }

  _applyTransform() {
    this.gViewport.setAttribute('transform', `translate(${this.transform.x}, ${this.transform.y}) scale(${this.transform.k})`);
  }

  render() {
    this.gLinks.innerHTML = '';
    this.gNodes.innerHTML = '';
    if (!this.rootData) return;

    const nodes = [];
    const links = [];
    const colWidths = [240, 230, 230, 250, 250];
    const rowGap = 48;
    let nextLeafY = 0;

    const measureBox = (label, isRoot) => {
      const text = (label || '').length > 46 ? label.slice(0, 44) + '…' : (label || '');
      const charW = isRoot ? 8.2 : 7.1;
      const w = Math.max(isRoot ? 180 : 120, Math.min(310, Math.round(text.length * charW + 30)));
      const h = isRoot ? 46 : 34;
      return { w, h, display: text };
    };

    const layout = (node, depth, xAcc) => {
      const isRoot = depth === 0;
      const box = measureBox(node.label, isRoot);
      const hasChildren = Array.isArray(node.children) && node.children.length > 0;
      const isCollapsed = hasChildren && this.collapsed.has(node.id);
      const visibleChildren = (hasChildren && !isCollapsed) ? node.children : [];

      let yCenter;
      const childLayouts = [];
      if (visibleChildren.length === 0) {
        yCenter = nextLeafY;
        nextLeafY += rowGap;
      } else {
        const nextX = xAcc + box.w + (colWidths[depth] ? 64 : 54);
        for (const ch of visibleChildren) {
          childLayouts.push(layout(ch, depth + 1, nextX));
        }
        const firstY = childLayouts[0].y;
        const lastY = childLayouts[childLayouts.length - 1].y;
        yCenter = (firstY + lastY) / 2;
      }

      const item = {
        data: node,
        depth,
        x: xAcc,
        y: yCenter,
        w: box.w,
        h: box.h,
        display: box.display,
        hasChildren,
        isCollapsed,
        hiddenCount: isCollapsed ? node.children.length : 0
      };
      nodes.push(item);

      for (const cl of childLayouts) {
        links.push({ parent: item, child: cl });
      }
      return item;
    };

    layout(this.rootData, 0, 0);

    // Calcular bounds
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      maxX = Math.max(maxX, n.x + n.w);
      minY = Math.min(minY, n.y - n.h / 2);
      maxY = Math.max(maxY, n.y + n.h / 2);
    }
    this._bounds = { minX, maxX, minY, maxY };

    const ns = 'http://www.w3.org/2000/svg';

    // Dibujar enlaces Bezier suaves
    for (const l of links) {
      const x1 = l.parent.x + l.parent.w;
      const y1 = l.parent.y;
      const x2 = l.child.x;
      const y2 = l.child.y;
      const mx = (x1 + x2) / 2;
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
      path.setAttribute('fill', 'none');
      const col = this.colors[l.child.data.type]?.stroke || '#9db0b8';
      path.setAttribute('stroke', col);
      path.setAttribute('stroke-opacity', '0.55');
      path.setAttribute('stroke-width', l.parent.depth === 0 ? '2.4' : '1.7');
      this.gLinks.appendChild(path);
    }

    // Dibujar nodos
    for (const n of nodes) {
      const style = this.colors[n.data.type] || this.colors.concept;
      const isMatch = this.searchTerm !== '' && (
        (n.data.label || '').toLowerCase().includes(this.searchTerm) ||
        (n.data.meta || '').toLowerCase().includes(this.searchTerm)
      );
      const isSelected = this.selectedId === n.data.id;

      const g = document.createElementNS(ns, 'g');
      g.setAttribute('class', 'mm-node');
      g.setAttribute('transform', `translate(${n.x}, ${n.y - n.h / 2})`);
      g.style.cursor = 'pointer';

      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('width', n.w);
      rect.setAttribute('height', n.h);
      rect.setAttribute('rx', n.depth === 0 ? '12' : '8');
      rect.setAttribute('fill', isMatch ? '#fff0a6' : style.bg);
      rect.setAttribute('stroke', isSelected ? '#c88a2b' : (isMatch ? '#d69e2e' : style.stroke));
      rect.setAttribute('stroke-width', isSelected || isMatch ? '2.8' : '1.4');
      g.appendChild(rect);

      const txt = document.createElementNS(ns, 'text');
      txt.setAttribute('x', '13');
      txt.setAttribute('y', n.depth === 0 ? '27' : '21');
      txt.setAttribute('fill', isMatch ? '#1e242b' : style.text);
      txt.setAttribute('font-size', n.depth === 0 ? '13.5' : '12');
      txt.setAttribute('font-weight', n.depth <= 1 ? '700' : '600');
      txt.setAttribute('font-family', 'Segoe UI, system-ui, sans-serif');
      txt.textContent = n.display;
      g.appendChild(txt);

      g.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selectedId = n.data.id;
        this.onSelectNode(n.data);
        this.render();
      });

      // Botón +/- para colapsar/expandir ramas con hijos
      if (n.hasChildren) {
        const tg = document.createElementNS(ns, 'g');
        tg.setAttribute('transform', `translate(${n.w}, ${n.h / 2})`);
        const circ = document.createElementNS(ns, 'circle');
        circ.setAttribute('r', '10');
        circ.setAttribute('fill', n.isCollapsed ? '#c88a2b' : '#ffffff');
        circ.setAttribute('stroke', style.stroke);
        circ.setAttribute('stroke-width', '1.6');
        const sym = document.createElementNS(ns, 'text');
        sym.setAttribute('text-anchor', 'middle');
        sym.setAttribute('y', '4');
        sym.setAttribute('font-size', n.isCollapsed ? '10' : '13');
        sym.setAttribute('font-weight', '700');
        sym.setAttribute('fill', n.isCollapsed ? '#ffffff' : style.stroke);
        sym.textContent = n.isCollapsed ? `+${n.hiddenCount}` : '−';
        tg.appendChild(circ);
        tg.appendChild(sym);

        tg.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.collapsed.has(n.data.id)) {
            this.collapsed.delete(n.data.id);
          } else {
            this.collapsed.add(n.data.id);
          }
          this.render();
        });
        g.appendChild(tg);
      }

      this.gNodes.appendChild(g);
    }

    this._applyTransform();
  }

  exportSvg(filename = 'mapa-mental.svg') {
    const clone = this.svg.cloneNode(true);
    if (this._bounds) {
      const pad = 40;
      const w = Math.ceil(this._bounds.maxX - this._bounds.minX + pad * 2);
      const h = Math.ceil(this._bounds.maxY - this._bounds.minY + pad * 2);
      clone.setAttribute('viewBox', `${this._bounds.minX - pad} ${this._bounds.minY - pad} ${w} ${h}`);
      clone.setAttribute('width', w);
      clone.setAttribute('height', h);
      const g = clone.querySelector('g');
      if (g) g.removeAttribute('transform');
    }
    const xml = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
}
