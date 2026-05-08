CREATE TABLE `callbacks_seen` (
	`callback_id` text PRIMARY KEY NOT NULL,
	`seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_pages` (
	`error` text,
	`job_id` text NOT NULL,
	`markdown_key` text,
	`page_number` integer NOT NULL,
	`status` text NOT NULL,
	PRIMARY KEY(`job_id`, `page_number`),
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "job_pages_status_enum" CHECK("job_pages"."status" IN ('pending','done','failed'))
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`error` text,
	`id` text PRIMARY KEY NOT NULL,
	`pipeline_id` text,
	`size_bytes` integer NOT NULL,
	`source_key` text NOT NULL,
	`started_at` integer,
	`status` text NOT NULL,
	`total_pages` integer NOT NULL,
	CONSTRAINT "jobs_status_enum" CHECK("jobs"."status" IN ('pending','processing','done','failed')),
	CONSTRAINT "jobs_size_bytes_max" CHECK("jobs"."size_bytes" <= 52428800),
	CONSTRAINT "jobs_total_pages_max" CHECK("jobs"."total_pages" <= 100)
);
