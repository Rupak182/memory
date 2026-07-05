DROP INDEX `mem_parent_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `mem_parent_unique_idx` ON `memories` (`parent_memory_id`);