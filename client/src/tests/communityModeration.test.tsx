import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReportDialog } from '../components/ReportDialog';

describe('community moderation UI', () => {
  it('offers only the fixed reason set and explains the accountable privacy boundary', () => {
    const markup = renderToStaticMarkup(createElement(ReportDialog, {
      vaultId: 'v1',
      targetType: 'message',
      targetId: 'm1',
      title: 'message from Alice',
      onClose: () => {},
    }));
    for (const reason of ['Spam', 'Harassment', 'Hate or abuse', 'Illegal content', 'Other']) {
      expect(markup).toContain(reason);
    }
    expect(markup).toContain('maxLength="500"');
    expect(markup).toContain('not a copy of the content');
    expect(markup).not.toContain('Reporter identity is public');
  });
});
