type MarkdownProps = { source: string };

export const Markdown = ({ source }: MarkdownProps) => <pre style={{ whiteSpace: 'pre-wrap' }}>{source}</pre>;
