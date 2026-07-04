CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`custom_id` text,
	`content_hash` text,
	`user_id` text NOT NULL,
	`container_tag` text NOT NULL,
	`title` text,
	`content` text,
	`summary` text,
	`url` text,
	`source` text,
	`type` text DEFAULT 'text' NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`token_count` integer,
	`word_count` integer,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `doc_user_container_idx` ON `documents` (`user_id`,`container_tag`);--> statement-breakpoint
CREATE INDEX `doc_custom_id_idx` ON `documents` (`custom_id`);--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`memory` text NOT NULL,
	`user_id` text NOT NULL,
	`container_tag` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`is_latest` integer DEFAULT true NOT NULL,
	`parent_memory_id` text,
	`root_memory_id` text,
	`memory_relations` text DEFAULT '{}' NOT NULL,
	`source_count` integer DEFAULT 1 NOT NULL,
	`is_forgotten` integer DEFAULT false NOT NULL,
	`is_static` integer DEFAULT false NOT NULL,
	`forget_after` integer,
	`forget_reason` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mem_latest_search_idx` ON `memories` (`container_tag`,`is_latest`,`is_forgotten`);--> statement-breakpoint
CREATE INDEX `mem_parent_idx` ON `memories` (`parent_memory_id`);--> statement-breakpoint
CREATE INDEX `mem_root_idx` ON `memories` (`root_memory_id`);--> statement-breakpoint
CREATE TABLE `memory_document_sources` (
	`memory_entry_id` text NOT NULL,
	`document_id` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`memory_entry_id`, `document_id`),
	FOREIGN KEY (`memory_entry_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
