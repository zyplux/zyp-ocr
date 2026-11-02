import { describe, expect } from 'vitest';

import { it } from './fixtures';

describe('estimatePageCount', () => {
  it('reads /Count from a /Type /Pages object', ({ estimatePageCount }) => {
    const declaredPageCount = 7;
    const pdf = `%PDF-1.4\n1 0 obj\n<< /Type /Pages /Kids [] /Count ${declaredPageCount} >>\nendobj\n`;
    const bytes = new TextEncoder().encode(pdf);
    expect(estimatePageCount(bytes)).toBe(declaredPageCount);
  });

  it('falls back to 1 when no /Pages object is found', ({ estimatePageCount }) => {
    const bytes = new TextEncoder().encode('not a pdf');
    expect(estimatePageCount(bytes)).toBe(1);
  });
});

it('uses one page when the page tree has no readable count', ({ estimatePageCount }) => {
  expect(estimatePageCount(new TextEncoder().encode('%PDF-1.4\n<< /Type /Pages >>'))).toBe(1);
});
