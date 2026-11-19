<?php

namespace BiblioML\Parsers;

use BiblioML\Text\SpanishNLP;
use BiblioML\Text\Utf8Helper;
use DOMDocument;
use DOMElement;
use RuntimeException;
use SimpleXMLElement;
use ZipArchive;

/**
 * Parser completo de archivos EPUB (EPUB 2 y EPUB 3) en PHP puro.
 * Extrae metadatos, portada, recursos gráficos, índice TOC, capítulos en orden
 * del spine, HTML seguro para el lector integrado y texto plano limpio.
 */
class EpubParser
{
    private static $frontMatterPatterns = [
        '/^cubierta$/iu', '/^cover$/iu', '/^portada$/iu', '/^t[ií]tulo$/iu',
        '/^sinopsis$/iu', '/^dedicatoria$/iu', '/^informaci[oó]n$/iu', '/^cr[eé]ditos$/iu',
        '/^sobre\s+el\s+autor/iu', '/^sobre\s+la\s+autora/iu', '/^biograf[ií]a$/iu',
        '/^notas\s+del\s+editor/iu', '/^ex\s+libris/iu', '/^copyright/iu', '/^colof[oó]n$/iu'
    ];

    /**
     * Parsea un EPUB y opcionalmente extrae su portada y recursos a disco.
     */
    public function parse(string $epubPath, ?string $assetsExtractDir = null, ?string $coverDestDir = null): array
    {
        if (!is_file($epubPath)) {
            throw new RuntimeException("Archivo EPUB no encontrado: {$epubPath}");
        }

        $zip = new ZipArchive();
        if ($zip->open($epubPath) !== true) {
            throw new RuntimeException("No se pudo abrir el archivo EPUB (ZIP inválido).");
        }

        try {
            $containerXml = $zip->getFromName('META-INF/container.xml');
            if ($containerXml === false) {
                throw new RuntimeException("EPUB inválido: falta META-INF/container.xml");
            }

            $opfPath = $this->findOpfPath($containerXml);
            $opfContent = $zip->getFromName($opfPath);
            if ($opfContent === false) {
                throw new RuntimeException("EPUB inválido: no se encontró el archivo OPF ({$opfPath})");
            }

            $opfDir = dirname($opfPath);
            $opfDir = ($opfDir === '.' || $opfDir === '') ? '' : ($opfDir . '/');

            $opf = @simplexml_load_string($opfContent);
            if ($opf === false) {
                throw new RuntimeException("Error leyendo metadatos XML del OPF.");
            }

            $metadata = $this->extractMetadata($opf);
            $manifest = $this->extractManifest($opf, $opfDir);
            $spine = $this->extractSpine($opf, $manifest);
            $tocMap = $this->extractTocMap($zip, $opf, $manifest, $opfDir);

            // Extraer portada
            $coverFile = $this->extractCover($zip, $opf, $manifest, $coverDestDir);

            // Extraer recursos (imágenes/CSS) del EPUB para el lector
            if ($assetsExtractDir !== null) {
                $this->extractAssets($zip, $manifest, $assetsExtractDir);
            }

            // Parsear capítulos en orden del spine
            $chapters = [];
            $currentPart = null;
            $chapterIdx = 0;
            $totalWords = 0;

            foreach ($spine as $item) {
                $zipEntry = $item['full_path'];
                $xhtml = $zip->getFromName($zipEntry);
                if ($xhtml === false) {
                    continue;
                }

                $chapterIdx++;
                $href = $item['href'];
                $tocLabel = $tocMap[$href] ?? $tocMap[$zipEntry] ?? null;

                $parsedDoc = $this->parseChapterHtml($xhtml, dirname($zipEntry));
                $rawTitle = $tocLabel ?: ($parsedDoc['heading'] ?: ($parsedDoc['title'] ?: "Sección {$chapterIdx}"));
                $rawTitle = Utf8Helper::cleanWhitespace($rawTitle);
                $plainText = $parsedDoc['plain_text'];
                $wordCount = SpanishNLP::countWords($plainText);

                // Detectar separadores de Parte (p. ej. "Uno", "Dos", "Tres", "Parte I")
                $isPartDivider = ($wordCount > 0 && $wordCount <= 25 && (
                    preg_match('/^(?:parte\s+|libro\s+|uno|dos|tres|cuatro|cinco|primera|segunda|tercera)/iu', $rawTitle)
                ));
                if ($isPartDivider) {
                    $currentPart = Utf8Helper::ucfirst(Utf8Helper::toLower($rawTitle));
                }

                $isFrontMatter = $this->isFrontMatter($rawTitle, $href, $wordCount, $metadata['title']);
                if ($isPartDivider) {
                    $isFrontMatter = true;
                }

                $displayTitle = $rawTitle;
                $isEpilogue = (bool)preg_match('/^(?:ep[ií]logo|pr[oó]logo|introducci[oó]n|anexo|ap[eé]ndice)/iu', $rawTitle);
                if (!$isFrontMatter && !$isEpilogue && $currentPart !== null && !preg_match('/^' . preg_quote($currentPart, '/') . '/iu', $rawTitle)) {
                    // Evitar duplicar si el título ya contiene la parte
                    if (Utf8Helper::len($rawTitle) <= 12) {
                        $displayTitle = "Parte {$currentPart} · Capítulo {$rawTitle}";
                    } else {
                        $displayTitle = "{$currentPart} · {$rawTitle}";
                    }
                }

                $totalWords += $wordCount;

                $chapters[] = [
                    'chapter_index'   => $chapterIdx,
                    'part_title'      => $isFrontMatter ? null : $currentPart,
                    'title'           => $rawTitle,
                    'display_title'   => $displayTitle,
                    'href'            => $zipEntry,
                    'is_front_matter' => $isFrontMatter ? 1 : 0,
                    'word_count'      => $wordCount,
                    'html_content'    => $parsedDoc['body_html'],
                    'plain_text'      => $plainText,
                ];
            }

            return [
                'metadata'    => $metadata,
                'cover_file'  => $coverFile,
                'chapters'    => $chapters,
                'total_words' => $totalWords,
            ];
        } finally {
            $zip->close();
        }
    }

    private function findOpfPath(string $containerXml): string
    {
        $xml = @simplexml_load_string($containerXml);
        if ($xml === false) {
            throw new RuntimeException("Error leyendo META-INF/container.xml");
        }
        $xml->registerXPathNamespace('c', 'urn:oasis:names:tc:opendocument:xmlns:container');
        $nodes = $xml->xpath('//c:rootfile/@full-path');
        if (empty($nodes)) {
            throw new RuntimeException("No se encontró rootfile en container.xml");
        }
        return (string)$nodes[0];
    }

    private function extractMetadata(SimpleXMLElement $opf): array
    {
        $opf->registerXPathNamespace('dc', 'http://purl.org/dc/elements/1.1/');
        $getFirst = function (string $tag) use ($opf): string {
            $nodes = $opf->xpath("//dc:{$tag}");
            if (!empty($nodes)) {
                return Utf8Helper::cleanWhitespace((string)$nodes[0]);
            }
            return '';
        };

        return [
            'title'       => $getFirst('title') ?: 'Libro sin título',
            'author'      => $getFirst('creator') ?: 'Autor desconocido',
            'language'    => $getFirst('language') ?: 'es',
            'publisher'   => $getFirst('publisher') ?: null,
            'description' => $getFirst('description') ?: null,
        ];
    }

    private function extractManifest(SimpleXMLElement $opf, string $opfDir): array
    {
        $manifest = [];
        if (!isset($opf->manifest)) {
            return $manifest;
        }
        foreach ($opf->manifest->item as $item) {
            $id = (string)$item['id'];
            $href = rawurldecode((string)$item['href']);
            $mediaType = (string)$item['media-type'];
            $props = (string)($item['properties'] ?? '');
            $manifest[$id] = [
                'id'         => $id,
                'href'       => $href,
                'full_path'  => $this->normalizeZipPath($opfDir . $href),
                'media_type' => $mediaType,
                'properties' => $props,
            ];
        }
        return $manifest;
    }

    private function extractSpine(SimpleXMLElement $opf, array $manifest): array
    {
        $spine = [];
        if (!isset($opf->spine)) {
            return $spine;
        }
        foreach ($opf->spine->itemref as $ref) {
            $idref = (string)$ref['idref'];
            if (isset($manifest[$idref])) {
                $spine[] = $manifest[$idref];
            }
        }
        return $spine;
    }

    private function extractTocMap(ZipArchive $zip, SimpleXMLElement $opf, array $manifest, string $opfDir): array
    {
        $map = [];

        // 1. Intentar EPUB 2 NCX
        $ncxId = (string)($opf->spine['toc'] ?? '');
        if ($ncxId !== '' && isset($manifest[$ncxId])) {
            $ncxPath = $manifest[$ncxId]['full_path'];
            $ncxXml = $zip->getFromName($ncxPath);
            if ($ncxXml !== false) {
                $ncxDir = dirname($ncxPath);
                $ncxDir = ($ncxDir === '.' || $ncxDir === '') ? '' : ($ncxDir . '/');
                $dom = new DOMDocument();
                if (@$dom->loadXML($ncxXml)) {
                    $navPoints = $dom->getElementsByTagName('navPoint');
                    foreach ($navPoints as $np) {
                        $label = '';
                        $textNodes = $np->getElementsByTagName('text');
                        if ($textNodes->length > 0) {
                            $label = trim($textNodes->item(0)->textContent);
                        }
                        $contentNodes = $np->getElementsByTagName('content');
                        if ($contentNodes->length > 0 && $label !== '') {
                            $src = rawurldecode($contentNodes->item(0)->getAttribute('src'));
                            $srcNoFrag = explode('#', $src)[0];
                            $full = $this->normalizeZipPath($ncxDir . $srcNoFrag);
                            if (!isset($map[$srcNoFrag])) {
                                $map[$srcNoFrag] = $label;
                            }
                            if (!isset($map[$full])) {
                                $map[$full] = $label;
                            }
                        }
                    }
                }
            }
        }

        // 2. Fallback EPUB 3 nav document
        if (empty($map)) {
            foreach ($manifest as $item) {
                if (strpos($item['properties'], 'nav') !== false) {
                    $navHtml = $zip->getFromName($item['full_path']);
                    if ($navHtml !== false) {
                        $navDir = dirname($item['full_path']);
                        $navDir = ($navDir === '.' || $navDir === '') ? '' : ($navDir . '/');
                        $dom = new DOMDocument();
                        if (@$dom->loadHTML('<?xml encoding="utf-8"?>' . $navHtml)) {
                            foreach ($dom->getElementsByTagName('a') as $a) {
                                $href = rawurldecode($a->getAttribute('href'));
                                $srcNoFrag = explode('#', $href)[0];
                                $label = trim($a->textContent);
                                if ($srcNoFrag !== '' && $label !== '') {
                                    $full = $this->normalizeZipPath($navDir . $srcNoFrag);
                                    if (!isset($map[$full])) {
                                        $map[$full] = $label;
                                    }
                                }
                            }
                        }
                    }
                    break;
                }
            }
        }

        return $map;
    }

    private function extractCover(ZipArchive $zip, SimpleXMLElement $opf, array $manifest, ?string $coverDestDir): ?string
    {
        if ($coverDestDir === null) {
            return null;
        }
        $coverItem = null;

        // 1. Buscar properties="cover-image" (EPUB 3)
        foreach ($manifest as $item) {
            if (strpos($item['properties'], 'cover-image') !== false) {
                $coverItem = $item;
                break;
            }
        }

        // 2. Buscar <meta name="cover" content="id"/> (EPUB 2)
        if ($coverItem === null && isset($opf->metadata)) {
            foreach ($opf->metadata->meta as $meta) {
                if (strtolower((string)$meta['name']) === 'cover') {
                    $cid = (string)$meta['content'];
                    if (isset($manifest[$cid])) {
                        $coverItem = $manifest[$cid];
                        break;
                    }
                }
            }
        }

        // 3. Buscar por nombre "cover" en imágenes
        if ($coverItem === null) {
            foreach ($manifest as $item) {
                if (strpos($item['media_type'], 'image/') === 0 && stripos($item['href'], 'cover') !== false) {
                    $coverItem = $item;
                    break;
                }
            }
        }

        if ($coverItem === null) {
            return null;
        }

        $bytes = $zip->getFromName($coverItem['full_path']);
        if ($bytes === false) {
            return null;
        }

        if (!is_dir($coverDestDir)) {
            @mkdir($coverDestDir, 0775, true);
        }
        $ext = strtolower(pathinfo($coverItem['href'], PATHINFO_EXTENSION)) ?: 'jpg';
        $filename = 'cover_' . md5($coverItem['full_path'] . strlen($bytes) . microtime(true)) . '.' . $ext;
        file_put_contents($coverDestDir . DIRECTORY_SEPARATOR . $filename, $bytes);
        return $filename;
    }

    private function extractAssets(ZipArchive $zip, array $manifest, string $destDir): void
    {
        if (!is_dir($destDir)) {
            @mkdir($destDir, 0775, true);
        }
        foreach ($manifest as $item) {
            $mt = $item['media_type'];
            if (strpos($mt, 'image/') !== 0 && $mt !== 'text/css') {
                continue;
            }
            $data = $zip->getFromName($item['full_path']);
            if ($data === false) {
                continue;
            }
            $target = $destDir . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $item['full_path']);
            $parent = dirname($target);
            if (!is_dir($parent)) {
                @mkdir($parent, 0775, true);
            }
            file_put_contents($target, $data);
        }
    }

    private function parseChapterHtml(string $xhtml, string $chapterZipDir): array
    {
        $dom = new DOMDocument('1.0', 'UTF-8');
        $prev = libxml_use_internal_errors(true);
        $dom->loadHTML('<?xml encoding="utf-8" ?>' . $xhtml, LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD);
        libxml_clear_errors();
        libxml_use_internal_errors($prev);

        $title = '';
        $titleNodes = $dom->getElementsByTagName('title');
        if ($titleNodes->length > 0) {
            $title = trim($titleNodes->item(0)->textContent);
        }

        $bodyNodes = $dom->getElementsByTagName('body');
        $body = $bodyNodes->length > 0 ? $bodyNodes->item(0) : $dom->documentElement;

        // Remover elementos potencialmente inseguros
        foreach (['script', 'iframe', 'object', 'embed', 'style'] as $badTag) {
            $nodes = $dom->getElementsByTagName($badTag);
            while ($nodes->length > 0) {
                $n = $nodes->item(0);
                if ($n->parentNode) {
                    $n->parentNode->removeChild($n);
                }
            }
        }

        // Reescribir rutas relativas de imágenes con marcador {{ASSET_BASE}}
        $dirPrefix = ($chapterZipDir === '.' || $chapterZipDir === '') ? '' : ($chapterZipDir . '/');
        foreach ($dom->getElementsByTagName('img') as $img) {
            /** @var DOMElement $img */
            $src = rawurldecode($img->getAttribute('src'));
            if ($src !== '' && !preg_match('#^(?:https?:|data:)#i', $src)) {
                $resolved = $this->normalizeZipPath($dirPrefix . $src);
                $img->setAttribute('src', '{{ASSET_BASE}}' . rawurlencode($resolved));
                $img->setAttribute('loading', 'lazy');
            }
        }
        // También imágenes SVG (<image xlink:href="...">)
        foreach ($dom->getElementsByTagName('image') as $img) {
            /** @var DOMElement $img */
            $href = $img->getAttribute('xlink:href') ?: $img->getAttribute('href');
            if ($href !== '' && !preg_match('#^(?:https?:|data:)#i', $href)) {
                $resolved = $this->normalizeZipPath($dirPrefix . rawurldecode($href));
                $img->setAttribute('xlink:href', '{{ASSET_BASE}}' . rawurlencode($resolved));
                $img->setAttribute('href', '{{ASSET_BASE}}' . rawurlencode($resolved));
            }
        }

        // Detectar primer encabezado h1/h2
        $heading = '';
        foreach (['h1', 'h2', 'h3'] as $hTag) {
            $hNodes = $dom->getElementsByTagName($hTag);
            if ($hNodes->length > 0) {
                $heading = trim($hNodes->item(0)->textContent);
                if ($heading !== '') {
                    break;
                }
            }
        }

        // Extraer HTML interno del body
        $bodyHtml = '';
        if ($body !== null) {
            foreach ($body->childNodes as $child) {
                $bodyHtml .= $dom->saveHTML($child);
            }
        }

        // Extraer texto plano respetando saltos de párrafo
        $plainBlocks = [];
        if ($body !== null) {
            $this->collectTextBlocks($body, $plainBlocks);
        }
        $plainText = Utf8Helper::normalizeNfc(implode("\n\n", $plainBlocks));
        if (trim($plainText) === '' && $body !== null) {
            $plainText = Utf8Helper::cleanWhitespace($body->textContent);
        }

        return [
            'title'      => $title,
            'heading'    => $heading,
            'body_html'  => trim($bodyHtml),
            'plain_text' => $plainText,
        ];
    }

    private function collectTextBlocks(\DOMNode $node, array &$blocks): void
    {
        static $blockTags = ['p'=>1,'div'=>1,'h1'=>1,'h2'=>1,'h3'=>1,'h4'=>1,'blockquote'=>1,'li'=>1];

        if ($node->nodeType === XML_ELEMENT_NODE) {
            $tag = strtolower($node->nodeName);
            if (isset($blockTags[$tag])) {
                // Si el bloque contiene bloques hijos (ej. div contenedor), descender
                $hasBlockChild = false;
                foreach ($node->childNodes as $ch) {
                    if ($ch->nodeType === XML_ELEMENT_NODE && isset($blockTags[strtolower($ch->nodeName)])) {
                        $hasBlockChild = true;
                        break;
                    }
                }
                if (!$hasBlockChild) {
                    $txt = Utf8Helper::cleanWhitespace($node->textContent);
                    if ($txt !== '') {
                        $blocks[] = $txt;
                    }
                    return;
                }
            }
        }

        foreach ($node->childNodes as $child) {
            $this->collectTextBlocks($child, $blocks);
        }
    }

    private function isFrontMatter(string $title, string $href, int $wordCount, string $bookTitle): bool
    {
        if ($wordCount < 60) {
            return true;
        }
        if (Utf8Helper::normalizeForMatch($title) === Utf8Helper::normalizeForMatch($bookTitle) && $wordCount < 300) {
            return true;
        }
        foreach (self::$frontMatterPatterns as $pat) {
            if (preg_match($pat, $title)) {
                return true;
            }
        }
        $base = strtolower(basename($href));
        if (preg_match('/^(?:cubierta|cover|titulo|title|info|sinopsis|dedicatoria|autor|copyright|nav|toc)\./', $base)) {
            return true;
        }
        return false;
    }

    private function normalizeZipPath(string $path): string
    {
        $path = str_replace('\\', '/', $path);
        $parts = explode('/', $path);
        $stack = [];
        foreach ($parts as $p) {
            if ($p === '' || $p === '.') {
                continue;
            }
            if ($p === '..') {
                array_pop($stack);
            } else {
                $stack[] = $p;
            }
        }
        return implode('/', $stack);
    }
}
