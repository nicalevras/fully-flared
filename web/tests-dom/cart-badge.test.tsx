// @vitest-environment happy-dom
import { act, screen } from '@testing-library/react';
import { createRootRoute } from '@tanstack/react-router';
import { afterEach, expect, it } from 'vitest';
import { signalCartCount } from '@/lib/cart-cookie';
import { StorefrontLayout } from '@/routes/__root';
import { layout } from './fixtures';
import { renderTree } from './render-route';

const badge = () => screen.getByRole('button', { name: 'Open cart' }).textContent;

async function renderLayout() {
  await renderTree(createRootRoute({ loader: () => layout, component: StorefrontLayout }));
  await screen.findByRole('button', { name: 'Open cart' });
}

afterEach(() => {
  document.cookie = 'cart_count=; max-age=0';
});

it('updates on cross-tab change', async () => {
  document.cookie = 'cart_count=3';
  await renderLayout();
  expect(badge()).toBe('3');

  document.cookie = 'cart_count=5';
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key: 'cart-count', newValue: '5' }));
  });
  expect(badge()).toBe('5');
});

it('updates on a cart change in this tab and ignores events without a count', async () => {
  await renderLayout();
  expect(badge()).toBe('');

  act(() => {
    window.dispatchEvent(new CustomEvent('cart-changed', { detail: { count: 2 } }));
  });
  expect(badge()).toBe('2');

  act(() => {
    window.dispatchEvent(new CustomEvent('cart-changed', { detail: { count: 'x' } }));
    window.dispatchEvent(new Event('cart-changed'));
  });
  expect(badge()).toBe('2');
});

it('a cart change here writes the signal other tabs listen for', () => {
  signalCartCount(4);
  expect(localStorage.getItem('cart-count')).toBe('4');
});
