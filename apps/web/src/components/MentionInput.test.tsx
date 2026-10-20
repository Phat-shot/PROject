import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MentionInput } from './MentionInput';

describe('MentionInput', () => {
  it('Chat (enterSends): Enter sendet, Umschalt+Enter nicht', () => {
    const onSubmit = vi.fn();
    render(<MentionInput value="Hallo" onChange={vi.fn()} members={[]} onSubmit={onSubmit} enterSends />);
    const box = screen.getByRole('textbox');
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('ohne enterSends sendet nur Strg+Enter', () => {
    const onSubmit = vi.fn();
    render(<MentionInput value="Kommentar" onChange={vi.fn()} members={[]} onSubmit={onSubmit} />);
    const box = screen.getByRole('textbox');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
