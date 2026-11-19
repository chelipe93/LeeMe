<?php
/**
 * LeeMe · Aplicación Web de Análisis Literario con Machine Learning Clásico 
 * Stack: PHP + Vanilla JavaScript + MySQL (mysqli) + Apache2
 */
?><!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LeeMe · Lector EPUB, Notas Kindle y Análisis con Machine Learning</title>
  <link rel="stylesheet" href="assets/css/app.css">
</head>
<body>
  <header class="topbar">
    <div class="brand" id="btnHomeBrand" title="Volver a la biblioteca">
      <div class="brand-mark">L</div>
      <div>
        <span class="brand-title">LeeMe</span>
        <span class="brand-sub">Lector EPUB · Notas Kindle · Resúmenes · Personajes</span>
      </div>
    </div>
    <div class="topbar-actions">
      <button class="btn btn-ghost btn-sm hidden" id="btnBackLibrary">← Biblioteca</button>
      <a class="btn btn-ghost btn-sm" href="pwa/" title="Abrir versión instalable 100% offline">📱 LeeMe Offline (PWA)</a>
      <button class="status-pill" id="dbStatusPill" title="Configurar conexión MySQL">
        <span class="status-dot"></span>
        <span id="dbStatusText">Verificando MySQL…</span>
      </button>
    </div>
  </header>

  <main class="container">
    <div id="globalAlert" class="alert hidden"></div>

    <!-- VISTA 1: BIBLIOTECA Y CARGA -->
    <section id="viewLibrary">
      <div class="hero-grid">
        <div class="card">
          <h1 class="card-title">Subir Libro EPUB y Bloc de Notas Kindle (PDF)</h1>
          <p class="card-sub">
            Sube tu libro en formato <strong>.epub</strong> junto al PDF de subrayados y notas exportado desde Kindle.
            LeeMe ubicará tus notas dentro del texto y generará resúmenes por capítulo, la lista de personajes y un grafo con sus relaciones.
          </p>

          <form id="uploadForm">
            <div class="upload-zones">
              <label class="dropzone" id="dzEpub">
                <input type="file" name="epub" id="inputEpub" accept=".epub" required>
                <div class="dropzone-icon">📘</div>
                <span class="dropzone-label">Archivo EPUB (Requerido)</span>
                <span class="dropzone-hint" id="labelEpub">Haz clic o arrastra tu .epub aquí</span>
              </label>

              <label class="dropzone" id="dzPdf">
                <input type="file" name="pdf" id="inputPdf" accept=".pdf">
                <div class="dropzone-icon">📝</div>
                <span class="dropzone-label">PDF Notas de Kindle (Recomendado)</span>
                <span class="dropzone-hint" id="labelPdf">Haz clic o arrastra tu Bloc de notas .pdf</span>
              </label>
            </div>

            <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
              <button type="submit" class="btn btn-primary" id="btnUploadSubmit">
                ⚡ Subir y Analizar con ML
              </button>
              <button type="button" class="btn btn-accent hidden" id="btnImportSample">
                ✨ Cargar Muestra: En diciembre llegaban las brisas
              </button>
            </div>
          </form>
        </div>

        <div class="card">
          <details>
            <summary style="cursor:pointer; font-weight:700; font-size:15px;">¿Cómo analiza LeeMe tus libros?</summary>
            <p class="card-sub" style="margin-top:8px;">
              Todo el análisis se hace en tu propio equipo y queda guardado para consultarlo cuando quieras.
            </p>
            <ul style="margin:0; padding-left:18px; font-size:13.5px; color:var(--ink-soft); display:flex; flex-direction:column; gap:7px; line-height:1.5;">
              <li><strong>Resúmenes:</strong> elige las frases más representativas de cada capítulo, dando prioridad a las que tú subrayaste en Kindle y evitando repetir ideas.</li>
              <li><strong>Personajes:</strong> detecta los nombres que se repiten en el texto, une sus apodos o formas de llamarlos y destaca las palabras que mejor los describen.</li>
              <li><strong>Relaciones:</strong> observa qué personajes aparecen juntos y en qué tono, para mostrar quién se relaciona con quién, quiénes son los más importantes y qué grupos forman.</li>
              <li><strong>Temas:</strong> agrupa los capítulos que tratan asuntos parecidos según las palabras clave de cada uno.</li>
            </ul>
          </details>
        </div>
      </div>

      <div class="section-header">
        <h2>Biblioteca Analizada</h2>
        <span class="muted" id="booksCountLabel">0 libros</span>
      </div>
      <div id="booksGrid" class="books-grid"></div>
    </section>

    <!-- VISTA 2: ESPACIO DE TRABAJO DEL LIBRO -->
    <section id="viewWorkspace" class="hidden">
      <div class="workspace-header">
        <div class="ws-book-info">
          <img id="wsCover" class="ws-cover hidden" alt="Portada">
          <div>
            <h1 id="wsTitle" class="ws-title">Título del libro</h1>
            <p id="wsAuthor" class="ws-author">Autor</p>
          </div>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn btn-primary btn-sm" id="btnQuickRead">📖 Ir al Lector EPUB</button>
          <button class="btn btn-outline btn-sm" id="btnQuickGraph">🕸️ Ver Grafo</button>
        </div>
      </div>

      <nav class="tabs-bar" id="workspaceTabs">
        <button class="tab-btn active" data-tab="overview">📊 Resumen & Panel ML</button>
        <button class="tab-btn" data-tab="reader">📖 Lector EPUB</button>
        <button class="tab-btn" data-tab="summaries">📄 Resúmenes por Capítulo</button>
        <button class="tab-btn" data-tab="characters">🕸️ Personajes y Grafo</button>
        <button class="tab-btn" data-tab="notes">🖍️ Bloc de Notas Kindle</button>
      </nav>

      <!-- TAB 1: OVERVIEW -->
      <div id="tab-overview" class="tab-pane">
        <div id="overviewKpis" class="kpi-grid"></div>

        <div class="two-col">
          <div style="display:flex; flex-direction:column; gap:18px;">
            <div class="card">
              <h2 class="card-title">Síntesis Global del Libro (TextRank + Kindle Boost)</h2>
              <div id="overviewSummary" class="summary-prose"></div>
            </div>

            <div class="card">
              <h2 class="card-title">Clústeres Temáticos Descubiertos (Spherical K-Means++)</h2>
              <p class="card-sub">Agrupamiento automático de capítulos por similitud coseno sobre vectores TF-IDF.</p>
              <div id="overviewClusters"></div>
            </div>

            <div class="card">
              <h2 class="card-title">Conceptos Globales (TF-IDF) y Colocaciones (PMI)</h2>
              <div id="overviewConcepts" class="ml-badges"></div>
            </div>
          </div>

          <div style="display:flex; flex-direction:column; gap:18px;">
            <div class="card">
              <h2 class="card-title">Extensión y Notas Kindle por Capítulo</h2>
              <p class="card-sub">Haz clic en cualquier capítulo para abrirlo en el lector EPUB.</p>
              <div id="overviewChapterBars" class="chapter-bars"></div>
            </div>

            <div class="card">
              <h2 class="card-title">Transparencia del Pipeline ML</h2>
              <div id="overviewAlgorithms" style="font-size:13px; display:flex; flex-direction:column; gap:8px;"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- TAB 2: INTEGRATED EPUB READER -->
      <div id="tab-reader" class="tab-pane hidden">
        <div class="reader-layout">
          <aside class="reader-toc">
            <div style="font-weight:700; font-size:13px; padding:4px 8px 8px; border-bottom:1px solid var(--border);">
              Índice del EPUB
            </div>
            <div id="readerTocList"></div>
          </aside>

          <div class="reader-stage">
            <div class="reader-toolbar">
              <strong id="readerChapterTitle" style="font-size:14.5px;">Capítulo</strong>
              <div class="reader-controls">
                <button class="btn btn-outline btn-sm" id="btnFontDec" title="Reducir texto">A-</button>
                <button class="btn btn-outline btn-sm" id="btnFontInc" title="Aumentar texto">A+</button>
                <button class="btn btn-outline btn-sm" id="btnFontToggle" title="Alternar Serif / Sans">Aa</button>
                <select id="selectReaderTheme" class="input" style="padding:5px 8px; font-size:12.5px;">
                  <option value="paper">☀️ Papel</option>
                  <option value="sepia">📜 Sepia</option>
                  <option value="dark">🌙 Noche</option>
                </select>
                <label style="font-size:12px; display:inline-flex; align-items:center; gap:4px; cursor:pointer;">
                  <input type="checkbox" id="chkShowHighlights" checked> Resaltados Kindle
                </label>
              </div>
            </div>
            <div class="reader-progress-bar"><div id="readerProgressFill" class="reader-progress-fill"></div></div>

            <article id="readerViewport" class="reader-viewport theme-paper"></article>

            <div class="reader-footer-nav">
              <button class="btn btn-outline btn-sm" id="btnPrevChapter">← Capítulo anterior</button>
              <span id="readerProgressText" class="muted">0%</span>
              <button class="btn btn-primary btn-sm" id="btnNextChapter">Siguiente capítulo →</button>
            </div>
          </div>

          <aside class="reader-inspector">
            <div class="inspector-block">
              <h4>Resumen ML del Capítulo</h4>
              <p id="readerInspectorSummary" style="font-size:13px; margin:0; color:var(--ink-soft);"></p>
            </div>
            <div class="inspector-block">
              <h4>Conceptos Clave</h4>
              <div id="readerInspectorKeywords" class="ml-badges"></div>
            </div>
            <div class="inspector-block">
              <h4>Personajes Presentes</h4>
              <div id="readerInspectorChars" class="ml-badges"></div>
            </div>
            <div class="inspector-block">
              <h4>Notas Kindle en este Capítulo</h4>
              <div id="readerInspectorNotes" style="display:flex; flex-direction:column; gap:8px;"></div>
            </div>
          </aside>
        </div>
      </div>

      <!-- TAB 4: CHAPTER SUMMARIES -->
      <div id="tab-summaries" class="tab-pane hidden">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:16px;">
          <div>
            <h2 style="margin:0;">Resúmenes por Capítulo (TextRank + TF-IDF + MMR)</h2>
            <span class="muted">Resúmenes extractivos generados con Machine Learning clásico e impulsados por tus subrayados Kindle.</span>
          </div>
          <input type="text" id="inputSummarySearch" class="input" placeholder="Filtrar capítulos o conceptos…">
        </div>
        <div id="summariesContainer"></div>
      </div>

      <!-- TAB 5: CHARACTERS & RELATIONSHIP GRAPH -->
      <div id="tab-characters" class="tab-pane hidden">
        <div class="viz-toolbar">
          <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
            <select id="selectGraphChapter" class="input">
              <option value="all">Todos los capítulos (Grafo Global)</option>
            </select>
            <label style="font-size:12.5px; display:inline-flex; align-items:center; gap:6px;">
              Peso mín:
              <input type="range" id="rangeGraphWeight" min="2" max="80" value="6" style="width:100px;">
              <strong id="labelGraphWeight">6</strong>
            </label>
            <input type="text" id="inputGraphSearch" class="input" placeholder="Buscar personaje…">
          </div>
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            <button class="btn btn-outline btn-sm" id="btnGraphReset">Centrar</button>
            <button class="btn btn-outline btn-sm" id="btnGraphRelayout">Re-simular física</button>
            <button class="btn btn-primary btn-sm" id="btnGraphExport">⬇ Exportar PNG</button>
          </div>
        </div>
        <div class="viz-stage-wrap">
          <div class="graph-viewport">
            <canvas id="graphCanvas"></canvas>
          </div>
          <aside class="viz-sidepanel" id="graphInspector">
            <h3 style="margin-top:0; font-size:16px;">Grafo de Relaciones</h3>
            <p class="muted">Arrastra los nodos o haz clic sobre un personaje o una conexión para inspeccionar co-ocurrencias, PMI, tono emocional y citas textuales.</p>
            <div id="graphLegend" style="margin-top:14px;"></div>
          </aside>
        </div>

        <div class="section-header" style="margin-top:24px;">
          <h2>Directorio de Personajes Extraídos</h2>
          <div style="display:flex; gap:8px;">
            <select id="selectCharSort" class="input">
              <option value="mentions">Ordenar por Menciones</option>
              <option value="pagerank">Ordenar por PageRank</option>
              <option value="chapters">Ordenar por Capítulos</option>
              <option value="community">Ordenar por Comunidad Louvain</option>
            </select>
          </div>
        </div>
        <div id="charactersGrid" class="char-grid"></div>
      </div>

      <!-- TAB 6: KINDLE NOTES -->
      <div id="tab-notes" class="tab-pane hidden">
        <div class="notes-controls">
          <input type="text" id="inputNoteSearch" class="input" style="flex:1; min-width:220px;" placeholder="Buscar en subrayados o notas personales…">
          <select id="selectNoteChapter" class="input">
            <option value="all">Todos los capítulos</option>
          </select>
          <select id="selectNoteType" class="input">
            <option value="all">Todos los tipos</option>
            <option value="with_note">Con nota personal</option>
            <option value="highlight">Solo subrayados</option>
            <option value="note">Notas sueltas</option>
            <option value="bookmark">Marcadores</option>
          </select>
        </div>
        <div id="notesStatsBar" class="muted" style="margin-bottom:12px;"></div>
        <div id="notesContainer"></div>
      </div>
    </section>
  </main>

  <!-- MODAL DE CONFIGURACIÓN MYSQL -->
  <div id="dbModal" class="modal-backdrop hidden">
    <div class="modal">
      <h2 class="card-title">Configuración de MySQL</h2>
      <p class="card-sub">Ajusta las credenciales de tu servidor MySQL local. La base de datos y tablas se crean automáticamente.</p>
      <form id="dbConfigForm">
        <div class="form-row">
          <label>Host</label>
          <input type="text" class="input" id="dbHost" value="127.0.0.1" required>
        </div>
        <div class="form-row">
          <label>Puerto</label>
          <input type="number" class="input" id="dbPort" value="3306" required>
        </div>
        <div class="form-row">
          <label>Usuario</label>
          <input type="text" class="input" id="dbUser" value="root" required>
        </div>
        <div class="form-row">
          <label>Contraseña</label>
          <input type="password" class="input" id="dbPass" placeholder="(vacío si no tiene contraseña)">
        </div>
        <div class="form-row">
          <label>Base de Datos</label>
          <input type="text" class="input" id="dbName" value="biblioml" required>
        </div>
        <div id="dbModalMsg" class="muted" style="margin-bottom:10px;"></div>
        <div style="display:flex; justify-content:flex-end; gap:8px;">
          <button type="button" class="btn btn-outline" id="btnDbModalClose">Cerrar</button>
          <button type="submit" class="btn btn-primary">Guardar y Conectar</button>
        </div>
      </form>
    </div>
  </div>

  <!-- OVERLAY DE PROCESAMIENTO -->
  <div id="loadingOverlay" class="spinner-overlay hidden">
    <div class="spinner"></div>
    <div id="loadingText" style="font-size:15px; font-weight:600;">Procesando libro con Machine Learning…</div>
    <div style="font-size:12.5px; color:#c8d4de;">Parseando EPUB/PDF · TextRank · TF-IDF · K-Means++ · NER · Grafo Louvain</div>
  </div>

  <script src="assets/js/api.js"></script>
  <script src="assets/js/graph.js"></script>
  <script src="assets/js/reader.js"></script>
  <script src="assets/js/app.js"></script>
</body>
</html>
