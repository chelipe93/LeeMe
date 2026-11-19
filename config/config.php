<?php
/**
 * Configuración principal de LeeMe (PHP + MySQL + Apache2)
 * Para personalizar credenciales locales sin modificar este archivo,
 * copia config.local.php.example a config.local.php.
 */

$defaults = [
    'db' => [
        'host'     => getenv('BIBLIOML_DB_HOST') ?: '127.0.0.1',
        'port'     => (int)(getenv('BIBLIOML_DB_PORT') ?: 3306),
        'user'     => getenv('BIBLIOML_DB_USER') ?: 'root',
        'pass'     => getenv('BIBLIOML_DB_PASS') ?: '',
        'name'     => getenv('BIBLIOML_DB_NAME') ?: 'biblioml',
        'charset'  => 'utf8mb4',
    ],
    'app' => [
        'name'             => 'LeeMe · Análisis Literario con Machine Learning',
        'base_dir'         => dirname(__DIR__),
        'storage_dir'      => dirname(__DIR__) . DIRECTORY_SEPARATOR . 'storage',
        'uploads_dir'      => dirname(__DIR__) . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . 'uploads',
        'books_dir'        => dirname(__DIR__) . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . 'books',
        'covers_dir'       => dirname(__DIR__) . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . 'covers',
        'sample_dir'       => dirname(__DIR__) . DIRECTORY_SEPARATOR . 'En diciembre llegaban las brisas',
        'max_upload_bytes' => 50 * 1024 * 1024, // 50 MB
    ],
];

$localConfigFile = __DIR__ . DIRECTORY_SEPARATOR . 'config.local.php';
if (is_file($localConfigFile)) {
    $local = require $localConfigFile;
    if (is_array($local)) {
        if (isset($local['db']) && is_array($local['db'])) {
            $defaults['db'] = array_merge($defaults['db'], $local['db']);
        }
        if (isset($local['app']) && is_array($local['app'])) {
            $defaults['app'] = array_merge($defaults['app'], $local['app']);
        }
    }
}

return $defaults;
