# 1. [Transcribing scanned pdfs into markdown](test_1_transcription_service.py)

## 1.1 reporting service health

### 1.1.1 healthz reports ok

## 1.2 accepting a transcription submission

### 1.2.1 submit acks with a pipeline id

### 1.2.2 an unwired pipeline delivers a failed page then a final done result

### 1.2.3 the recorded job status is readable by pipeline id

### 1.2.4 unknown pipeline ids are a 404

### 1.2.5 a submission whose result delivery blows up is marked failed

## 1.3 serving canned results in mock mode

### 1.3.1 mock submit delivers one done result per page then a final done

### 1.3.2 mock healthz reports ok

### 1.3.3 mock job status always reads processing

## 1.4 posting results to the callback

### 1.4.1 results are posted with the result token header

### 1.4.2 a rejected result post raises

## 1.5 launching from the command line

### 1.5.1 the default launch serves the real app factory

### 1.5.2 the mock flag serves the mock app factory
