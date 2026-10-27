import { useMemo, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import {
  AdminActionFeedback,
  type AdminActionFeedbackState,
} from '../../../components/AdminActionFeedback';
import { useAdminAction } from '../../../components/AdminNav';
import { previewProductsCsv } from '../../../lib/products-csv';
import {
  btnPrimary,
  btnSmall,
  cardCls,
  hintCls,
  labelCls,
  pageSub,
  pageTitle,
  textareaCls,
} from '../../../components/ui';

export const Route = createFileRoute('/admin/products/import')({
  component: AdminProductsImport,
});

type ImportSummary = { imported: number; errors: Array<{ row: number; error: string }> };

function AdminProductsImport() {
  const adminAction = useAdminAction();
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [feedback, setFeedback] = useState<AdminActionFeedbackState>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [submittedText, setSubmittedText] = useState<string | null>(null);
  const preview = useMemo(() => (text ? previewProductsCsv(text) : null), [text]);
  const alreadySubmitted = submittedText !== null && submittedText === text;

  return (
    <main>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className={pageTitle}>Import products</h1>
          <p className={pageSub}>
            Bring products in from a spreadsheet. Columns: title, slug, sku, price_cents, stock.
            Good rows import even when other rows fail, and every failure is listed by row.
          </p>
        </div>
        <Link
          to="/admin/products"
          search={{ q: '', mode: null, status: 'all', sort: 'newest' }}
          className={btnSmall}
        >
          Back to products
        </Link>
      </div>
      <AdminActionFeedback value={feedback} />

      <section className={`${cardCls} mt-5 space-y-4 p-5 sm:p-6`}>
        <div>
          <label className={labelCls} htmlFor="import-file">
            Choose a CSV file
          </label>
          <input
            id="import-file"
            type="file"
            accept=".csv,text/csv"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              setFileName(file.name);
              setSummary(null);
              setText(await file.text());
            }}
          />
          {fileName ? <p className={hintCls}>Selected file: {fileName}</p> : null}
        </div>

        <details>
          <summary className="cursor-pointer text-sm font-medium text-zinc-950">
            Paste CSV instead
          </summary>
          <textarea
            aria-label="Products CSV"
            className={`${textareaCls} mt-2 font-mono text-xs`}
            rows={6}
            value={text}
            onChange={(event) => {
              setFileName('');
              setSummary(null);
              setText(event.target.value);
            }}
            placeholder="title,slug,sku,price_cents,stock"
          />
        </details>

        {preview ? (
          <div>
            <h2 className="text-sm font-medium text-zinc-950">Preview</h2>
            <p className={hintCls}>
              {preview.totalRows} product row{preview.totalRows === 1 ? '' : 's'} found. Showing the
              first {preview.previewRows.length}.
            </p>
            {preview.problems.length > 0 ? (
              <div role="alert" className="mt-2 text-sm text-red-700">
                {preview.problems.map((problem) => (
                  <p key={problem}>{problem}</p>
                ))}
              </div>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="min-w-[560px] text-left text-sm">
                  <thead>
                    <tr className="text-xs text-zinc-500">
                      {preview.headers.map((header) => (
                        <th key={header} className="py-1 pr-3">
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.previewRows.map((row, index) => (
                      <tr key={index}>
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex} className="py-1 pr-3">
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={btnPrimary}
            disabled={busy || !preview || preview.problems.length > 0 || alreadySubmitted}
            onClick={async () => {
              setBusy(true);
              const result = await adminAction('import.productsCsv', { csv: text });
              setBusy(false);
              if (result.ok) {
                const data = result.data as ImportSummary;
                setSummary(data);
                setSubmittedText(text);
                setFeedback({
                  kind: 'status',
                  message: `Import finished. ${data.imported} imported, ${data.errors.length} failed.`,
                });
              } else {
                setFeedback({ kind: 'error', message: result.error ?? 'Import failed.' });
              }
            }}
          >
            {busy ? 'Importing...' : 'Import products'}
          </button>
          {alreadySubmitted ? (
            <p className={hintCls}>
              This exact file was already submitted. Choose or paste a changed file to import again,
              so a partial import is never retried blindly.
            </p>
          ) : null}
        </div>

        {summary ? (
          <div>
            <h2 className="text-sm font-medium text-zinc-950">Result</h2>
            <p className={hintCls}>
              {summary.imported} product{summary.imported === 1 ? '' : 's'} imported.{' '}
              {summary.errors.length} row{summary.errors.length === 1 ? '' : 's'} failed.
            </p>
            {summary.errors.length > 0 ? (
              <ul className="mt-2 space-y-1 text-sm text-red-700">
                {summary.errors.map((entry) => (
                  <li key={entry.row}>
                    Row {entry.row}: {entry.error}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}
