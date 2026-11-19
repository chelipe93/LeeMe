-- Esquema relacional MySQL 8+ para BiblioML
-- Codificación UTF-8 completa (utf8mb4) para español, tildes y caracteres especiales

CREATE DATABASE IF NOT EXISTS `biblioml`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `biblioml`;

CREATE TABLE IF NOT EXISTS `books` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `title` VARCHAR(255) NOT NULL,
  `author` VARCHAR(255) NOT NULL DEFAULT 'Autor desconocido',
  `language` VARCHAR(32) NOT NULL DEFAULT 'es',
  `publisher` VARCHAR(255) NULL,
  `description` TEXT NULL,
  `cover_path` VARCHAR(512) NULL,
  `epub_filename` VARCHAR(255) NOT NULL,
  `epub_path` VARCHAR(512) NOT NULL,
  `pdf_filename` VARCHAR(255) NULL,
  `pdf_path` VARCHAR(512) NULL,
  `total_chapters` INT UNSIGNED NOT NULL DEFAULT 0,
  `total_words` INT UNSIGNED NOT NULL DEFAULT 0,
  `total_notes` INT UNSIGNED NOT NULL DEFAULT 0,
  `total_highlights` INT UNSIGNED NOT NULL DEFAULT 0,
  `total_characters` INT UNSIGNED NOT NULL DEFAULT 0,
  `global_summary` LONGTEXT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_books_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `chapters` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `book_id` INT UNSIGNED NOT NULL,
  `chapter_index` INT UNSIGNED NOT NULL,
  `part_title` VARCHAR(255) NULL,
  `title` VARCHAR(255) NOT NULL,
  `display_title` VARCHAR(255) NOT NULL,
  `href` VARCHAR(255) NOT NULL,
  `is_front_matter` TINYINT(1) NOT NULL DEFAULT 0,
  `word_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `html_content` LONGTEXT NOT NULL,
  `plain_text` LONGTEXT NOT NULL,
  `summary_text` TEXT NULL,
  `summary_json` LONGTEXT NULL,
  `keywords_json` LONGTEXT NULL,
  `mindmap_json` LONGTEXT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_chapters_book` (`book_id`, `chapter_index`),
  CONSTRAINT `fk_chapters_book` FOREIGN KEY (`book_id`) REFERENCES `books` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `kindle_notes` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `book_id` INT UNSIGNED NOT NULL,
  `chapter_id` INT UNSIGNED NULL,
  `pdf_chapter_label` VARCHAR(255) NULL,
  `page_number` INT UNSIGNED NULL,
  `note_type` ENUM('highlight', 'note', 'bookmark') NOT NULL DEFAULT 'highlight',
  `highlight_color` VARCHAR(32) NULL,
  `highlight_text` TEXT NULL,
  `user_note` TEXT NULL,
  `note_date` VARCHAR(64) NULL,
  `match_confidence` DECIMAL(5,4) NOT NULL DEFAULT 0.0000,
  `sort_order` INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  INDEX `idx_notes_book` (`book_id`, `sort_order`),
  INDEX `idx_notes_chapter` (`chapter_id`),
  CONSTRAINT `fk_notes_book` FOREIGN KEY (`book_id`) REFERENCES `books` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_notes_chapter` FOREIGN KEY (`chapter_id`) REFERENCES `chapters` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `characters` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `book_id` INT UNSIGNED NOT NULL,
  `canonical_name` VARCHAR(160) NOT NULL,
  `aliases_json` TEXT NULL,
  `mention_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `chapter_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `pagerank` DECIMAL(8,6) NOT NULL DEFAULT 0.000000,
  `degree_centrality` DECIMAL(8,6) NOT NULL DEFAULT 0.000000,
  `community_id` INT UNSIGNED NOT NULL DEFAULT 0,
  `first_chapter_id` INT UNSIGNED NULL,
  `chapters_json` TEXT NULL,
  `traits_json` TEXT NULL,
  `sample_mentions_json` LONGTEXT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_characters_book` (`book_id`, `mention_count`),
  CONSTRAINT `fk_characters_book` FOREIGN KEY (`book_id`) REFERENCES `books` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_characters_first_ch` FOREIGN KEY (`first_chapter_id`) REFERENCES `chapters` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `character_relations` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `book_id` INT UNSIGNED NOT NULL,
  `source_character_id` INT UNSIGNED NOT NULL,
  `target_character_id` INT UNSIGNED NOT NULL,
  `weight` DECIMAL(10,4) NOT NULL DEFAULT 0.0000,
  `cooccurrence_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `pmi_score` DECIMAL(10,4) NOT NULL DEFAULT 0.0000,
  `sentiment_score` DECIMAL(6,4) NOT NULL DEFAULT 0.0000,
  `relation_tone` VARCHAR(32) NOT NULL DEFAULT 'neutral',
  `context_words_json` TEXT NULL,
  `shared_chapters_json` TEXT NULL,
  `evidence_json` LONGTEXT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_rel_book` (`book_id`, `weight`),
  CONSTRAINT `fk_rel_book` FOREIGN KEY (`book_id`) REFERENCES `books` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_rel_source` FOREIGN KEY (`source_character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_rel_target` FOREIGN KEY (`target_character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `book_analysis` (
  `book_id` INT UNSIGNED NOT NULL,
  `global_mindmap_json` LONGTEXT NOT NULL,
  `cluster_mindmap_json` LONGTEXT NOT NULL,
  `global_keywords_json` LONGTEXT NOT NULL,
  `clusters_json` LONGTEXT NOT NULL,
  `stats_json` LONGTEXT NOT NULL,
  `analyzed_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`book_id`),
  CONSTRAINT `fk_analysis_book` FOREIGN KEY (`book_id`) REFERENCES `books` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `reading_progress` (
  `book_id` INT UNSIGNED NOT NULL,
  `current_chapter_id` INT UNSIGNED NULL,
  `scroll_percent` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  `reader_theme` VARCHAR(16) NOT NULL DEFAULT 'paper',
  `font_size` TINYINT UNSIGNED NOT NULL DEFAULT 18,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`book_id`),
  CONSTRAINT `fk_progress_book` FOREIGN KEY (`book_id`) REFERENCES `books` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_progress_chapter` FOREIGN KEY (`current_chapter_id`) REFERENCES `chapters` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
