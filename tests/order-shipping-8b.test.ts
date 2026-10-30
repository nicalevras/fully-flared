import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { refundStatusLabel } from '../web/src/lib/order-actions';

describe('Phase 8B refund settlement wording', () => {
  it('separates settled refunds from submitted ones', () => {
    expect(refundStatusLabel('succeeded')).toBe('Settled');
    expect(refundStatusLabel('pending')).toBe('Submitted, not settled yet');
    expect(refundStatusLabel('requires_action')).toBe('Submitted, not settled yet');
    expect(refundStatusLabel('uncertain')).toBe('Submitted, awaiting confirmation');
    expect(refundStatusLabel('failed')).toBe('Failed');
    expect(refundStatusLabel('canceled')).toBe('Canceled');
  });

  it('uses the accessible confirmation dialog in the order workspace', () => {
    const source = readFileSync('web/src/routes/admin/orders/$id.tsx', 'utf8');
    expect(source).not.toContain('window.confirm');
    expect(source).toContain('ConfirmDialog');
    const dialog = readFileSync('web/src/components/ConfirmDialog.tsx', 'utf8');
    expect(dialog).toContain("from '@base-ui/react/alert-dialog'");
    expect(dialog).toContain('<AlertDialog.Portal>');
    expect(dialog).toContain('<AlertDialog.Popup');
    expect(dialog).toContain('initialFocus={cancelRef}');
  });
});
