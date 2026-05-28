// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Markdown } from '~/client/markdown';

describe('Markdown', () => {
  it('renders the source text inside a preformatted block', () => {
    render(<Markdown source={'# Heading\n\nbody text'} />);
    const pre = screen.getByText(/Heading/);
    expect(pre.tagName).toBe('PRE');
    expect(pre.textContent).toContain('body text');
  });

  it('preserves whitespace via wrap-friendly styling', () => {
    render(<Markdown source={'line one\nline two'} />);
    const pre = screen.getByText(/line one/);
    expect(pre).toHaveStyle({ whiteSpace: 'pre-wrap' });
  });
});
