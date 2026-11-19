<?php

namespace BiblioML;

use mysqli;
use RuntimeException;

/**
 * Capa de acceso a MySQL usando mysqli nativo (compatible con PHP 7.4+ sin pdo_mysql).
 * Incluye instalador automático de base de datos y tablas desde database/schema.sql.
 */
class Database
{
    /** @var mysqli */
    private $conn;
    /** @var array */
    private $config;

    public function __construct(array $dbConfig)
    {
        $this->config = $dbConfig;
        mysqli_report(MYSQLI_REPORT_OFF);

        $host = $dbConfig['host'] ?? '127.0.0.1';
        $port = (int)($dbConfig['port'] ?? 3306);
        $user = $dbConfig['user'] ?? 'root';
        $pass = $dbConfig['pass'] ?? '';
        $name = $dbConfig['name'] ?? 'biblioml';

        $mysqli = @new mysqli($host, $user, $pass, '', $port);
        if ($mysqli->connect_errno) {
            throw new RuntimeException(
                "No se pudo conectar a MySQL ({$host}:{$port}): [{$mysqli->connect_errno}] {$mysqli->connect_error}"
            );
        }
        $mysqli->set_charset($dbConfig['charset'] ?? 'utf8mb4');

        // Crear la base de datos automáticamente si no existe
        $safeDb = preg_replace('/[^a-zA-Z0-9_]/', '', $name);
        $mysqli->query("CREATE DATABASE IF NOT EXISTS `{$safeDb}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
        if (!$mysqli->select_db($safeDb)) {
            throw new RuntimeException("No se pudo seleccionar la base de datos '{$safeDb}': " . $mysqli->error);
        }

        $this->conn = $mysqli;
        $this->ensureSchema();
    }

    private function ensureSchema(): void
    {
        $check = $this->conn->query("SHOW TABLES LIKE 'books'");
        if ($check && $check->num_rows > 0) {
            $check->free();
            return;
        }
        if ($check) {
            $check->free();
        }

        $schemaFile = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'database' . DIRECTORY_SEPARATOR . 'schema.sql';
        if (!is_file($schemaFile)) {
            throw new RuntimeException("Archivo schema.sql no encontrado en {$schemaFile}");
        }

        $sql = file_get_contents($schemaFile);
        // Remover CREATE DATABASE / USE para respetar el nombre de DB configurado
        $sql = preg_replace('/^\s*CREATE\s+DATABASE\b.*?;/ims', '', $sql);
        $sql = preg_replace('/^\s*USE\s+`?[^`;]+`?\s*;/im', '', $sql);
        $sql = preg_replace('/^\s*--.*$/m', '', $sql);

        $statements = array_filter(array_map('trim', explode(';', $sql)));
        foreach ($statements as $stmt) {
            if ($stmt === '') {
                continue;
            }
            if (!$this->conn->query($stmt)) {
                throw new RuntimeException("Error creando esquema MySQL: " . $this->conn->error);
            }
        }
    }

    public function getConnection(): mysqli
    {
        return $this->conn;
    }

    public function beginTransaction(): void
    {
        $this->conn->begin_transaction();
    }

    public function commit(): void
    {
        $this->conn->commit();
    }

    public function rollback(): void
    {
        $this->conn->rollback();
    }

    public function queryAll(string $sql, string $types = '', array $params = []): array
    {
        $stmt = $this->prepareAndExecute($sql, $types, $params);
        $res = $stmt->get_result();
        $rows = [];
        if ($res) {
            while ($row = $res->fetch_assoc()) {
                $rows[] = $row;
            }
            $res->free();
        }
        $stmt->close();
        return $rows;
    }

    public function queryOne(string $sql, string $types = '', array $params = []): ?array
    {
        $rows = $this->queryAll($sql, $types, $params);
        return $rows[0] ?? null;
    }

    public function execute(string $sql, string $types = '', array $params = []): int
    {
        $stmt = $this->prepareAndExecute($sql, $types, $params);
        $insertId = $stmt->insert_id ?: $stmt->affected_rows;
        $stmt->close();
        return (int)$insertId;
    }

    private function prepareAndExecute(string $sql, string $types, array $params)
    {
        $stmt = $this->conn->prepare($sql);
        if (!$stmt) {
            throw new RuntimeException("Error preparando consulta SQL: {$this->conn->error}");
        }
        if ($types !== '' && !empty($params)) {
            $bindArgs = [$types];
            foreach ($params as $k => $v) {
                $bindArgs[] = &$params[$k];
            }
            call_user_func_array([$stmt, 'bind_param'], $bindArgs);
        }
        if (!$stmt->execute()) {
            $err = $stmt->error;
            $stmt->close();
            throw new RuntimeException("Error ejecutando consulta SQL: {$err}");
        }
        return $stmt;
    }
}
