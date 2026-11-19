<?php
/**
 * API REST JSON para BiblioML (PHP 7.4+ + MySQL mysqli).
 */

@ini_set('display_errors', '0');
@set_time_limit(180);
@ini_set('memory_limit', '256M');

require_once dirname(__DIR__) . DIRECTORY_SEPARATOR . 'src' . DIRECTORY_SEPARATOR . 'Autoloader.php';
$config = require dirname(__DIR__) . DIRECTORY_SEPARATOR . 'config' . DIRECTORY_SEPARATOR . 'config.php';

use BiblioML\Database;
use BiblioML\Services\BookAnalyzerService;

$action = $_GET['action'] ?? '';

// Endpoints binarios (imágenes de portada y recursos del EPUB)
if ($action === 'cover') {
    $file = basename((string)($_GET['file'] ?? ''));
    $full = $config['app']['covers_dir'] . DIRECTORY_SEPARATOR . $file;
    serveStaticFile($full);
    exit;
}

if ($action === 'book_asset') {
    $bookId = (int)($_GET['book_id'] ?? 0);
    $relPath = rawurldecode((string)($_GET['path'] ?? ''));
    $relPath = str_replace(['\\', "\0"], ['/', ''], $relPath);
    if ($bookId <= 0 || $relPath === '' || strpos($relPath, '..') !== false) {
        http_response_code(400);
        exit('Ruta inválida');
    }
    $baseDir = realpath($config['app']['books_dir'] . DIRECTORY_SEPARATOR . 'book_' . $bookId);
    if ($baseDir === false) {
        http_response_code(404);
        exit('No encontrado');
    }
    $target = realpath($baseDir . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, ltrim($relPath, '/')));
    if ($target === false || strpos($target, $baseDir) !== 0 || !is_file($target)) {
        http_response_code(404);
        exit('Recurso no encontrado');
    }
    serveStaticFile($target);
    exit;
}

header('Content-Type: application/json; charset=utf-8');

try {
    // 1. Health & configuración DB (funciona incluso si MySQL aún no está conectado)
    if ($action === 'health') {
        $sampleInfo = detectSampleFiles($config['app']['sample_dir']);
        $dbOk = false;
        $dbError = null;
        $serverInfo = null;
        try {
            $db = new Database($config['db']);
            $dbOk = true;
            $serverInfo = $db->getConnection()->server_info;
        } catch (\Throwable $e) {
            $dbError = $e->getMessage();
        }
        jsonOut([
            'ok'          => true,
            'db_ok'       => $dbOk,
            'db_error'    => $dbError,
            'db_config'   => [
                'host' => $config['db']['host'],
                'port' => $config['db']['port'],
                'user' => $config['db']['user'],
                'name' => $config['db']['name'],
            ],
            'mysql_info'  => $serverInfo,
            'php_version' => PHP_VERSION,
            'sample'      => $sampleInfo,
        ]);
    }

    if ($action === 'save_db_config' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $body = readJsonBody();
        $newDb = [
            'host' => trim((string)($body['host'] ?? '127.0.0.1')),
            'port' => (int)($body['port'] ?? 3306),
            'user' => trim((string)($body['user'] ?? 'root')),
            'pass' => (string)($body['pass'] ?? ''),
            'name' => preg_replace('/[^a-zA-Z0-9_]/', '', (string)($body['name'] ?? 'biblioml')) ?: 'biblioml',
        ];
        // Probar conexión y crear esquema antes de guardar
        $testDb = new Database($newDb);
        $localPath = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'config' . DIRECTORY_SEPARATOR . 'config.local.php';
        $phpCode = "<?php\nreturn [\n    'db' => " . var_export($newDb, true) . ",\n];\n";
        file_put_contents($localPath, $phpCode);
        jsonOut([
            'ok'         => true,
            'message'    => 'Conexión a MySQL verificada y guardada correctamente.',
            'mysql_info' => $testDb->getConnection()->server_info,
        ]);
    }

    // Resto de endpoints requieren conexión a MySQL
    $db = new Database($config['db']);

    switch ($action) {
        case 'books':
            $rows = $db->queryAll(
                "SELECT id, title, author, language, publisher, description, cover_path,
                        epub_filename, pdf_filename, total_chapters, total_words,
                        total_notes, total_highlights, total_characters, created_at
                 FROM books ORDER BY id DESC"
            );
            jsonOut(['ok' => true, 'books' => $rows]);
            break;

        case 'upload':
            if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
                jsonOut(['ok' => false, 'error' => 'Método no permitido'], 405);
            }
            if (!isset($_FILES['epub']) || $_FILES['epub']['error'] !== UPLOAD_ERR_OK) {
                jsonOut(['ok' => false, 'error' => 'Debes subir un archivo EPUB válido (.epub).'], 400);
            }

            $uploadsDir = $config['app']['uploads_dir'];
            if (!is_dir($uploadsDir)) {
                @mkdir($uploadsDir, 0775, true);
            }

            $epubName = $_FILES['epub']['name'];
            if (strtolower(pathinfo($epubName, PATHINFO_EXTENSION)) !== 'epub') {
                jsonOut(['ok' => false, 'error' => 'El archivo del libro debe tener extensión .epub'], 400);
            }
            if ($_FILES['epub']['size'] > $config['app']['max_upload_bytes']) {
                jsonOut(['ok' => false, 'error' => 'El archivo EPUB supera el límite de 50 MB.'], 400);
            }

            $prefix = date('Ymd_His') . '_' . bin2hex(random_bytes(4));
            $epubDest = $uploadsDir . DIRECTORY_SEPARATOR . $prefix . '_book.epub';
            if (!move_uploaded_file($_FILES['epub']['tmp_name'], $epubDest)) {
                jsonOut(['ok' => false, 'error' => 'No se pudo guardar el archivo EPUB en storage/uploads.'], 500);
            }

            $pdfDest = null;
            $pdfName = null;
            if (isset($_FILES['pdf']) && $_FILES['pdf']['error'] === UPLOAD_ERR_OK && $_FILES['pdf']['size'] > 0) {
                $pdfName = $_FILES['pdf']['name'];
                if (strtolower(pathinfo($pdfName, PATHINFO_EXTENSION)) !== 'pdf') {
                    @unlink($epubDest);
                    jsonOut(['ok' => false, 'error' => 'El archivo de notas Kindle debe tener extensión .pdf'], 400);
                }
                $pdfDest = $uploadsDir . DIRECTORY_SEPARATOR . $prefix . '_kindle.pdf';
                if (!move_uploaded_file($_FILES['pdf']['tmp_name'], $pdfDest)) {
                    @unlink($epubDest);
                    jsonOut(['ok' => false, 'error' => 'No se pudo guardar el PDF de notas Kindle.'], 500);
                }
            }

            $svc = new BookAnalyzerService($config);
            $bookId = $svc->ingestAndSave($db, $epubDest, $epubName, $pdfDest, $pdfName);
            jsonOut(['ok' => true, 'book_id' => $bookId, 'message' => 'Libro analizado con éxito']);
            break;

        case 'import_sample':
            if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
                jsonOut(['ok' => false, 'error' => 'Método no permitido'], 405);
            }
            $sample = detectSampleFiles($config['app']['sample_dir']);
            if (!$sample['available']) {
                jsonOut(['ok' => false, 'error' => 'No se encontró la carpeta de muestra con el EPUB y PDF.'], 404);
            }
            $uploadsDir = $config['app']['uploads_dir'];
            if (!is_dir($uploadsDir)) {
                @mkdir($uploadsDir, 0775, true);
            }
            $prefix = 'sample_' . date('Ymd_His') . '_' . bin2hex(random_bytes(3));
            $epubDest = $uploadsDir . DIRECTORY_SEPARATOR . $prefix . '_book.epub';
            $pdfDest = $uploadsDir . DIRECTORY_SEPARATOR . $prefix . '_kindle.pdf';
            copy($sample['epub_path'], $epubDest);
            if ($sample['pdf_path']) {
                copy($sample['pdf_path'], $pdfDest);
            } else {
                $pdfDest = null;
            }

            $svc = new BookAnalyzerService($config);
            $bookId = $svc->ingestAndSave(
                $db,
                $epubDest,
                basename($sample['epub_path']),
                $pdfDest,
                $sample['pdf_path'] ? basename($sample['pdf_path']) : null
            );
            jsonOut(['ok' => true, 'book_id' => $bookId, 'message' => 'Libro de muestra importado y analizado']);
            break;

        case 'delete_book':
            if ($_SERVER['REQUEST_METHOD'] !== 'POST' && $_SERVER['REQUEST_METHOD'] !== 'DELETE') {
                jsonOut(['ok' => false, 'error' => 'Método no permitido'], 405);
            }
            $bookId = (int)($_GET['book_id'] ?? 0);
            if ($bookId <= 0) {
                jsonOut(['ok' => false, 'error' => 'book_id inválido'], 400);
            }
            $book = $db->queryOne("SELECT cover_path, epub_path, pdf_path FROM books WHERE id = ?", 'i', [$bookId]);
            if (!$book) {
                jsonOut(['ok' => false, 'error' => 'Libro no encontrado'], 404);
            }
            $db->execute("DELETE FROM books WHERE id = ?", 'i', [$bookId]);
            // Limpiar archivos físicos asociados
            if (!empty($book['cover_path'])) {
                @unlink($config['app']['covers_dir'] . DIRECTORY_SEPARATOR . basename($book['cover_path']));
            }
            if (!empty($book['epub_path']) && is_file($book['epub_path'])) {
                @unlink($book['epub_path']);
            }
            if (!empty($book['pdf_path']) && is_file($book['pdf_path'])) {
                @unlink($book['pdf_path']);
            }
            $assetDir = $config['app']['books_dir'] . DIRECTORY_SEPARATOR . 'book_' . $bookId;
            if (is_dir($assetDir)) {
                deleteDirRecursive($assetDir);
            }
            jsonOut(['ok' => true]);
            break;

        case 'book_detail':
            $bookId = (int)($_GET['book_id'] ?? 0);
            if ($bookId <= 0) {
                jsonOut(['ok' => false, 'error' => 'book_id inválido'], 400);
            }
            $book = $db->queryOne("SELECT * FROM books WHERE id = ?", 'i', [$bookId]);
            if (!$book) {
                jsonOut(['ok' => false, 'error' => 'Libro no encontrado'], 404);
            }

            $chapters = $db->queryAll(
                "SELECT c.id, c.chapter_index, c.part_title, c.title, c.display_title, c.href,
                        c.is_front_matter, c.word_count, c.summary_text, c.summary_json,
                        c.keywords_json, c.mindmap_json,
                        (SELECT COUNT(*) FROM kindle_notes kn WHERE kn.chapter_id = c.id) AS notes_count
                 FROM chapters c
                 WHERE c.book_id = ?
                 ORDER BY c.chapter_index ASC",
                'i',
                [$bookId]
            );
            foreach ($chapters as &$ch) {
                $ch['summary'] = $ch['summary_json'] ? json_decode($ch['summary_json'], true) : null;
                $ch['keywords'] = $ch['keywords_json'] ? json_decode($ch['keywords_json'], true) : null;
                $ch['mindmap'] = $ch['mindmap_json'] ? json_decode($ch['mindmap_json'], true) : null;
                unset($ch['summary_json'], $ch['keywords_json'], $ch['mindmap_json']);
            }
            unset($ch);

            $notes = $db->queryAll(
                "SELECT id, chapter_id, pdf_chapter_label, page_number, note_type,
                        highlight_color, highlight_text, user_note, note_date, match_confidence, sort_order
                 FROM kindle_notes
                 WHERE book_id = ?
                 ORDER BY sort_order ASC",
                'i',
                [$bookId]
            );

            $characters = $db->queryAll(
                "SELECT id, canonical_name, aliases_json, mention_count, chapter_count,
                        pagerank, degree_centrality, community_id, first_chapter_id,
                        chapters_json, traits_json, sample_mentions_json
                 FROM characters
                 WHERE book_id = ?
                 ORDER BY mention_count DESC",
                'i',
                [$bookId]
            );
            foreach ($characters as &$c) {
                $c['aliases'] = $c['aliases_json'] ? json_decode($c['aliases_json'], true) : [];
                $c['chapters'] = $c['chapters_json'] ? json_decode($c['chapters_json'], true) : [];
                $c['traits'] = $c['traits_json'] ? json_decode($c['traits_json'], true) : [];
                $c['sample_mentions'] = $c['sample_mentions_json'] ? json_decode($c['sample_mentions_json'], true) : [];
                $c['pagerank'] = (float)$c['pagerank'];
                $c['degree_centrality'] = (float)$c['degree_centrality'];
                $c['mention_count'] = (int)$c['mention_count'];
                $c['chapter_count'] = (int)$c['chapter_count'];
                $c['community_id'] = (int)$c['community_id'];
                unset($c['aliases_json'], $c['chapters_json'], $c['traits_json'], $c['sample_mentions_json']);
            }
            unset($c);

            $relations = $db->queryAll(
                "SELECT id, source_character_id, target_character_id, weight, cooccurrence_count,
                        pmi_score, sentiment_score, relation_tone, context_words_json,
                        shared_chapters_json, evidence_json
                 FROM character_relations
                 WHERE book_id = ?
                 ORDER BY weight DESC",
                'i',
                [$bookId]
            );
            foreach ($relations as &$r) {
                $r['source'] = (int)$r['source_character_id'];
                $r['target'] = (int)$r['target_character_id'];
                $r['weight'] = (float)$r['weight'];
                $r['cooccurrence_count'] = (int)$r['cooccurrence_count'];
                $r['pmi_score'] = (float)$r['pmi_score'];
                $r['sentiment_score'] = (float)$r['sentiment_score'];
                $r['context_words'] = $r['context_words_json'] ? json_decode($r['context_words_json'], true) : [];
                $r['shared_chapters'] = $r['shared_chapters_json'] ? json_decode($r['shared_chapters_json'], true) : [];
                $r['evidence'] = $r['evidence_json'] ? json_decode($r['evidence_json'], true) : [];
                unset($r['context_words_json'], $r['shared_chapters_json'], $r['evidence_json']);
            }
            unset($r);

            $analysisRow = $db->queryOne("SELECT * FROM book_analysis WHERE book_id = ?", 'i', [$bookId]);
            $analysis = null;
            if ($analysisRow) {
                $analysis = [
                    'global_mindmap'  => json_decode($analysisRow['global_mindmap_json'], true),
                    'cluster_mindmap' => json_decode($analysisRow['cluster_mindmap_json'], true),
                    'global_keywords' => json_decode($analysisRow['global_keywords_json'], true),
                    'clusters'        => json_decode($analysisRow['clusters_json'], true),
                    'stats'           => json_decode($analysisRow['stats_json'], true),
                    'analyzed_at'     => $analysisRow['analyzed_at'],
                ];
            }

            $progress = $db->queryOne("SELECT * FROM reading_progress WHERE book_id = ?", 'i', [$bookId]);

            jsonOut([
                'ok'         => true,
                'book'       => $book,
                'chapters'   => $chapters,
                'notes'      => $notes,
                'characters' => $characters,
                'relations'  => $relations,
                'analysis'   => $analysis,
                'progress'   => $progress,
            ]);
            break;

        case 'chapter_content':
            $chapterId = (int)($_GET['chapter_id'] ?? 0);
            if ($chapterId <= 0) {
                jsonOut(['ok' => false, 'error' => 'chapter_id inválido'], 400);
            }
            $ch = $db->queryOne("SELECT * FROM chapters WHERE id = ?", 'i', [$chapterId]);
            if (!$ch) {
                jsonOut(['ok' => false, 'error' => 'Capítulo no encontrado'], 404);
            }
            $notes = $db->queryAll(
                "SELECT id, page_number, note_type, highlight_color, highlight_text, user_note, note_date, match_confidence
                 FROM kindle_notes
                 WHERE chapter_id = ?
                 ORDER BY sort_order ASC",
                'i',
                [$chapterId]
            );
            $ch['summary'] = $ch['summary_json'] ? json_decode($ch['summary_json'], true) : null;
            $ch['keywords'] = $ch['keywords_json'] ? json_decode($ch['keywords_json'], true) : null;
            $ch['mindmap'] = $ch['mindmap_json'] ? json_decode($ch['mindmap_json'], true) : null;
            unset($ch['summary_json'], $ch['keywords_json'], $ch['mindmap_json'], $ch['plain_text']);

            jsonOut([
                'ok'      => true,
                'chapter' => $ch,
                'notes'   => $notes,
            ]);
            break;

        case 'save_progress':
            if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
                jsonOut(['ok' => false, 'error' => 'Método no permitido'], 405);
            }
            $body = readJsonBody();
            $bookId = (int)($body['book_id'] ?? 0);
            $chapterId = isset($body['current_chapter_id']) ? (int)$body['current_chapter_id'] : null;
            $scroll = max(0.0, min(100.0, (float)($body['scroll_percent'] ?? 0)));
            $theme = in_array($body['reader_theme'] ?? 'paper', ['paper', 'sepia', 'dark'], true) ? $body['reader_theme'] : 'paper';
            $fontSize = max(14, min(28, (int)($body['font_size'] ?? 18)));

            if ($bookId <= 0) {
                jsonOut(['ok' => false, 'error' => 'book_id inválido'], 400);
            }
            $db->execute(
                "INSERT INTO reading_progress (book_id, current_chapter_id, scroll_percent, reader_theme, font_size)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                   current_chapter_id = VALUES(current_chapter_id),
                   scroll_percent = VALUES(scroll_percent),
                   reader_theme = VALUES(reader_theme),
                   font_size = VALUES(font_size)",
                'iidsi',
                [$bookId, $chapterId, $scroll, $theme, $fontSize]
            );
            jsonOut(['ok' => true]);
            break;

        default:
            jsonOut(['ok' => false, 'error' => 'Acción de API desconocida: ' . $action], 404);
    }
} catch (\Throwable $e) {
    jsonOut([
        'ok'    => false,
        'error' => $e->getMessage(),
    ], 500);
}

function jsonOut(array $data, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function readJsonBody(): array
{
    $raw = file_get_contents('php://input');
    $decoded = json_decode($raw ?: '{}', true);
    return is_array($decoded) ? $decoded : [];
}

function detectSampleFiles(string $sampleDir): array
{
    $res = ['available' => false, 'epub_path' => null, 'pdf_path' => null, 'epub_name' => null, 'pdf_name' => null];
    if (!is_dir($sampleDir)) {
        return $res;
    }
    foreach (scandir($sampleDir) as $f) {
        if ($f === '.' || $f === '..') continue;
        $ext = strtolower(pathinfo($f, PATHINFO_EXTENSION));
        if ($ext === 'epub' && $res['epub_path'] === null) {
            $res['epub_path'] = $sampleDir . DIRECTORY_SEPARATOR . $f;
            $res['epub_name'] = $f;
        } elseif ($ext === 'pdf' && $res['pdf_path'] === null) {
            $res['pdf_path'] = $sampleDir . DIRECTORY_SEPARATOR . $f;
            $res['pdf_name'] = $f;
        }
    }
    $res['available'] = ($res['epub_path'] !== null);
    return $res;
}

function serveStaticFile(string $fullPath): void
{
    if (!is_file($fullPath)) {
        http_response_code(404);
        exit('Archivo no encontrado');
    }
    $ext = strtolower(pathinfo($fullPath, PATHINFO_EXTENSION));
    $mimeMap = [
        'jpg'  => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'png'  => 'image/png',
        'gif'  => 'image/gif',
        'webp' => 'image/webp',
        'svg'  => 'image/svg+xml',
        'css'  => 'text/css; charset=utf-8',
    ];
    header('Content-Type: ' . ($mimeMap[$ext] ?? 'application/octet-stream'));
    header('Cache-Control: public, max-age=86400');
    readfile($fullPath);
}

function deleteDirRecursive(string $dir): void
{
    if (!is_dir($dir)) return;
    foreach (scandir($dir) as $item) {
        if ($item === '.' || $item === '..') continue;
        $p = $dir . DIRECTORY_SEPARATOR . $item;
        if (is_dir($p)) {
            deleteDirRecursive($p);
        } else {
            @unlink($p);
        }
    }
    @rmdir($dir);
}
