CREATE TABLE `ARTICLE` (
    `id` BIGINT AUTO_INCREMENT COMMENT '기사 PK',
    `source` VARCHAR(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '출처',
    `source_pk` VARCHAR(150) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '출처의 PK',
    `title` VARCHAR(500) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '제목',
    `content` LONGTEXT COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '내용',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성일',
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP COMMENT '수정일',
    `is_edit` TINYINT(1) NULL COMMENT '컨텐츠가 파싱되었',
    `content_created_at` DATETIME NULL COMMENT '원본 컨텐츠 생성일',
    `reason` LONGTEXT COLLATE utf8mb4_unicode_ci NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_source_source_pk` (`source`, `source_pk`)
) ENGINE=InnoDB
DEFAULT CHARSET=utf8mb4
COLLATE=utf8mb4_unicode_ci
COMMENT='기사 정보';


CREATE TABLE `ARTICLE_WEEKLY` (
    `id` BIGINT AUTO_INCREMENT NOT NULL COMMENT '기사 PK',
    `week` VARCHAR(500) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '주차',
    `title` VARCHAR(500) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '제목',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '생성일',
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP COMMENT '수정일',
    `content` LONGTEXT COLLATE utf8mb4_unicode_ci NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_source_source_pk` (`week`)
) ENGINE=InnoDB
DEFAULT CHARSET=utf8mb4
COLLATE=utf8mb4_unicode_ci
COMMENT='주간 기사 요약';