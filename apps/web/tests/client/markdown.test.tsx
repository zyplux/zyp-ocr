import { describe, expect } from 'vitest';

// @vitest-environment jsdom
import { it } from './fixtures';

describe('Markdown', () => {
  it('renders the source text inside a preformatted block', ({ renderMarkdown }) => {
    const pre = renderMarkdown('# Heading\n\nbody text');
    expect(pre.tagName).toBe('PRE');
    expect(pre.textContent).toContain('body text');
  });

  it('preserves whitespace via wrap-friendly styling', ({ renderMarkdown }) => {
    const pre = renderMarkdown('line one\nline two');
    expect(pre).toHaveStyle({ whiteSpace: 'pre-wrap' });
  });
});
