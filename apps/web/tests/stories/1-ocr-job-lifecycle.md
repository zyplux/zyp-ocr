# 1. [Turning an uploaded scan into markdown pages](1-ocr-job-lifecycle.test.ts)

## 1.1 reserving and uploading a scan

### 1.1.1 a fresh reservation starts awaiting upload

### 1.1.2 confirming the upload seeds one md page per pdf page

## 1.2 tracking transcription progress

### 1.2.1 handing the job to the pipeline marks it transcribing

### 1.2.2 a delivered page becomes done with its markdown key

### 1.2.3 the job completes once every page is delivered

## 1.3 guarding the result callback

### 1.3.1 a signed result token round trips

### 1.3.2 a tampered result token is rejected

### 1.3.3 an expired result token is rejected

## 1.4 estimating pdf page counts

### 1.4.1 the page count comes from the pages object

### 1.4.2 an unparseable pdf falls back to a single page
