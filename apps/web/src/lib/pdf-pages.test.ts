import { describe, expect, it } from 'vitest';
import { estimatePageCount } from './pdf-pages';

describe('estimatePageCount', () => {
  it('reads /Count from a /Type /Pages object', () => {
    const pdf = '%PDF-1.4\n1 0 obj\n<< /Type /Pages /Kids [] /Count 7 >>\nendobj\n';
    const bytes = new TextEncoder().encode(pdf);
    expect(estimatePageCount(bytes)).toBe(7);
  });

  it('falls back to 1 when no /Pages object is found', () => {
    const bytes = new TextEncoder().encode('not a pdf');
    expect(estimatePageCount(bytes)).toBe(1);
  });
});
