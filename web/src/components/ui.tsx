import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

// shadcn-style primitives: plain Tailwind utilities, no custom CSS classes.

export const btnPrimary =
  'inline-flex h-10 items-center justify-center gap-2 rounded-full bg-zinc-950 px-5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:pointer-events-none disabled:opacity-40';
export const btnSecondary =
  'inline-flex h-10 items-center justify-center gap-2 rounded-full border border-zinc-300 bg-white px-5 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-50 disabled:pointer-events-none disabled:opacity-40';
export const btnSmall =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-full border border-zinc-300 bg-white px-3 text-[13px] font-medium text-zinc-900 transition-colors hover:bg-zinc-50 disabled:pointer-events-none disabled:opacity-40';
export const btnGhost =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-950 disabled:pointer-events-none disabled:opacity-40';
export const btnDestructive =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-red-600 transition-colors hover:bg-red-50 disabled:pointer-events-none disabled:opacity-40';

export const inputCls =
  'h-10 w-full rounded-lg border border-zinc-200 bg-white px-3 text-base text-zinc-950 placeholder:text-zinc-400 transition-colors sm:text-sm';
export const textareaCls =
  'w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-base text-zinc-950 placeholder:text-zinc-400 transition-colors sm:text-sm';
export const labelCls = 'mb-1.5 block text-sm font-medium text-zinc-900';
export const hintCls = 'mt-1.5 text-[13px] text-zinc-500';

export const cardCls =
  'rounded-xl border border-zinc-200 bg-white shadow-[0_1px_2px_rgb(0_0_0/0.04)]';
export const pageTitle = 'text-[22px] font-normal tracking-tight text-zinc-950';
export const pageSub = 'mt-1 text-sm text-zinc-500';

export function Button(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'primary' | 'secondary' | 'small' | 'ghost' | 'destructive';
  }
) {
  const { variant = 'primary', className = '', ...rest } = props;
  const cls =
    variant === 'primary'
      ? btnPrimary
      : variant === 'secondary'
        ? btnSecondary
        : variant === 'small'
          ? btnSmall
          : variant === 'ghost'
            ? btnGhost
            : btnDestructive;
  return <button className={`${cls} ${className}`} {...rest} />;
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props;
  return <input className={`${inputCls} ${className}`} {...rest} />;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`${cardCls} ${className}`}>{children}</div>;
}

export function Badge({
  tone = 'gray',
  children,
}: {
  tone?: 'green' | 'gray' | 'yellow' | 'red';
  children: ReactNode;
}) {
  const tones = {
    green: 'bg-green-50 text-green-700 ring-green-600/20',
    gray: 'bg-zinc-100 text-zinc-600 ring-zinc-500/20',
    yellow: 'bg-yellow-50 text-yellow-800 ring-yellow-600/20',
    red: 'bg-red-50 text-red-700 ring-red-600/20',
  } as const;
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

// Typography for rendered blog/page HTML lives in lib/rich-text.
