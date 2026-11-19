<?php
/**
 * Autoloader PSR-4 minimalista para BiblioML (cero dependencias externas).
 */
spl_autoload_register(function (string $class): void {
    $prefix = 'BiblioML\\';
    if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
        return;
    }
    $rel = substr($class, strlen($prefix));
    $file = __DIR__ . DIRECTORY_SEPARATOR . str_replace('\\', DIRECTORY_SEPARATOR, $rel) . '.php';
    if (is_file($file)) {
        require_once $file;
    }
});
