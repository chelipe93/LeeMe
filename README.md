# LeeMe · Lector EPUB, Bloc de Notas Kindle y Análisis Literario con Machine Learning Clásico (Sin LLM)

Aplicación web y PWA offline construida en **PHP (8.4+) + Vanilla JavaScript + Vanilla CSS + MySQL (`mysqli`) + Apache 2.4**, sin frameworks pesados, sin librerías externas y **sin LLMs**.

## Funcionalidades Principales
1. **Carga de EPUB + PDF de Bloc de Notas Kindle**
   - Parser **PDF 1.4–1.7** (`/ObjStm`, `/FlateDecode`, fuentes Type0/CID 2-byte, `/ToUnicode` CMap, normalización Unicode NFC).
   - Parser **EPUB 2 y 3** (OPF, NCX/NAV, portada, imágenes, HTML saneado).
   - **Alineación automática** de cada subrayado/nota del PDF Kindle al capítulo exacto del EPUB.
2. **Resúmenes Extractivos por Capítulo y Global (ML Clásico)**
   - Vectorización **TF-IDF** + Grafo de similitud coseno + **TextRank** (PageRank $d = 0.85$) + **Kindle Salience Boost** + selección sin redundancia **MMR** ($\lambda = 0.72$).
3. **Mapas Mentales Interactivos (Global y por Capítulo)**
   - **Mapa Global Estructural** (Libro → Partes → Capítulos → Conceptos TF-IDF, Personajes y Notas Kindle).
   - **Mapa Global Temático** generado por agrupamiento no supervisado **Spherical K-Means++** con distancia coseno y *Silhouette Score*.
   - **Mapa Mental por Capítulo** (Conceptos TF-IDF/RAKE, Personajes, Núcleos Narrativos TextRank y Notas Kindle).
   - Visualizador SVG interactivo con pan/zoom, gestos táctiles, expandir/contraer ramas, búsqueda y exportación a `.svg`.
4. **Extracción de Personajes y Grafo de Relaciones**
   - **NER Estadístico clásico** por características contextuales (clasificador logístico), resolución de alias y rasgos distintivos vía TF-IDF.
   - **Grafo Force-Directed interactivo** en Canvas HiDPI: co-ocurrencia en ventana deslizante, **PMI**, tono afectivo (léxico en español), **PageRank** y detección de comunidades por **Modularidad Louvain**.
5. **Lector EPUB Integrado**
   - Temas *Papel*, *Sepia* y *Noche*, control de tipografía/tamaño, modo oscuro global, progreso guardado e **inyección en vivo de subrayados y notas Kindle** con popover táctil.

---

## LeeMe PWA 100% Offline (Celular Android e iOS + GitHub Pages)

El directorio [`pwa/`](pwa/index.html) es una **Progressive Web App (PWA) 100% autónoma** lista para ejecutarse sin servidor remoto ni conexión a internet tras instalarse:

- **GitHub Pages (HTTPS oficial):** `https://chelipe93.github.io/LeeMe/`
  El workflow [`.github/workflows/pages.yml`](.github/workflows/pages.yml) despliega automáticamente el contenido de `pwa/` en cada push a `main`.
- **Procesamiento local:** Descompresión ZIP/EPUB, extracción PDF Kindle (`DecompressionStream`) y todo el motor de ML clásico (`TextRank`, `TF-IDF`, `RAKE`, `Spherical K-Means++`, `NER` y `Louvain`) corren en un **Web Worker** local del teléfono.
- **Almacenamiento local:** Persistencia en **IndexedDB** (`leeme_offline_v1`), más exportación/importación de respaldos portables `.leeme.json`.

### Cómo instalarla en tu celular
1. Abre **`https://chelipe93.github.io/LeeMe/`** (o en tu red local `https://<tu-ip>/biblioml/pwa/`).
2. **Android (Chrome):** Pulsa **«📲 Instalar»** (o menú `⋮` → *Instalar aplicación*).
3. **iPhone / iPad (Safari):** Toca **Compartir** → **«Añadir a pantalla de inicio»**.
4. Una vez instalada, **funciona 100% sin internet ni servidor remoto**.

---

## Instalación Local (Apache 2.4 + MySQL 8 + PHP)

### 1. Configurar Apache 2.4
Copia el bloque de `apache-vhost.conf.example` al final de `C:\Apache24\conf\httpd.conf`:

```apache
Alias /biblioml "C:/Users/Felipe/Documents/Libros"
<Directory "C:/Users/Felipe/Documents/Libros">
    Options FollowSymLinks
    AllowOverride All
    Require all granted
    DirectoryIndex index.php
</Directory>
```

Reinicia Apache 2.4 y abre `http://localhost/biblioml/`.

### 2. Base de Datos MySQL
- Asegúrate de tener el servicio **MySQL 8.0** en ejecución.
- Al abrir la aplicación PHP, la base de datos `biblioml` y todas sus tablas (`database/schema.sql`) se crean automáticamente.
- Copia `config/config.local.php.example` a `config/config.local.php` (o usa el modal **Configurar MySQL** en la interfaz).

### Requisitos PHP
Funciona con las extensiones estándar de PHP 7.4+ / 8.4 (`mysqli`, `zip`, `zlib`, `dom`, `SimpleXML`, `json`, `pcre`).
