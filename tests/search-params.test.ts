import { describe, expect, it } from 'vitest';
import {
  MAX_PAGE,
  accountSearch,
  catalogSearch,
  isPageSize,
  orderPagesSearch,
  pageSearch,
  resetSearch,
  storefrontPageSearch,
  successSearch,
} from '../web/src/lib/search-params';

describe('route search parsers', () => {
  it('admin pages accept only whole numbers in range and fall back to 1', () => {
    expect(pageSearch({ page: 3 })).toEqual({ page: 3 });
    expect(pageSearch({ page: MAX_PAGE })).toEqual({ page: MAX_PAGE });
    for (const page of [undefined, '3', 0, -1, 2.5, MAX_PAGE + 1, null, true])
      expect(pageSearch({ page })).toEqual({ page: 1 });
    expect(orderPagesSearch({ page: 2, returnsPage: 'x' })).toEqual({ page: 2, returnsPage: 1 });
  });

  it('storefront and account pages coerce numeric text within their bounds', () => {
    expect(storefrontPageSearch({ page: '7' })).toEqual({ page: 7 });
    expect(storefrontPageSearch({ page: ' 3 ' })).toEqual({ page: 3 });
    expect(storefrontPageSearch({ page: 100_000 })).toEqual({ page: 100_000 });
    for (const page of [undefined, '', 'abc', '2.5', 0, 100_001, {}])
      expect(storefrontPageSearch({ page })).toEqual({ page: 1 });
    expect(accountSearch({ page: '100001' })).toEqual({ page: 100_001 });
    expect(accountSearch({ page: MAX_PAGE + 1 })).toEqual({ page: 1 });
  });

  it('text params keep strings within their length and drop anything else', () => {
    expect(catalogSearch({})).toEqual({ q: '', cursor: undefined, page: 1 });
    expect(catalogSearch({ q: 'tee', cursor: 'c1', page: '3' })).toEqual({
      q: 'tee',
      cursor: 'c1',
      page: 3,
    });
    expect(catalogSearch({ q: 'tee', cursor: 'c1' })).toEqual({ q: 'tee', cursor: 'c1', page: 2 });
    expect(catalogSearch({ q: 'tee', page: 4 })).toEqual({ q: 'tee', cursor: undefined, page: 1 });
    expect(catalogSearch({ q: 'x'.repeat(201), cursor: 'x'.repeat(501) })).toEqual({
      q: '',
      cursor: undefined,
      page: 1,
    });
    expect(catalogSearch({ q: 5 })).toEqual({ q: '', cursor: undefined, page: 1 });
    expect(successSearch({})).toEqual({ order: '', t: '' });
    expect(successSearch({ order: 'ord_1', t: 'abc' })).toEqual({ order: 'ord_1', t: 'abc' });
    expect(successSearch({ order: 'x'.repeat(101), t: 'x'.repeat(201) })).toEqual({
      order: '',
      t: '',
    });
    expect(resetSearch({ token: 'tok' })).toEqual({ token: 'tok', error: undefined });
    expect(resetSearch({ token: 123 })).toEqual({ token: undefined, error: undefined });
  });

  it('page sizes accept only the offered row counts', () => {
    for (const size of [10, 20, 25, 50, 100]) expect(isPageSize(size)).toBe(true);
    for (const size of [undefined, '25', 0, 30, 25.5, 200]) expect(isPageSize(size)).toBe(false);
  });
});
