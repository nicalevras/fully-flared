import { Link } from '@tanstack/react-router';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function Block({
  title,
  body,
  to,
  label,
}: {
  title: string;
  body: string;
  to: string;
  label: string;
}) {
  return (
    <main className="mx-auto max-w-xl py-20 text-center">
      <h1 className="text-3xl font-medium tracking-tight text-zinc-950">{title}</h1>
      <p className="mt-3 text-zinc-500">{body}</p>
      <Link to={to} className={cn(buttonVariants({ size: 'lg' }), 'mt-6')}>
        {label}
      </Link>
    </main>
  );
}

export function ProductNotFound() {
  return (
    <Block
      title="Product not found"
      body="This product does not exist or is no longer available."
      to="/"
      label="Browse the catalogue"
    />
  );
}

export function PostNotFound() {
  return (
    <Block
      title="Article not found"
      body="This article does not exist or has not been published yet."
      to="/blog"
      label="All articles"
    />
  );
}

export function CollectionNotFound() {
  return (
    <Block
      title="Collection not found"
      body="This collection does not exist."
      to="/"
      label="Back to the store"
    />
  );
}

export function PageNotFound() {
  return (
    <Block
      title="Page not found"
      body="This page does not exist."
      to="/"
      label="Back to the store"
    />
  );
}
