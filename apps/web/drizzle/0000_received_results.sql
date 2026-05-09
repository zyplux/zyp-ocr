CREATE TABLE `md_pages` (
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`error` text,
	`markdown_key` text,
	`ocr_job_id` text NOT NULL,
	`page_number` integer NOT NULL,
	`started_at` integer,
	PRIMARY KEY(`ocr_job_id`, `page_number`),
	FOREIGN KEY (`ocr_job_id`) REFERENCES `ocr_jobs`(`id`) ON UPDATE no action ON DELETE no action
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
	`total_pages` integer NOT NULL,
	`upload_key` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `received_results` (
	`received_at` integer NOT NULL,
	`result_id` text PRIMARY KEY NOT NULL
);
