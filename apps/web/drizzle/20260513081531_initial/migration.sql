CREATE TABLE `md_pages` (
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`error` text,
	`markdown_key` text,
	`ocr_job_id` text NOT NULL,
	`page_number` integer NOT NULL,
	`started_at` integer,
	`status` text GENERATED ALWAYS AS (CASE
          WHEN "error" IS NOT NULL THEN 'failed'
          WHEN "completed_at" IS NOT NULL THEN 'done'
          ELSE 'transcribing'
        END) VIRTUAL NOT NULL,
	CONSTRAINT `md_pages_pk` PRIMARY KEY(`ocr_job_id`, `page_number`),
	CONSTRAINT `fk_md_pages_ocr_job_id_ocr_jobs_id_fk` FOREIGN KEY (`ocr_job_id`) REFERENCES `ocr_jobs`(`id`),
	CONSTRAINT "md_pages_page_number_positive" CHECK("page_number" > 0),
	CONSTRAINT "md_pages_created_at_positive" CHECK("created_at" > 0),
	CONSTRAINT "md_pages_started_at_after_created" CHECK("started_at" IS NULL OR "started_at" >= "created_at"),
	CONSTRAINT "md_pages_completed_at_after_created" CHECK("completed_at" IS NULL OR "completed_at" >= "created_at"),
	CONSTRAINT "md_pages_error_nonempty" CHECK("error" IS NULL OR length("error") > 0),
	CONSTRAINT "md_pages_markdown_requires_done" CHECK("markdown_key" IS NULL OR ("completed_at" IS NOT NULL AND "error" IS NULL))
);
--> statement-breakpoint
CREATE TABLE `ocr_jobs` (
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`error` text,
	`id` text PRIMARY KEY,
	`pipeline_id` text,
	`size_bytes` integer NOT NULL,
	`started_at` integer,
	`status` text GENERATED ALWAYS AS (CASE
          WHEN "error" IS NOT NULL THEN 'failed'
          WHEN "completed_at" IS NOT NULL THEN 'done'
          WHEN "started_at" IS NOT NULL THEN 'transcribing'
          WHEN "total_pages" > 0 THEN 'uploaded'
          ELSE 'awaiting_upload'
        END) VIRTUAL NOT NULL,
	`total_pages` integer NOT NULL,
	`upload_key` text NOT NULL,
	CONSTRAINT "ocr_jobs_size_bytes_nonneg" CHECK("size_bytes" >= 0),
	CONSTRAINT "ocr_jobs_total_pages_nonneg" CHECK("total_pages" >= 0),
	CONSTRAINT "ocr_jobs_created_at_positive" CHECK("created_at" > 0),
	CONSTRAINT "ocr_jobs_started_at_after_created" CHECK("started_at" IS NULL OR "started_at" >= "created_at"),
	CONSTRAINT "ocr_jobs_completed_at_after_created" CHECK("completed_at" IS NULL OR "completed_at" >= "created_at"),
	CONSTRAINT "ocr_jobs_clean_done_requires_started" CHECK("completed_at" IS NULL OR "started_at" IS NOT NULL OR "error" IS NOT NULL),
	CONSTRAINT "ocr_jobs_pipeline_id_pairs_with_started_at" CHECK(("pipeline_id" IS NULL) = ("started_at" IS NULL)),
	CONSTRAINT "ocr_jobs_started_requires_pages" CHECK("started_at" IS NULL OR "total_pages" > 0),
	CONSTRAINT "ocr_jobs_error_nonempty" CHECK("error" IS NULL OR length("error") > 0)
);
