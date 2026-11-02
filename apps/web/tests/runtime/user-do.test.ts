import { describe, expect, vi } from 'vitest';

import { it } from './fixtures';

const PDF_BYTES = 100;
const TWO_PAGES = 2;
const HTTP_FORBIDDEN = 403;
const SECOND_MS = 1000;
const HOUR_SECONDS = 3600;

describe('durable OCR state', () => {
  it('streams an initial snapshot accepted by the client contract', async ({ snapshot, stub }) => {
    await stub.reserveUpload({ ocrJobId: 'job-1', sizeBytes: PDF_BYTES, uploadKey: 'uploads/job-1' });
    expect(await snapshot()).toMatchObject({ ocr_jobs: [{ id: 'job-1', status: 'awaiting_upload' }] });
  });

  it('rejects reservations once the in-flight job limit is reached', async ({ maxInflight, reserveExcess, stub }) => {
    for (let index = 0; index < maxInflight; index += 1) {
      await stub.reserveUpload({ ocrJobId: `job-${index}`, sizeBytes: PDF_BYTES, uploadKey: `uploads/job-${index}` });
    }
    await expect(reserveExcess()).resolves.toBe(`too many in-flight jobs (max ${maxInflight})`);
  });

  it('submits a confirmed PDF and records the returned pipeline identifier', async ({ snapshot, startJob }) => {
    await startJob(TWO_PAGES);
    const current = await snapshot();
    expect(current.ocr_jobs[0]).toMatchObject({
      pipeline_id: 'pipe-1',
      status: 'transcribing',
      total_pages: TWO_PAGES,
    });
    expect(current.md_pages).toHaveLength(TWO_PAGES);
  });

  it('finishes only after every page arrives and ignores duplicate results', async ({ snapshot, startJob, stub }) => {
    await startJob(TWO_PAGES);
    const first = {
      markdownKey: 'pages/1.md',
      ocrJobId: 'job-1',
      pageNumber: 1,
      resultId: 'r1',
      status: 'done',
    } as const;
    await stub.onTranscriptionUpdate(first);
    await stub.onTranscriptionUpdate(first);
    expect(await snapshot()).toMatchObject({ ocr_jobs: [{ status: 'transcribing' }] });
    await stub.onTranscriptionUpdate({ ...first, markdownKey: 'pages/2.md', pageNumber: TWO_PAGES, resultId: 'r2' });
    expect(await snapshot()).toMatchObject({
      md_pages: [{ status: 'done' }, { status: 'done' }],
      ocr_jobs: [{ status: 'done' }],
    });
  });

  it('marks the complete job failed when any page fails', async ({ snapshot, startJob, stub }) => {
    await startJob();
    await stub.onTranscriptionUpdate({
      error: 'unreadable page',
      ocrJobId: 'job-1',
      pageNumber: 1,
      resultId: 'r1',
      status: 'failed',
    });
    expect(await snapshot()).toMatchObject({
      md_pages: [{ error: 'unreadable page' }],
      ocr_jobs: [{ error: 'one or more pages failed', status: 'failed' }],
    });
  });

  it('records a failed submission instead of leaving the job active', async ({ network, snapshot, stub }) => {
    network.reply(() => new Response('denied', { status: HTTP_FORBIDDEN }));
    await stub.reserveUpload({ ocrJobId: 'job-1', sizeBytes: PDF_BYTES, uploadKey: 'uploads/job-1' });
    await stub.confirmUpload({ ocrJobId: 'job-1', sizeBytes: PDF_BYTES, totalPages: 1 });
    await vi.waitFor(async () => {
      expect(await snapshot()).toMatchObject({
        ocr_jobs: [{ error: 'transcription submit: transcription /submit: 403 denied', status: 'failed' }],
      });
    });
  });

  it('records a rejected upload and tolerates unknown identifiers', async ({ snapshot, stub }) => {
    await stub.reserveUpload({ ocrJobId: 'job-1', sizeBytes: PDF_BYTES, uploadKey: 'uploads/job-1' });
    await stub.failUpload('job-1', 'invalid PDF');
    await stub.failUpload('missing', 'invalid PDF');
    await stub.onTranscriptionUpdate({ ocrJobId: 'missing', resultId: 'unknown', status: 'failed' });
    expect(await snapshot()).toMatchObject({ ocr_jobs: [{ error: 'invalid PDF', status: 'failed' }] });
  });

  it('closes expired upload reservations and deletes their abandoned objects', async ({
    network,
    runAlarm,
    snapshot,
    stub,
  }) => {
    await stub.reserveUpload({ ocrJobId: 'job-1', sizeBytes: PDF_BYTES, uploadKey: 'uploads/job-1' });
    network.reply(() => new Response(undefined, { status: HTTP_FORBIDDEN }));
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + (HOUR_SECONDS + 1) * SECOND_MS);
    expect(await runAlarm()).toBe(true);
    expect(await snapshot()).toMatchObject({ ocr_jobs: [{ error: 'upload abandoned', status: 'failed' }] });
  });

  it('reschedules checks for healthy active work and times out stale transcription', async ({
    runAlarm,
    snapshot,
    startJob,
  }) => {
    await startJob();
    expect(await runAlarm()).toBe(true);
    expect(await snapshot()).toMatchObject({ ocr_jobs: [{ status: 'transcribing' }] });
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + (HOUR_SECONDS + 1) * SECOND_MS);
    expect(await runAlarm()).toBe(true);
    expect(await snapshot()).toMatchObject({ ocr_jobs: [{ error: 'timeout', status: 'failed' }] });
  });

  it('signs result callbacks with the configured HMAC secret', async ({ environment, stub, verifyResultToken }) => {
    const claims = { ocrJobId: 'job-1', resultId: 'result-1', userId: 'default' };
    const token = await stub.signTokenFor(claims);
    await expect(verifyResultToken(token, [environment.RESULT_HMAC_SECRET])).resolves.toMatchObject(claims);
  });
});

it('accepts job-level completion and ignores repeated unsubscribe', async ({ snapshot, startJob, stub }) => {
  await startJob();
  await stub.onTranscriptionUpdate({ ocrJobId: 'job-1', resultId: 'whole-job', status: 'done' });
  await stub.unsubscribe('missing');
  await stub.setPipelineId('missing', 'pipe-missing');
  expect(await snapshot()).toMatchObject({ ocr_jobs: [{ status: 'done' }] });
});

it('delivers new job events to a connected state subscriber', async ({ stub }) => {
  const subscription = await stub.subscribe();
  const reader = subscription.stream.getReader();
  await reader.read();
  await stub.reserveUpload({ ocrJobId: 'live-job', sizeBytes: PDF_BYTES, uploadKey: 'uploads/live-job' });
  const event = await reader.read();
  expect(new TextDecoder().decode(event.value)).toContain('"op":"ocr-job-upsert"');
  await stub.unsubscribe(subscription.id);
  await reader.cancel();
});
