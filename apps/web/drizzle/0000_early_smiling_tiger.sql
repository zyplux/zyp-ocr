CREATE TABLE `callbacks_seen` (
	`callback_id` text PRIMARY KEY NOT NULL,
	`seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `md_pages` (
	`error` text,
	`markdown_key` text,
	`ocr_job_id` text NOT NULL,
	`page_number` integer NOT NULL,
	`status` text NOT NULL,
	PRIMARY KEY(`ocr_job_id`, `page_number`),
	FOREIGN KEY (`ocr_job_id`) REFERENCES `ocr_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "md_pages_status_enum" CHECK("md_pages"."status" IN ('pending','done','failed'))
);
--> statement-breakpoint
CREATE TABLE `ocr_jobs` (
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`error` text,
	`id` text PRIMARY KEY NOT NULL,
	`pipeline_id` text,
	`size_bytes` integer NOT NULL,
	`started_at` integer,
	`status` text NOT NULL,
	`total_pages` integer NOT NULL,
	`upload_key` text NOT NULL,
	CONSTRAINT "ocr_jobs_status_enum" CHECK("ocr_jobs"."status" IN ('pending','processing','done','failed')),
	CONSTRAINT "ocr_jobs_size_bytes_max" CHECK("ocr_jobs"."size_bytes" <= 52428800),
	CONSTRAINT "ocr_jobs_total_pages_max" CHECK("ocr_jobs"."total_pages" <= 100)
);
