import { Link } from '@tanstack/react-router';
import { useStoreCurrency } from '../lib/use-store-currency';
import { availabilityLabel } from '../lib/availability';
import type { ProductAvailability } from '../schemas/availability';
import type { PublishedProductCard as ProductCardData } from '../server/catalog';
import { formatMoney } from '../lib/format';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { mediaUrl, mediaSrcSet } from '../lib/media-url';

export { formatMoney };

export function ProductCard({
  product,
  availability,
}: {
  product: ProductCardData;
  availability?: ProductAvailability | undefined;
}) {
  const currency = useStoreCurrency();
  return (
    <article className="group">
      <Link to="/products/$slug" params={{ slug: product.slug }} className="block">
        <div className="relative flex aspect-[4/5] items-center justify-center overflow-hidden rounded-xl bg-zinc-100">
          {product.imageKey ? (
            <img
              src={mediaUrl(
                {
                  key: product.imageKey,
                  publicUrl: product.imagePublicUrl,
                  variants: product.imageVariants,
                },
                640
              )}
              srcSet={mediaSrcSet({ key: product.imageKey, variants: product.imageVariants })}
              sizes="(max-width: 640px) 100vw, 33vw"
              alt={product.title}
              loading="lazy"
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
            />
          ) : (
            <span
              className="text-6xl leading-none font-light text-zinc-300 select-none transition-transform duration-500 group-hover:scale-105"
              aria-hidden
            >
              {product.title.slice(0, 1).toUpperCase()}
            </span>
          )}
          {availability?.status === 'sold_out' || availability?.status === 'unavailable' ? (
            <Badge variant="secondary" className="absolute top-3 left-3">
              Sold out
            </Badge>
          ) : null}
        </div>
        <div className="flex items-start justify-between gap-3 pt-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-medium text-zinc-950">{product.title}</h3>
            {availability ? (
              <p className="mt-0.5 text-[13px] text-zinc-500">{availabilityLabel(availability)}</p>
            ) : (
              <Skeleton className="mt-1 h-[13px] w-20" aria-hidden />
            )}
          </div>
          <p className="shrink-0 text-sm font-normal text-zinc-950 tabular-nums">
            {product.priceCents != null ? formatMoney(product.priceCents, currency) : ''}
          </p>
        </div>
      </Link>
    </article>
  );
}
